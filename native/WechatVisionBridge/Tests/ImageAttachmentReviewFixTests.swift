import AppKit
import Foundation
import XCTest
@testable import WechatVisionBridge

final class ImageAttachmentReviewFixTests: XCTestCase {
    private let fileSha256 = "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177"
    private let pixelSha256 = String(repeating: "a", count: 64)

    func testRejectsASameSizeImageWithDifferentActualPixelsAndClearsOnlyTheAttempt() throws {
        let port = ReviewFixImagePort(
            observation: observation(pixelSha256: String(repeating: "b", count: 64))
        )

        XCTAssertThrowsError(
            try ImageAttachmentClipboardTransaction.prepare(imageExpectation(), using: port)
        ) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_ATTACHMENT_NOT_VERIFIED")
        }
        XCTAssertEqual(port.pasteCount, 1)
        XCTAssertEqual(port.clearCount, 1)
        XCTAssertEqual(port.restoreCount, 1)
    }

    func testRefusesAnExistingAttachmentBeforePasteAndRestoresTheClipboard() throws {
        let port = ReviewFixImagePort(
            observation: observation(),
            baselineError: BridgeError("WECHAT_COMPOSER_NOT_EMPTY")
        )

        XCTAssertThrowsError(
            try ImageAttachmentClipboardTransaction.prepare(imageExpectation(), using: port)
        ) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_COMPOSER_NOT_EMPTY")
        }
        XCTAssertEqual(port.pasteCount, 0)
        XCTAssertEqual(port.clearCount, 0)
        XCTAssertEqual(port.restoreCount, 1)
    }

    func testConcurrentAttachmentCausesClearFailureInsteadOfDeletingUnknownContent() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("image-clear-dirty-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FileImageAttachmentCapabilityConsumptionStore(rootURL: root)
        let port = ReviewFixImagePort(
            observation: ImageAttachmentObservation(
                pixelSha256: pixelSha256,
                width: 1080,
                height: 1350,
                attachmentCount: 2,
                textEmpty: true,
                hasUnknownRepresentations: false
            ),
            clearError: BridgeError("WECHAT_IMAGE_ATTACHMENT_CLEAR_FAILED")
        )

        XCTAssertThrowsError(
            try ImageAttachmentAttempt.prepare(
                imageExpectation(),
                using: port,
                consumptionStore: store
            )
        ) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_ATTACHMENT_CLEAR_FAILED")
        }
        XCTAssertEqual(port.clearCount, 1)
        XCTAssertEqual(port.restoreCount, 1)
        XCTAssertThrowsError(try store.assertClean()) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_ATTACHMENT_DIRTY")
        }
    }

    func testChangedSingleAttachmentCannotAuthorizeUndoOfUnknownContent() {
        XCTAssertFalse(ImageAttachmentCleanupAuthorization.permitsUndo(
            observation(pixelSha256: String(repeating: "b", count: 64)),
            expectedPixelSha256: pixelSha256
        ))
        XCTAssertTrue(ImageAttachmentCleanupAuthorization.permitsUndo(
            observation(),
            expectedPixelSha256: pixelSha256
        ))
    }

    func testRestoreFailureOverridesClearAndOperationFailures() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("image-restore-dirty-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FileImageAttachmentCapabilityConsumptionStore(rootURL: root)
        let port = ReviewFixImagePort(
            observation: observation(pixelSha256: String(repeating: "c", count: 64)),
            clearError: BridgeError("WECHAT_IMAGE_ATTACHMENT_CLEAR_FAILED"),
            restoreError: BridgeError("SYNTHETIC_RESTORE_FAILED")
        )

        XCTAssertThrowsError(
            try ImageAttachmentAttempt.prepare(
                imageExpectation(),
                using: port,
                consumptionStore: store
            )
        ) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "PASTEBOARD_RESTORE_FAILED")
        }
        XCTAssertEqual(port.clearCount, 1)
        XCTAssertEqual(port.restoreCount, 1)
        XCTAssertThrowsError(try store.assertClean()) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_ATTACHMENT_DIRTY")
        }
    }

    func testIncompletePasteboardSnapshotStopsBeforeAnyComposerMutation() throws {
        let port = ReviewFixImagePort(
            observation: observation(),
            snapshotError: BridgeError("PASTEBOARD_SNAPSHOT_FAILED")
        )

        XCTAssertThrowsError(
            try ImageAttachmentClipboardTransaction.prepare(imageExpectation(), using: port)
        ) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "PASTEBOARD_SNAPSHOT_FAILED")
        }
        XCTAssertEqual(port.pasteCount, 0)
        XCTAssertEqual(port.clearCount, 0)
        XCTAssertEqual(port.restoreCount, 0)
    }

    func testSystemPasteboardRestoreReplaysEveryItemTypeAndByteExactly() throws {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("image-restore-\(UUID().uuidString)"))
        pasteboard.clearContents()
        let first = NSPasteboardItem()
        first.setData(Data("first".utf8), forType: .init("com.example.first"))
        first.setData(Data([0, 1, 2, 3]), forType: .init("com.example.binary"))
        let second = NSPasteboardItem()
        second.setData(Data("second".utf8), forType: .init("com.example.second"))
        XCTAssertTrue(pasteboard.writeObjects([first, second]))
        let port = try systemPort(pasteboard: pasteboard)
        let snapshot = try port.snapshotPasteboard()

        pasteboard.clearContents()
        XCTAssertTrue(pasteboard.setString("mutated", forType: .string))
        XCTAssertNoThrow(try port.restorePasteboard(snapshot))
        XCTAssertEqual(try port.snapshotPasteboard(), snapshot)
    }

    func testSystemPasteboardSnapshotRejectsAPromisedRepresentationWithoutBytes() throws {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name("image-snapshot-\(UUID().uuidString)"))
        pasteboard.clearContents()
        let provider = MissingPasteboardDataProvider()
        let item = NSPasteboardItem()
        item.setDataProvider(provider, forTypes: [.init("com.example.missing")])
        XCTAssertTrue(pasteboard.writeObjects([item]))
        let port = try systemPort(pasteboard: pasteboard)

        XCTAssertThrowsError(try port.snapshotPasteboard()) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "PASTEBOARD_SNAPSHOT_FAILED")
        }
    }

    func testTwoIndependentStoresAtomicallyConsumeOneCapabilityAndPersistDirtyState() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("image-capability-review-fix-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let binding = capabilityBinding()
        let first = FileImageAttachmentCapabilityConsumptionStore(rootURL: root)
        let second = FileImageAttachmentCapabilityConsumptionStore(rootURL: root)

        XCTAssertNoThrow(try first.consume(binding))
        XCTAssertThrowsError(try second.consume(binding)) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WRITE_CAPABILITY_ALREADY_USED")
        }
        XCTAssertNoThrow(try first.markDirty())
        XCTAssertThrowsError(try second.assertClean()) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_ATTACHMENT_DIRTY")
        }
    }

    func testConcurrentStoreInstancesAllowExactlyOneAttempt() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("image-capability-concurrent-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let binding = capabilityBinding()
        let resultLock = NSLock()
        var successes = 0
        var alreadyUsed = 0
        var unexpected: [String] = []

        DispatchQueue.concurrentPerform(iterations: 12) { _ in
            do {
                try FileImageAttachmentCapabilityConsumptionStore(rootURL: root).consume(binding)
                resultLock.withLock { successes += 1 }
            } catch {
                resultLock.withLock {
                    if (error as? BridgeError)?.code == "WRITE_CAPABILITY_ALREADY_USED" {
                        alreadyUsed += 1
                    } else {
                        unexpected.append((error as? BridgeError)?.code ?? String(describing: error))
                    }
                }
            }
        }
        XCTAssertEqual(successes, 1)
        XCTAssertEqual(alreadyUsed, 11)
        XCTAssertEqual(unexpected, [])
    }

    func testInvalidCapabilityStopsBeforeFocus() throws {
        var focusCount = 0
        var headerCount = 0

        XCTAssertThrowsError(try ImageAttachmentAdmission.authorizeThenFocus(
            assertHeader: { headerCount += 1 },
            consumeCapability: { throw BridgeError("WRITE_CAPABILITY_ALREADY_USED") },
            focus: { focusCount += 1 },
            reassertHeader: { headerCount += 1 }
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WRITE_CAPABILITY_ALREADY_USED")
        }
        XCTAssertEqual(headerCount, 1)
        XCTAssertEqual(focusCount, 0)
    }

    func testDirtyRecoveryArchivesTheExactMarkerOnlyAfterEmptyComposerAndPasteboardRestore() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("image-dirty-recovery-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = FileImageAttachmentCapabilityConsumptionStore(rootURL: root)
        try store.markDirty()
        let port = ReviewFixImagePort(observation: observation())

        let receipt = try ImageAttachmentQuarantineRecovery.recover(
            using: port,
            consumptionStore: store
        )

        XCTAssertEqual(receipt.status, "recovered")
        XCTAssertTrue(receipt.archiveName.hasPrefix("dirty-archive-"))
        XCTAssertEqual(receipt.archiveName.count, "dirty-archive-".count + 64)
        XCTAssertTrue(receipt.composerEmpty)
        XCTAssertEqual(port.restoreCount, 1)
        XCTAssertNoThrow(try store.assertClean())
        XCTAssertEqual(
            try Data(contentsOf: root.appendingPathComponent(receipt.archiveName)),
            Data("dirty\n".utf8)
        )
        XCTAssertEqual(
            try ImageAttachmentQuarantineRecovery.recover(
                using: port,
                consumptionStore: store
            ).status,
            "already-clean"
        )
    }

    func testDirtyRecoveryKeepsQuarantineWhenComposerIsNotEmptyOrPasteboardRestoreFails() throws {
        for port in [
            ReviewFixImagePort(
                observation: observation(),
                baselineError: BridgeError("WECHAT_COMPOSER_NOT_EMPTY")
            ),
            ReviewFixImagePort(
                observation: observation(),
                restoreError: BridgeError("SYNTHETIC_RESTORE_FAILED")
            ),
        ] {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent("image-dirty-blocked-\(UUID().uuidString)", isDirectory: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = FileImageAttachmentCapabilityConsumptionStore(rootURL: root)
            try store.markDirty()

            XCTAssertThrowsError(try ImageAttachmentQuarantineRecovery.recover(
                using: port,
                consumptionStore: store
            ))
            XCTAssertThrowsError(try store.assertClean()) { error in
                XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_ATTACHMENT_DIRTY")
            }
            XCTAssertEqual(
                (try? FileManager.default.contentsOfDirectory(atPath: root.path))?
                    .filter { $0.hasPrefix("dirty-archive-") },
                []
            )
        }
    }

    func testDirtyRecoveryRejectsMalformedMarkerWithoutArchivingIt() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("image-dirty-malformed-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: 0o700)],
            ofItemAtPath: root.path
        )
        try Data("other\n".utf8).write(to: root.appendingPathComponent(".dirty"))
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: 0o600)],
            ofItemAtPath: root.appendingPathComponent(".dirty").path
        )
        let store = FileImageAttachmentCapabilityConsumptionStore(rootURL: root)

        XCTAssertThrowsError(try store.archiveDirtyMarker()) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_ATTACHMENT_RECOVERY_INVALID")
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(".dirty").path))
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(atPath: root.path)
                .filter { $0.hasPrefix("dirty-archive-") },
            []
        )
    }

    private func imageExpectation() -> ImageAttachmentExpectation {
        ImageAttachmentExpectation(
            receipt: ImageAttachmentReceipt(
                imageSha256: fileSha256,
                width: 1080,
                height: 1350,
                attachmentCount: 1,
                textEmpty: true
            ),
            pixelSha256: pixelSha256
        )
    }

    private func observation(pixelSha256: String? = nil) -> ImageAttachmentObservation {
        ImageAttachmentObservation(
            pixelSha256: pixelSha256 ?? self.pixelSha256,
            width: 1080,
            height: 1350,
            attachmentCount: 1,
            textEmpty: true,
            hasUnknownRepresentations: false
        )
    }

    private func capabilityBinding() -> ImageAttachmentCapabilityBinding {
        ImageAttachmentCapabilityBinding(
            capabilityId: String(repeating: "d", count: 64),
            action: "attach-image",
            target: "文件传输助手",
            slotHash: String(repeating: "1", count: 64),
            imageSha256: fileSha256,
            windowRevision: String(repeating: "2", count: 64),
            identityFingerprint: String(repeating: "3", count: 64),
            expiresAt: "2026-08-30T03:00:00.000Z"
        )
    }

    private func systemPort(pasteboard: NSPasteboard) throws -> SystemComposerImageAttachmentPort {
        SystemComposerImageAttachmentPort(
            windowID: 0,
            reviewedImage: try ReviewedImageFile.open(
                path: reviewedCardPath(),
                expectedSha256: fileSha256,
                expectedWidth: 1080,
                expectedHeight: 1350
            ),
            pasteboard: pasteboard
        )
    }

    private func reviewedCardPath() -> String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("assets/relationship-care/intro-card.png")
            .path
    }
}

private final class MissingPasteboardDataProvider: NSObject, NSPasteboardItemDataProvider {
    func pasteboard(
        _ pasteboard: NSPasteboard?,
        item: NSPasteboardItem,
        provideDataForType type: NSPasteboard.PasteboardType
    ) {}
}

private final class ReviewFixImagePort: ComposerImageAttachmentPort {
    var pasteCount = 0
    var clearCount = 0
    var restoreCount = 0

    private let observation: ImageAttachmentObservation
    private let baselineError: Error?
    private let clearError: Error?
    private let restoreError: Error?
    private let snapshotError: Error?

    init(
        observation: ImageAttachmentObservation,
        baselineError: Error? = nil,
        clearError: Error? = nil,
        restoreError: Error? = nil,
        snapshotError: Error? = nil
    ) {
        self.observation = observation
        self.baselineError = baselineError
        self.clearError = clearError
        self.restoreError = restoreError
        self.snapshotError = snapshotError
    }

    func snapshotPasteboard() throws -> PasteboardSnapshot {
        if let snapshotError { throw snapshotError }
        return PasteboardSnapshot(items: [["public.utf8-plain-text": Data("用户剪贴板".utf8)]])
    }

    func restorePasteboard(_ snapshot: PasteboardSnapshot) throws {
        restoreCount += 1
        if restoreError != nil { throw BridgeError("PASTEBOARD_RESTORE_FAILED") }
    }

    func assertComposerEmptyBaseline() throws {
        if let baselineError { throw baselineError }
    }

    func pasteReviewedImage(_ expected: ImageAttachmentExpectation) throws {
        pasteCount += 1
    }

    func readPreparedImage() throws -> ImageAttachmentObservation { observation }

    func collapseSelection() throws {}

    func clearPreparedImage(expectedPixelSha256: String) throws {
        clearCount += 1
        if let clearError { throw clearError }
    }
}
