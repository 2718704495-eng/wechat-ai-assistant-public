import AppKit
import CoreGraphics
import Foundation

struct PasteboardSnapshot: Equatable {
    let items: [[String: Data]]
}

struct ComposerMutationReceipt: Codable, Equatable {
    let text: String
    let cleared: Bool
}

struct ImageAttachmentReceipt: Codable, Equatable {
    let imageSha256: String
    let width: Int
    let height: Int
    let attachmentCount: Int
    let textEmpty: Bool
}

struct ImageAttachmentExpectation: Equatable {
    let receipt: ImageAttachmentReceipt
    let pixelSha256: String
}

struct ImageAttachmentObservation: Equatable {
    let pixelSha256: String
    let width: Int
    let height: Int
    let attachmentCount: Int
    let textEmpty: Bool
    let hasUnknownRepresentations: Bool
}

struct ImageAttachmentQuarantineRecoveryReceipt: Codable, Equatable {
    let status: String
    let archiveName: String
    let composerEmpty: Bool
}

enum ImageAttachmentCleanupAuthorization {
    static func permitsUndo(
        _ observation: ImageAttachmentObservation,
        expectedPixelSha256: String
    ) -> Bool {
        observation.pixelSha256 == expectedPixelSha256
            && observation.width == 1080
            && observation.height == 1350
            && observation.attachmentCount == 1
            && observation.textEmpty
            && !observation.hasUnknownRepresentations
    }
}

protocol ComposerImageAttachmentPort: AnyObject {
    func snapshotPasteboard() throws -> PasteboardSnapshot
    func restorePasteboard(_ snapshot: PasteboardSnapshot) throws
    func assertComposerEmptyBaseline() throws
    func pasteReviewedImage(_ expected: ImageAttachmentExpectation) throws
    func readPreparedImage() throws -> ImageAttachmentObservation
    func collapseSelection() throws
    func clearPreparedImage(expectedPixelSha256: String) throws
}

enum ImageAttachmentClipboardTransaction {
    static func prepare(
        _ expected: ImageAttachmentExpectation,
        using port: ComposerImageAttachmentPort
    ) throws -> ImageAttachmentReceipt {
        let snapshot = try port.snapshotPasteboard()
        var result: ImageAttachmentReceipt?
        var operationError: Error?
        var clearError: Error?
        var pasted = false
        do {
            guard expected.receipt.imageSha256.range(
                of: "^[a-f0-9]{64}$",
                options: .regularExpression
            ) != nil,
            expected.pixelSha256.range(
                of: "^[a-f0-9]{64}$",
                options: .regularExpression
            ) != nil,
            expected.receipt.width == 1080,
            expected.receipt.height == 1350,
            expected.receipt.attachmentCount == 1,
            expected.receipt.textEmpty else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_INVALID")
            }
            try port.assertComposerEmptyBaseline()
            try port.pasteReviewedImage(expected)
            pasted = true
            let observed = try port.readPreparedImage()
            guard observed.pixelSha256 == expected.pixelSha256,
                  observed.width == expected.receipt.width,
                  observed.height == expected.receipt.height,
                  observed.attachmentCount == 1,
                  observed.textEmpty,
                  !observed.hasUnknownRepresentations else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_NOT_VERIFIED")
            }
            try port.collapseSelection()
            result = expected.receipt
        } catch {
            operationError = error
            if pasted {
                do {
                    try port.clearPreparedImage(expectedPixelSha256: expected.pixelSha256)
                } catch {
                    clearError = BridgeError("WECHAT_IMAGE_ATTACHMENT_CLEAR_FAILED")
                }
            }
        }
        do {
            try port.restorePasteboard(snapshot)
        } catch {
            throw BridgeError("PASTEBOARD_RESTORE_FAILED")
        }
        if let clearError { throw clearError }
        if let operationError { throw operationError }
        guard let result else { throw BridgeError("WECHAT_IMAGE_ATTACHMENT_NOT_VERIFIED") }
        return result
    }
}

enum ImageAttachmentQuarantineRecovery {
    static func recover(
        using port: ComposerImageAttachmentPort,
        consumptionStore: FileImageAttachmentCapabilityConsumptionStore,
        reassertTarget: () throws -> Void = {}
    ) throws -> ImageAttachmentQuarantineRecoveryReceipt {
        let snapshot = try port.snapshotPasteboard()
        var operationError: Error?
        do {
            try port.assertComposerEmptyBaseline()
        } catch {
            operationError = error
        }
        do {
            try port.restorePasteboard(snapshot)
        } catch {
            throw BridgeError("PASTEBOARD_RESTORE_FAILED")
        }
        if let operationError { throw operationError }
        try reassertTarget()
        return try consumptionStore.archiveDirtyMarker()
    }
}

protocol ComposerClipboardPort: AnyObject {
    func snapshotPasteboard() throws -> PasteboardSnapshot
    func restorePasteboard(_ snapshot: PasteboardSnapshot) throws
    func selectAllAndCopy() throws -> String?
    func selectAllAndCut() throws -> String?
    func paste(_ text: String) throws
    func isVisuallyEmpty() throws -> Bool
    func collapseSelection() throws
}

enum WechatSubmitShortcut: Equatable {
    case returnKey
    case commandReturn
}

protocol WechatSubmitShortcutPort: AnyObject {
    func press(_ shortcut: WechatSubmitShortcut) throws
    func readComposer() throws -> String
    func restoreComposer(_ text: String) throws
}

enum WechatSubmitShortcutTransaction {
    static func submit(_ expectedDraft: String, using port: WechatSubmitShortcutPort) throws {
        let expected = canonical(expectedDraft)
        for shortcut in [WechatSubmitShortcut.returnKey, .commandReturn] {
            try port.press(shortcut)
            let observed = canonical(try port.readComposer())
            if observed.isEmpty {
                return
            }
            guard isOnlyInsertedNewlines(observed, after: expected) else {
                throw BridgeError("WECHAT_SUBMIT_COMPOSER_CHANGED")
            }
            try port.restoreComposer(expectedDraft)
        }
        throw BridgeError("WECHAT_SUBMIT_SHORTCUT_UNVERIFIED")
    }

    private static func isOnlyInsertedNewlines(_ observed: String, after expected: String) -> Bool {
        guard observed.hasPrefix(expected) else { return false }
        let suffix = observed.dropFirst(expected.count)
        return !suffix.isEmpty && suffix.allSatisfy { $0 == "\n" }
    }

    private static func canonical(_ value: String) -> String {
        value.precomposedStringWithCanonicalMapping
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }
}

enum ComposerClipboardTransaction {
    private static let maximumClearAttempts = 2
    private static let observedWechatEmptyEditorSentinel = String(repeating: " ", count: 28)

    static func replace(
        _ text: String,
        using port: ComposerClipboardPort
    ) throws -> ComposerMutationReceipt {
        try withRestoredPasteboard(port) {
            let existing = try readCurrent(using: port)
            guard existing.isEmpty else {
                throw BridgeError("WECHAT_COMPOSER_NOT_EMPTY")
            }

            try port.paste(text)
            let expected = canonical(text)
            let observed = try readCurrent(using: port)
            guard observed == expected else {
                try clearBody(using: port)
                throw BridgeError("DRAFT_WRITE_NOT_VERIFIED")
            }
            return ComposerMutationReceipt(text: observed, cleared: false)
        }
    }

    static func clear(
        using port: ComposerClipboardPort
    ) throws -> ComposerMutationReceipt {
        try withRestoredPasteboard(port) {
            try clearBody(using: port)
            return ComposerMutationReceipt(text: "", cleared: true)
        }
    }

    static func read(using port: ComposerClipboardPort) throws -> String {
        try withRestoredPasteboard(port) {
            try readCurrent(using: port)
        }
    }

    private static func readCurrent(using port: ComposerClipboardPort) throws -> String {
        let copied = canonical(try port.selectAllAndCopy() ?? "")
        if !copied.isEmpty {
            if copied == observedWechatEmptyEditorSentinel,
               try port.isVisuallyEmpty() {
                return ""
            }
            try port.collapseSelection()
            return copied
        }
        guard try port.isVisuallyEmpty() else {
            throw BridgeError("FOCUSED_TEXT_UNAVAILABLE")
        }
        return ""
    }

    private static func clearBody(using port: ComposerClipboardPort) throws {
        for _ in 0..<maximumClearAttempts {
            _ = try port.selectAllAndCut()
            guard try port.isVisuallyEmpty() else { continue }
            let residue = canonical(try port.selectAllAndCopy() ?? "")
            if residue.isEmpty || residue == observedWechatEmptyEditorSentinel {
                return
            }
            try port.collapseSelection()
        }
        throw BridgeError("DRAFT_CLEAR_NOT_VERIFIED")
    }

    private static func withRestoredPasteboard<T>(
        _ port: ComposerClipboardPort,
        operation: () throws -> T
    ) throws -> T {
        let snapshot = try port.snapshotPasteboard()
        do {
            let value = try operation()
            do {
                try port.restorePasteboard(snapshot)
            } catch {
                throw BridgeError("PASTEBOARD_RESTORE_FAILED")
            }
            return value
        } catch {
            let original = error
            do {
                try port.restorePasteboard(snapshot)
            } catch {
                throw BridgeError("PASTEBOARD_RESTORE_FAILED")
            }
            throw original
        }
    }

    private static func canonical(_ value: String) -> String {
        value.precomposedStringWithCanonicalMapping
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }
}

enum ComposerVisualGuard {
    static func isProvenEmpty(lines: [OCRLine]) -> Bool {
        let composerLines = lines.filter { line in
            line.bounds.x >= 0.38 && line.bounds.y <= 0.37 && !isInputMethodIndicator(line)
        }
        guard composerLines.allSatisfy({ $0.confidence >= 0.5 }) else {
            return false
        }
        return !composerLines.contains { line in
            line.text.contains { character in
                !character.isWhitespace && character != "|" && character != "｜"
            }
        }
    }

    private static func isInputMethodIndicator(_ line: OCRLine) -> Bool {
        let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let compactInputModeLabel = ["拼", "英", "中"].contains(text)
            && line.bounds.x >= 0.38
            && line.bounds.x < 0.42
            && line.bounds.y >= 0.28
            && line.bounds.y <= 0.36
            && line.bounds.width <= 0.05
            && line.bounds.height <= 0.04
        let rightActionToolbarArtifact = line.confidence < 0.5
            && line.bounds.x >= 0.88
            && line.bounds.y >= 0.32
            && line.bounds.y <= 0.37
            && line.bounds.width <= 0.10
            && line.bounds.height <= 0.05
            && (1...2).contains(text.count)
        return compactInputModeLabel || rightActionToolbarArtifact
    }
}

final class SystemWechatSubmitShortcutPort: WechatSubmitShortcutPort {
    private let composerPort: ComposerClipboardPort

    init(composerPort: ComposerClipboardPort) {
        self.composerPort = composerPort
    }

    func press(_ shortcut: WechatSubmitShortcut) throws {
        guard let source = CGEventSource(stateID: .privateState),
              let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: false) else {
            throw BridgeError("KEY_EVENT_CREATION_FAILED")
        }
        let flags: CGEventFlags = shortcut == .commandReturn ? .maskCommand : []
        keyDown.flags = flags
        keyUp.flags = flags
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.4)
    }

    func readComposer() throws -> String {
        try ComposerClipboardTransaction.read(using: composerPort)
    }

    func restoreComposer(_ text: String) throws {
        _ = try ComposerClipboardTransaction.clear(using: composerPort)
        _ = try ComposerClipboardTransaction.replace(text, using: composerPort)
    }
}

final class SystemComposerClipboardPort: ComposerClipboardPort {
    private let windowID: UInt32
    private let pasteboard: NSPasteboard

    init(windowID: UInt32, pasteboard: NSPasteboard = .general) {
        self.windowID = windowID
        self.pasteboard = pasteboard
    }

    func snapshotPasteboard() throws -> PasteboardSnapshot {
        let items = pasteboard.pasteboardItems?.map { item in
            Dictionary(uniqueKeysWithValues: item.types.compactMap { type in
                item.data(forType: type).map { (type.rawValue, $0) }
            })
        } ?? []
        return PasteboardSnapshot(items: items)
    }

    func restorePasteboard(_ snapshot: PasteboardSnapshot) throws {
        pasteboard.clearContents()
        guard !snapshot.items.isEmpty else { return }
        let restored = snapshot.items.map { representations -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (rawType, data) in representations {
                item.setData(data, forType: NSPasteboard.PasteboardType(rawType))
            }
            return item
        }
        guard pasteboard.writeObjects(restored) else {
            throw BridgeError("PASTEBOARD_RESTORE_FAILED")
        }
    }

    func selectAllAndCopy() throws -> String? {
        try readSelection(shortcut: 8)
    }

    func selectAllAndCut() throws -> String? {
        try readSelection(shortcut: 7)
    }

    func paste(_ text: String) throws {
        pasteboard.clearContents()
        guard pasteboard.setString(text, forType: .string) else {
            throw BridgeError("PASTEBOARD_WRITE_FAILED")
        }
        try postShortcut(virtualKey: 9)
        Thread.sleep(forTimeInterval: 0.25)
    }

    func isVisuallyEmpty() throws -> Bool {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("wechat-composer-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: url) }
        try WindowAccess.capture(windowID: windowID, outputURL: url)
        return ComposerVisualGuard.isProvenEmpty(lines: try VisionOCR.recognize(fileURL: url))
    }

    func collapseSelection() throws {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: 124, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 124, keyDown: false) else {
            throw BridgeError("TEXT_INPUT_EVENT_CREATION_FAILED")
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.03)
    }

    private func readSelection(shortcut: CGKeyCode) throws -> String? {
        let marker = "__CHAT_ASSISTANT_PROBE_\(UUID().uuidString)__"
        pasteboard.clearContents()
        guard pasteboard.setString(marker, forType: .string) else {
            throw BridgeError("PASTEBOARD_WRITE_FAILED")
        }
        let baseline = pasteboard.changeCount
        try postShortcut(virtualKey: 0)
        Thread.sleep(forTimeInterval: 0.06)
        try postShortcut(virtualKey: shortcut)
        let deadline = ProcessInfo.processInfo.systemUptime + 0.75
        while pasteboard.changeCount == baseline && ProcessInfo.processInfo.systemUptime < deadline {
            Thread.sleep(forTimeInterval: 0.01)
        }
        guard pasteboard.changeCount != baseline else { return nil }
        guard let value = pasteboard.string(forType: .string), value != marker else {
            throw BridgeError("FOCUSED_TEXT_UNAVAILABLE")
        }
        return value
    }

    private func postShortcut(virtualKey: CGKeyCode) throws {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: false) else {
            throw BridgeError("TEXT_INPUT_EVENT_CREATION_FAILED")
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

final class SystemComposerImageAttachmentPort: ComposerImageAttachmentPort {
    private let reviewedImage: ReviewedImage?
    private let pasteboard: NSPasteboard
    private let textPort: SystemComposerClipboardPort

    init(
        windowID: UInt32,
        reviewedImage: ReviewedImage? = nil,
        pasteboard: NSPasteboard = .general
    ) {
        self.reviewedImage = reviewedImage
        self.pasteboard = pasteboard
        textPort = SystemComposerClipboardPort(windowID: windowID, pasteboard: pasteboard)
    }

    func snapshotPasteboard() throws -> PasteboardSnapshot {
        try exactPasteboardSnapshot(errorCode: "PASTEBOARD_SNAPSHOT_FAILED")
    }

    func restorePasteboard(_ snapshot: PasteboardSnapshot) throws {
        pasteboard.clearContents()
        if !snapshot.items.isEmpty {
            let restored = snapshot.items.map { representations -> NSPasteboardItem in
                let item = NSPasteboardItem()
                for (rawType, data) in representations {
                    item.setData(data, forType: NSPasteboard.PasteboardType(rawType))
                }
                return item
            }
            guard pasteboard.writeObjects(restored) else {
                throw BridgeError("PASTEBOARD_RESTORE_FAILED")
            }
        }
        guard try exactPasteboardSnapshot(errorCode: "PASTEBOARD_RESTORE_FAILED") == snapshot else {
            throw BridgeError("PASTEBOARD_RESTORE_FAILED")
        }
    }

    func assertComposerEmptyBaseline() throws {
        let marker = "__CHAT_ASSISTANT_EMPTY_IMAGE_PROBE_\(UUID().uuidString)__"
        pasteboard.clearContents()
        guard pasteboard.setString(marker, forType: .string) else {
            throw BridgeError("PASTEBOARD_WRITE_FAILED")
        }
        let baseline = pasteboard.changeCount
        try postShortcut(virtualKey: 0)
        Thread.sleep(forTimeInterval: 0.06)
        try postShortcut(virtualKey: 8)
        waitForPasteboardChange(after: baseline)
        guard pasteboard.changeCount == baseline,
              pasteboard.string(forType: .string) == marker,
              try textPort.isVisuallyEmpty() else {
            throw BridgeError("WECHAT_COMPOSER_NOT_EMPTY")
        }
    }

    func pasteReviewedImage(_ expected: ImageAttachmentExpectation) throws {
        guard let reviewedImage,
              expected.receipt == reviewedImage.receipt,
              expected.pixelSha256 == reviewedImage.pixelSha256,
              let image = NSImage(data: reviewedImage.bytes) else {
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_INVALID")
        }
        pasteboard.clearContents()
        guard pasteboard.writeObjects([image]) else {
            throw BridgeError("PASTEBOARD_WRITE_FAILED")
        }
        try postShortcut(virtualKey: 9)
        Thread.sleep(forTimeInterval: 0.35)
    }

    func readPreparedImage() throws -> ImageAttachmentObservation {
        let marker = "__CHAT_ASSISTANT_IMAGE_PROBE_\(UUID().uuidString)__"
        pasteboard.clearContents()
        guard pasteboard.setString(marker, forType: .string) else {
            throw BridgeError("PASTEBOARD_WRITE_FAILED")
        }
        let baseline = pasteboard.changeCount
        try postShortcut(virtualKey: 0)
        Thread.sleep(forTimeInterval: 0.06)
        try postShortcut(virtualKey: 8)
        waitForPasteboardChange(after: baseline)
        guard pasteboard.changeCount != baseline else {
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_NOT_VERIFIED")
        }
        let images = pasteboard.readObjects(forClasses: [NSImage.self], options: nil) as? [NSImage] ?? []
        let actualImage = images.count == 1 ? images[0] : nil
        var proposedRect = actualImage.map { NSRect(origin: .zero, size: $0.size) } ?? .zero
        let cgImage = actualImage?.cgImage(
            forProposedRect: &proposedRect,
            context: nil,
            hints: nil
        )
        let copiedText = pasteboard.string(forType: .string)
        let unknownRepresentation = try containsUnknownPreparedRepresentation()
        let pixelSha256 = if let cgImage, cgImage.width == 1080, cgImage.height == 1350 {
            try ReviewedImagePixels.sha256(cgImage)
        } else {
            ""
        }
        return ImageAttachmentObservation(
            pixelSha256: pixelSha256,
            width: cgImage?.width ?? 0,
            height: cgImage?.height ?? 0,
            attachmentCount: images.count,
            textEmpty: copiedText == nil || copiedText?.isEmpty == true,
            hasUnknownRepresentations: unknownRepresentation
        )
    }

    func collapseSelection() throws {
        try textPort.collapseSelection()
    }

    func clearPreparedImage(expectedPixelSha256: String) throws {
        guard let reviewedImage,
              expectedPixelSha256 == reviewedImage.pixelSha256 else {
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_CLEAR_FAILED")
        }
        let observation: ImageAttachmentObservation
        do {
            observation = try readPreparedImage()
        } catch {
            do {
                try assertComposerEmptyBaseline()
                return
            } catch {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_CLEAR_FAILED")
            }
        }
        guard ImageAttachmentCleanupAuthorization.permitsUndo(
            observation,
            expectedPixelSha256: expectedPixelSha256
        ) else {
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_CLEAR_FAILED")
        }
        try postShortcut(virtualKey: 6)
        Thread.sleep(forTimeInterval: 0.20)
        do {
            try assertComposerEmptyBaseline()
        } catch {
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_CLEAR_FAILED")
        }
    }

    private func exactPasteboardSnapshot(errorCode: String) throws -> PasteboardSnapshot {
        var items: [[String: Data]] = []
        for item in pasteboard.pasteboardItems ?? [] {
            var representations: [String: Data] = [:]
            for type in item.types {
                guard let data = item.data(forType: type) else {
                    throw BridgeError(errorCode)
                }
                representations[type.rawValue] = data
            }
            guard representations.count == item.types.count else {
                throw BridgeError(errorCode)
            }
            items.append(representations)
        }
        return PasteboardSnapshot(items: items)
    }

    private func containsUnknownPreparedRepresentation() throws -> Bool {
        for item in pasteboard.pasteboardItems ?? [] {
            for type in item.types {
                guard let data = item.data(forType: type) else { return true }
                if NSImage(data: data) == nil { return true }
            }
        }
        return false
    }

    private func waitForPasteboardChange(after baseline: Int) {
        let deadline = ProcessInfo.processInfo.systemUptime + 1.0
        while pasteboard.changeCount == baseline && ProcessInfo.processInfo.systemUptime < deadline {
            Thread.sleep(forTimeInterval: 0.01)
        }
    }

    private func postShortcut(virtualKey: CGKeyCode) throws {
        try postKey(virtualKey: virtualKey, flags: .maskCommand)
    }

    private func postKey(
        virtualKey: CGKeyCode,
        flags: CGEventFlags = []
    ) throws {
        guard let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: virtualKey, keyDown: false) else {
            throw BridgeError("TEXT_INPUT_EVENT_CREATION_FAILED")
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}
