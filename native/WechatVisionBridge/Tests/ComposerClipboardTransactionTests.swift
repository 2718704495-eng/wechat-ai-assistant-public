import Foundation
import XCTest
@testable import WechatVisionBridge

final class ComposerClipboardTransactionTests: XCTestCase {
    func testPreparesExactlyOneReviewedImageAndRestoresTheClipboardWithoutSubmitting() throws {
        let expected = ImageAttachmentReceipt(
            imageSha256: "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177",
            width: 1080,
            height: 1350,
            attachmentCount: 1,
            textEmpty: true
        )
        let expectation = ImageAttachmentExpectation(
            receipt: expected,
            pixelSha256: String(repeating: "a", count: 64)
        )
        let port = StatefulImageAttachmentPort(observation: ImageAttachmentObservation(
            pixelSha256: expectation.pixelSha256,
            width: 1080,
            height: 1350,
            attachmentCount: 1,
            textEmpty: true,
            hasUnknownRepresentations: false
        ))

        let receipt = try ImageAttachmentClipboardTransaction.prepare(expectation, using: port)

        XCTAssertEqual(receipt, expected)
        XCTAssertEqual(port.pasteCount, 1)
        XCTAssertEqual(port.clearCount, 0)
        XCTAssertEqual(port.restoreCount, 1)
        XCTAssertEqual(port.submitCount, 0)
    }

    func testClearsAnUnverifiedImageAndRestoresTheClipboardBeforeFailingClosed() throws {
        let expected = ImageAttachmentReceipt(
            imageSha256: "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177",
            width: 1080,
            height: 1350,
            attachmentCount: 1,
            textEmpty: true
        )
        let expectation = ImageAttachmentExpectation(
            receipt: expected,
            pixelSha256: String(repeating: "a", count: 64)
        )
        let port = StatefulImageAttachmentPort(observation: ImageAttachmentObservation(
            pixelSha256: expectation.pixelSha256,
            width: 1080,
            height: 1350,
            attachmentCount: 2,
            textEmpty: true,
            hasUnknownRepresentations: false
        ))

        XCTAssertThrowsError(try ImageAttachmentClipboardTransaction.prepare(expectation, using: port)) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_ATTACHMENT_NOT_VERIFIED")
        }
        XCTAssertEqual(port.pasteCount, 1)
        XCTAssertEqual(port.clearCount, 1)
        XCTAssertEqual(port.restoreCount, 1)
        XCTAssertEqual(port.submitCount, 0)
    }

    func testClearsAPossiblyPartialImageWhenPasteThrowsAndStillRestoresTheClipboard() throws {
        let expected = ImageAttachmentReceipt(
            imageSha256: "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177",
            width: 1080,
            height: 1350,
            attachmentCount: 1,
            textEmpty: true
        )
        let expectation = ImageAttachmentExpectation(
            receipt: expected,
            pixelSha256: String(repeating: "a", count: 64)
        )
        let port = StatefulImageAttachmentPort(observation: ImageAttachmentObservation(
            pixelSha256: expectation.pixelSha256,
            width: 1080,
            height: 1350,
            attachmentCount: 1,
            textEmpty: true,
            hasUnknownRepresentations: false
        ), pasteFails: true)

        XCTAssertThrowsError(try ImageAttachmentClipboardTransaction.prepare(expectation, using: port)) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "SYNTHETIC_IMAGE_PASTE_FAILED")
        }
        XCTAssertEqual(port.pasteCount, 1)
        XCTAssertEqual(port.clearCount, 0)
        XCTAssertEqual(port.restoreCount, 1)
        XCTAssertEqual(port.submitCount, 0)
    }

    func testSubmitStopsAfterReturnClearsTheComposer() throws {
        let port = StatefulWechatSubmitShortcutPort(
            expected: "晚安\n——示例用户",
            observations: [""]
        )

        try WechatSubmitShortcutTransaction.submit(port.expected, using: port)

        XCTAssertEqual(port.shortcuts, [.returnKey])
        XCTAssertEqual(port.restoredDrafts, [])
        XCTAssertEqual(port.composerText, "")
    }

    func testSubmitRestoresAProvenNewlineThenUsesCommandReturn() throws {
        let expected = "晚安\n——示例用户"
        let port = StatefulWechatSubmitShortcutPort(
            expected: expected,
            observations: [expected + "\n", ""]
        )

        try WechatSubmitShortcutTransaction.submit(expected, using: port)

        XCTAssertEqual(port.shortcuts, [.returnKey, .commandReturn])
        XCTAssertEqual(port.restoredDrafts, [expected])
        XCTAssertEqual(port.composerText, "")
    }

    func testSubmitRestoresTheDraftAndFailsWhenNeitherShortcutSends() throws {
        let expected = "晚安\n——示例用户"
        let port = StatefulWechatSubmitShortcutPort(
            expected: expected,
            observations: [expected + "\n", expected + "\n"]
        )

        XCTAssertThrowsError(
            try WechatSubmitShortcutTransaction.submit(expected, using: port)
        ) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_SUBMIT_SHORTCUT_UNVERIFIED")
        }
        XCTAssertEqual(port.shortcuts, [.returnKey, .commandReturn])
        XCTAssertEqual(port.restoredDrafts, [expected, expected])
        XCTAssertEqual(port.composerText, expected)
    }

    func testSubmitFailsClosedWithoutASecondShortcutForUnexpectedMutation() throws {
        let expected = "晚安\n——示例用户"
        let port = StatefulWechatSubmitShortcutPort(
            expected: expected,
            observations: ["用户并发输入"]
        )

        XCTAssertThrowsError(
            try WechatSubmitShortcutTransaction.submit(expected, using: port)
        ) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_SUBMIT_COMPOSER_CHANGED")
        }
        XCTAssertEqual(port.shortcuts, [.returnKey])
        XCTAssertEqual(port.restoredDrafts, [])
        XCTAssertEqual(port.composerText, "用户并发输入")
    }

    func testReplacesAndReadsAMultilineDraftWithoutAXAndRestoresClipboard() throws {
        let port = StatefulComposerClipboardPort(
            composerText: "",
            pasteboardText: "用户原来的剪贴板"
        )
        let expected = "今晚辛苦啦，早点休息。\n——示例用户"

        let receipt = try ComposerClipboardTransaction.replace(expected, using: port)

        XCTAssertEqual(receipt, ComposerMutationReceipt(text: expected, cleared: false))
        XCTAssertEqual(port.composerText, expected)
        XCTAssertEqual(try ComposerClipboardTransaction.read(using: port), expected)
        XCTAssertEqual(port.pasteboardText, "用户原来的剪贴板")
        XCTAssertEqual(port.restoreCount, 2)
    }

    func testReplacesTheObservedWechatEmptyEditorSentinelOnlyWhenVisuallyEmpty() throws {
        let sentinel = String(repeating: " ", count: 28)
        let port = StatefulComposerClipboardPort(
            composerText: sentinel,
            pasteboardText: "用户原来的剪贴板",
            visuallyEmptyOverride: true
        )

        let receipt = try ComposerClipboardTransaction.replace("测试信息", using: port)

        XCTAssertEqual(receipt, ComposerMutationReceipt(text: "测试信息", cleared: false))
        XCTAssertEqual(port.composerText, "测试信息")
        XCTAssertEqual(port.pasteboardText, "用户原来的剪贴板")
    }

    func testRefusesTheObservedWechatEmptyEditorSentinelWhenNotVisuallyEmpty() throws {
        let sentinel = String(repeating: " ", count: 28)
        let port = StatefulComposerClipboardPort(
            composerText: sentinel,
            pasteboardText: "用户原来的剪贴板",
            visuallyEmptyOverride: false
        )

        XCTAssertThrowsError(
            try ComposerClipboardTransaction.replace("测试信息", using: port)
        ) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_COMPOSER_NOT_EMPTY")
        }
        XCTAssertEqual(port.composerText, sentinel)
        XCTAssertEqual(port.pasteboardText, "用户原来的剪贴板")
    }

    func testRefusesToOverwriteAnExistingUserDraft() throws {
        let port = StatefulComposerClipboardPort(
            composerText: "用户正在输入",
            pasteboardText: "用户原来的剪贴板"
        )

        XCTAssertThrowsError(
            try ComposerClipboardTransaction.replace("自动消息", using: port)
        ) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_COMPOSER_NOT_EMPTY")
        }
        XCTAssertEqual(port.composerText, "用户正在输入")
        XCTAssertEqual(port.pasteboardText, "用户原来的剪贴板")
    }

    func testClearRetriesCutWhenTheRichTextEditorLeavesTheSignatureParagraph() throws {
        let port = StatefulComposerClipboardPort(
            composerText: "正文\n——示例用户",
            pasteboardText: "用户原来的剪贴板",
            cutResidues: ["——示例用户", ""]
        )

        let receipt = try ComposerClipboardTransaction.clear(using: port)

        XCTAssertEqual(receipt, ComposerMutationReceipt(text: "", cleared: true))
        XCTAssertEqual(port.composerText, "")
        XCTAssertEqual(port.cutCount, 2)
        XCTAssertEqual(port.pasteboardText, "用户原来的剪贴板")
    }

    func testMismatchedWriteClearsThePartialDraftBeforeFailingClosed() throws {
        let port = StatefulComposerClipboardPort(
            composerText: "",
            pasteboardText: "用户原来的剪贴板",
            pastedTextOverride: "候选正文\n——聊天助理"
        )

        XCTAssertThrowsError(
            try ComposerClipboardTransaction.replace("候选正文\n——示例用户", using: port)
        ) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "DRAFT_WRITE_NOT_VERIFIED")
        }
        XCTAssertEqual(port.composerText, "")
        XCTAssertEqual(port.pasteboardText, "用户原来的剪贴板")
    }

    func testClearFailsClosedAfterTheBoundedCutAttempts() throws {
        let port = StatefulComposerClipboardPort(
            composerText: "无法清除",
            pasteboardText: "用户原来的剪贴板",
            cutResidues: ["仍有残留", "还是残留"]
        )

        XCTAssertThrowsError(try ComposerClipboardTransaction.clear(using: port)) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "DRAFT_CLEAR_NOT_VERIFIED")
        }
        XCTAssertEqual(port.composerText, "还是残留")
        XCTAssertEqual(port.cutCount, 2)
        XCTAssertEqual(port.pasteboardText, "用户原来的剪贴板")
    }

    func testVisualEmptyGuardRejectsLowConfidenceOrMeaningfulComposerEvidence() {
        let lowConfidence = OCRLine(
            text: "——示例用户",
            confidence: 0.49,
            bounds: OCRBounds(x: 0.50, y: 0.20, width: 0.20, height: 0.04)
        )
        let meaningful = OCRLine(
            text: "残留",
            confidence: 0.99,
            bounds: OCRBounds(x: 0.50, y: 0.20, width: 0.10, height: 0.04)
        )
        let outsideComposer = OCRLine(
            text: "聊天记录",
            confidence: 0.99,
            bounds: OCRBounds(x: 0.50, y: 0.70, width: 0.10, height: 0.04)
        )

        XCTAssertFalse(ComposerVisualGuard.isProvenEmpty(lines: [lowConfidence]))
        XCTAssertFalse(ComposerVisualGuard.isProvenEmpty(lines: [meaningful]))
        XCTAssertTrue(ComposerVisualGuard.isProvenEmpty(lines: [outsideComposer]))
    }

    func testVisualEmptyGuardRejectsEmojiAndPunctuationResidue() {
        for residue in ["🌙✨", "——", "。"] {
            let line = OCRLine(
                text: residue,
                confidence: 0.99,
                bounds: OCRBounds(x: 0.50, y: 0.20, width: 0.10, height: 0.04)
            )
            XCTAssertFalse(ComposerVisualGuard.isProvenEmpty(lines: [line]))
        }
        let cursor = OCRLine(
            text: "｜",
            confidence: 0.99,
            bounds: OCRBounds(x: 0.50, y: 0.20, width: 0.01, height: 0.04)
        )
        XCTAssertTrue(ComposerVisualGuard.isProvenEmpty(lines: [cursor]))
    }

    func testVisualEmptyGuardTreatsObservedLowConfidenceCursorAsCursorOnlyEvidence() {
        let observedCursor = OCRLine(
            text: "|",
            confidence: 0.30,
            bounds: OCRBounds(
                x: 0.32267441912164896,
                y: 0.29388560088846283,
                width: 0.023255813355539334,
                height: 0.02761341291735453
            )
        )

        XCTAssertTrue(ComposerVisualGuard.isProvenEmpty(lines: [observedCursor]))
    }

    func testVisualEmptyGuardIgnoresOnlyTheCompactInputMethodIndicator() {
        let indicator = OCRLine(
            text: "拼",
            confidence: 1,
            bounds: OCRBounds(x: 0.385, y: 0.317, width: 0.027, height: 0.018)
        )
        let editableText = OCRLine(
            text: "拼",
            confidence: 1,
            bounds: OCRBounds(x: 0.50, y: 0.20, width: 0.08, height: 0.02)
        )

        XCTAssertTrue(ComposerVisualGuard.isProvenEmpty(lines: [indicator]))
        XCTAssertFalse(ComposerVisualGuard.isProvenEmpty(lines: [editableText]))
    }

    func testVisualEmptyGuardIgnoresOnlyCompactLowConfidenceRightActionToolbarArtifacts() {
        let artifact = OCRLine(
            text: "C日",
            confidence: 0.30,
            bounds: OCRBounds(x: 0.8939, y: 0.3417, width: 0.0785, height: 0.0378)
        )
        XCTAssertTrue(ComposerVisualGuard.isProvenEmpty(lines: [artifact]))

        let rejected = [
            OCRLine(
                text: artifact.text,
                confidence: artifact.confidence,
                bounds: OCRBounds(x: 0.80, y: 0.3417, width: 0.0785, height: 0.0378)
            ),
            OCRLine(
                text: artifact.text,
                confidence: artifact.confidence,
                bounds: OCRBounds(x: 0.8939, y: 0.20, width: 0.0785, height: 0.0378)
            ),
            OCRLine(
                text: artifact.text,
                confidence: 0.50,
                bounds: artifact.bounds
            ),
            OCRLine(
                text: artifact.text,
                confidence: artifact.confidence,
                bounds: OCRBounds(x: 0.8939, y: 0.3417, width: 0.11, height: 0.0378)
            ),
            OCRLine(
                text: "工具栏",
                confidence: artifact.confidence,
                bounds: artifact.bounds
            ),
        ]
        for line in rejected {
            XCTAssertFalse(ComposerVisualGuard.isProvenEmpty(lines: [line]))
        }
    }
}

private final class StatefulImageAttachmentPort: ComposerImageAttachmentPort {
    var pasteCount = 0
    var clearCount = 0
    var restoreCount = 0
    var submitCount = 0

    private let observation: ImageAttachmentObservation
    private let pasteFails: Bool

    init(observation: ImageAttachmentObservation, pasteFails: Bool = false) {
        self.observation = observation
        self.pasteFails = pasteFails
    }

    func snapshotPasteboard() throws -> PasteboardSnapshot {
        PasteboardSnapshot(items: [["public.utf8-plain-text": Data("用户剪贴板".utf8)]])
    }

    func restorePasteboard(_ snapshot: PasteboardSnapshot) throws {
        restoreCount += 1
    }

    func assertComposerEmptyBaseline() throws {}

    func pasteReviewedImage(_ expected: ImageAttachmentExpectation) throws {
        pasteCount += 1
        if pasteFails { throw BridgeError("SYNTHETIC_IMAGE_PASTE_FAILED") }
    }

    func readPreparedImage() throws -> ImageAttachmentObservation { observation }

    func collapseSelection() throws {}

    func clearPreparedImage(expectedPixelSha256: String) throws { clearCount += 1 }
}

private final class StatefulWechatSubmitShortcutPort: WechatSubmitShortcutPort {
    let expected: String
    var composerText: String
    var shortcuts: [WechatSubmitShortcut] = []
    var restoredDrafts: [String] = []

    private var observations: [String]

    init(expected: String, observations: [String]) {
        self.expected = expected
        composerText = expected
        self.observations = observations
    }

    func press(_ shortcut: WechatSubmitShortcut) throws {
        shortcuts.append(shortcut)
        composerText = observations.removeFirst()
    }

    func readComposer() throws -> String {
        composerText
    }

    func restoreComposer(_ text: String) throws {
        restoredDrafts.append(text)
        composerText = text
    }
}

private final class StatefulComposerClipboardPort: ComposerClipboardPort {
    var composerText: String
    var pasteboardText: String?
    var restoreCount = 0
    var cutCount = 0

    private var cutResidues: [String]
    private let pastedTextOverride: String?
    private let visuallyEmptyOverride: Bool?

    init(
        composerText: String,
        pasteboardText: String?,
        cutResidues: [String] = [],
        pastedTextOverride: String? = nil,
        visuallyEmptyOverride: Bool? = nil
    ) {
        self.composerText = composerText
        self.pasteboardText = pasteboardText
        self.cutResidues = cutResidues
        self.pastedTextOverride = pastedTextOverride
        self.visuallyEmptyOverride = visuallyEmptyOverride
    }

    func snapshotPasteboard() throws -> PasteboardSnapshot {
        PasteboardSnapshot(items: pasteboardText.map { [["public.utf8-plain-text": Data($0.utf8)]] } ?? [])
    }

    func restorePasteboard(_ snapshot: PasteboardSnapshot) throws {
        restoreCount += 1
        pasteboardText = snapshot.items.first?["public.utf8-plain-text"]
            .flatMap { String(data: $0, encoding: .utf8) }
    }

    func selectAllAndCopy() throws -> String? {
        pasteboardText = composerText.isEmpty ? pasteboardText : composerText
        return composerText.isEmpty ? nil : composerText
    }

    func selectAllAndCut() throws -> String? {
        cutCount += 1
        let removed = composerText
        pasteboardText = removed
        composerText = cutResidues.isEmpty ? "" : cutResidues.removeFirst()
        return removed.isEmpty ? nil : removed
    }

    func paste(_ text: String) throws {
        composerText = pastedTextOverride ?? text
    }

    func isVisuallyEmpty() throws -> Bool {
        visuallyEmptyOverride ?? composerText.isEmpty
    }

    func collapseSelection() throws {}
}
