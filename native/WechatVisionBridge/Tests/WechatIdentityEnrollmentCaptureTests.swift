import AppKit
import CryptoKit
import XCTest
@testable import WechatVisionBridge

final class WechatIdentityEnrollmentCaptureTests: XCTestCase {
    func testSelectedRowMustBeUniqueAndWorstFrameControlsIdentityDistance() throws {
        let selected = WechatSelectedRowAttestation(title: "我", normalizedY: 0.79)
        XCTAssertEqual(
            try WindowAccess.uniqueSelectedRow([selected], expectedTitle: "我"),
            selected
        )
        XCTAssertThrowsError(try WindowAccess.uniqueSelectedRow([], expectedTitle: "我"))
        XCTAssertThrowsError(try WindowAccess.uniqueSelectedRow(
            [selected, WechatSelectedRowAttestation(title: "我", normalizedY: 0.59)],
            expectedTitle: "我"
        ))
        XCTAssertEqual(WindowAccess.worstIdentityMatchDistance([0.01, 0.17, 0.02]), 0.17)
    }

    func testSelectedRowProofBindsTitlePositionAndWindowRevision() {
        let first = WindowAccess.selectedRowProofHash(
            title: "我",
            normalizedY: 0.79,
            windowRevision: String(repeating: "a", count: 64)
        )
        XCTAssertEqual(first.count, 64)
        XCTAssertEqual(first, WindowAccess.selectedRowProofHash(
            title: "我",
            normalizedY: 0.7900001,
            windowRevision: String(repeating: "a", count: 64)
        ))
        XCTAssertNotEqual(first, WindowAccess.selectedRowProofHash(
            title: "其他会话",
            normalizedY: 0.79,
            windowRevision: String(repeating: "a", count: 64)
        ))
        XCTAssertNotEqual(first, WindowAccess.selectedRowProofHash(
            title: "我",
            normalizedY: 0.59,
            windowRevision: String(repeating: "b", count: 64)
        ))
    }

    func testCapturesRealArchivesAndRejectsPreviewOrRevisionDriftWithoutMutation() throws {
        let window = WindowDescriptor(
            windowID: 42,
            processID: 100,
            bundleID: "com.tencent.xinWeChat",
            title: "微信",
            ownerName: "微信",
            bounds: OCRBounds(x: 0, y: 0, width: 700, height: 600)
        )
        let revision = WriteCapabilityAuthorization.windowRevision(window)
        let lines = evidenceLines(preview: "刚发来的问题")
        let previewHash = digest(["wechat-conversation-preview-v1", "刚发来的问题"])
        let receipt = try WindowAccess.captureWechatIdentitySamples(
            windowID: 42,
            expectedBundleID: "com.tencent.xinWeChat",
            expectedTitle: "微信",
            expectedConversationTitle: "我",
            expectedPreviewHash: previewHash,
            expectedWindowRevision: revision,
            sampleCount: 3,
            windowListProvider: { _ in [window] },
            descriptorProvider: { _ in window },
            frameProvider: { _ in (try self.image(), lines) }
        )

        XCTAssertEqual(receipt.referenceSamples.count, 3)
        XCTAssertEqual(receipt.observedFingerprints.count, 3)
        XCTAssertEqual(receipt.windowRevision, revision)
        XCTAssertLessThanOrEqual(receipt.maximumPairwiseDistance, 0.18)
        for encoded in receipt.referenceSamples {
            XCTAssertTrue(Data(base64Encoded: encoded)?.starts(with: Data("bplist00".utf8)) == true)
        }

        XCTAssertThrowsError(try WindowAccess.captureWechatIdentitySamples(
            windowID: 42,
            expectedBundleID: "com.tencent.xinWeChat",
            expectedTitle: "微信",
            expectedConversationTitle: "我",
            expectedPreviewHash: digest(["wechat-conversation-preview-v1", "别的预览"]),
            expectedWindowRevision: revision,
            sampleCount: 3,
            windowListProvider: { _ in [window] },
            descriptorProvider: { _ in window },
            frameProvider: { _ in (try self.image(), lines) }
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IDENTITY_PREVIEW_MISMATCH")
        }

        var descriptorCalls = 0
        XCTAssertThrowsError(try WindowAccess.captureWechatIdentitySamples(
            windowID: 42,
            expectedBundleID: "com.tencent.xinWeChat",
            expectedTitle: "微信",
            expectedConversationTitle: "我",
            expectedPreviewHash: previewHash,
            expectedWindowRevision: revision,
            sampleCount: 3,
            windowListProvider: { _ in [window] },
            descriptorProvider: { _ in
                descriptorCalls += 1
                return descriptorCalls == 1 ? window : WindowDescriptor(
                    windowID: 42, processID: 101, bundleID: window.bundleID,
                    title: window.title, ownerName: window.ownerName, bounds: window.bounds
                )
            },
            frameProvider: { _ in (try self.image(), lines) }
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IDENTITY_WINDOW_REVISION_CHANGED")
        }
    }

    func testChecksUniqueWindowInsideTheCommandBeforeAndAfterAllFrames() throws {
        let window = testWindow()
        let revision = WriteCapabilityAuthorization.windowRevision(window)
        let previewHash = digest(["wechat-conversation-preview-v1", "刚发来的问题"])
        var listCalls = 0

        XCTAssertThrowsError(try WindowAccess.captureWechatIdentitySamples(
            windowID: window.windowID,
            expectedBundleID: "com.tencent.xinWeChat",
            expectedTitle: "微信",
            expectedConversationTitle: "我",
            expectedPreviewHash: previewHash,
            expectedWindowRevision: revision,
            sampleCount: 3,
            windowListProvider: { _ in
                listCalls += 1
                return listCalls == 1 ? [window] : [window, WindowDescriptor(
                    windowID: 43, processID: 101, bundleID: window.bundleID,
                    title: window.title, ownerName: window.ownerName, bounds: window.bounds
                )]
            },
            descriptorProvider: { _ in window },
            frameProvider: { _ in (try self.image(), self.evidenceLines(preview: "刚发来的问题")) }
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IDENTITY_WINDOW_REVISION_CHANGED")
        }
        XCTAssertEqual(listCalls, 2)
    }

    func testFencesEveryEnrollmentFrameBeforeAndAfterCaptureEvenWhenCatalogRecovers() throws {
        let window = testWindow()
        let revision = WriteCapabilityAuthorization.windowRevision(window)
        let previewHash = digest(["wechat-conversation-preview-v1", "刚发来的问题"])
        let duplicate = WindowDescriptor(
            windowID: 43, processID: 101, bundleID: window.bundleID,
            title: window.title, ownerName: window.ownerName, bounds: window.bounds
        )
        var listCalls = 0
        var frameCalls = 0

        XCTAssertThrowsError(try WindowAccess.captureWechatIdentitySamples(
            windowID: window.windowID,
            expectedBundleID: "com.tencent.xinWeChat",
            expectedTitle: "微信",
            expectedConversationTitle: "我",
            expectedPreviewHash: previewHash,
            expectedWindowRevision: revision,
            sampleCount: 3,
            windowListProvider: { _ in
                listCalls += 1
                return listCalls == 4 ? [window, duplicate] : [window]
            },
            descriptorProvider: { _ in window },
            frameProvider: { _ in
                frameCalls += 1
                return (try self.image(), self.evidenceLines(preview: "刚发来的问题"))
            }
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IDENTITY_WINDOW_REVISION_CHANGED")
        }
        XCTAssertEqual(frameCalls, 1)
        XCTAssertEqual(listCalls, 4)
    }

    func testFencesEveryEnrollmentFrameDescriptorBeforeCaptureEvenWhenRevisionRecovers() throws {
        let window = testWindow()
        let drifted = WindowDescriptor(
            windowID: window.windowID, processID: 101, bundleID: window.bundleID,
            title: window.title, ownerName: window.ownerName, bounds: window.bounds
        )
        let revision = WriteCapabilityAuthorization.windowRevision(window)
        let previewHash = digest(["wechat-conversation-preview-v1", "刚发来的问题"])
        var descriptorCalls = 0
        var frameCalls = 0

        XCTAssertThrowsError(try WindowAccess.captureWechatIdentitySamples(
            windowID: window.windowID,
            expectedBundleID: "com.tencent.xinWeChat",
            expectedTitle: "微信",
            expectedConversationTitle: "我",
            expectedPreviewHash: previewHash,
            expectedWindowRevision: revision,
            sampleCount: 3,
            windowListProvider: { _ in [window] },
            descriptorProvider: { _ in
                descriptorCalls += 1
                return descriptorCalls == 4 ? drifted : window
            },
            frameProvider: { _ in
                frameCalls += 1
                return (try self.image(), self.evidenceLines(preview: "刚发来的问题"))
            }
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IDENTITY_WINDOW_REVISION_CHANGED")
        }
        XCTAssertEqual(frameCalls, 1)
        XCTAssertEqual(descriptorCalls, 4)
    }

    func testFencesEnrollmentWhenCatalogDescriptorDriftsButDirectDescriptorDoesNot() throws {
        let window = testWindow()
        let driftedCatalogWindow = WindowDescriptor(
            windowID: window.windowID, processID: 101, bundleID: window.bundleID,
            title: window.title, ownerName: "伪装微信", bounds: window.bounds
        )
        let revision = WriteCapabilityAuthorization.windowRevision(window)
        let previewHash = digest(["wechat-conversation-preview-v1", "刚发来的问题"])
        var listCalls = 0
        var frameCalls = 0

        XCTAssertThrowsError(try WindowAccess.captureWechatIdentitySamples(
            windowID: window.windowID,
            expectedBundleID: "com.tencent.xinWeChat",
            expectedTitle: "微信",
            expectedConversationTitle: "我",
            expectedPreviewHash: previewHash,
            expectedWindowRevision: revision,
            sampleCount: 3,
            windowListProvider: { _ in
                listCalls += 1
                return listCalls == 4 ? [driftedCatalogWindow] : [window]
            },
            descriptorProvider: { _ in window },
            frameProvider: { _ in
                frameCalls += 1
                return (try self.image(), self.evidenceLines(preview: "刚发来的问题"))
            }
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IDENTITY_WINDOW_REVISION_CHANGED")
        }
        XCTAssertEqual(frameCalls, 1)
    }

    func testFencesEveryIdentityProofFrameAgainstAUniqueCatalogInBothPhases() throws {
        let window = testWindow()
        let duplicate = WindowDescriptor(
            windowID: 43, processID: 101, bundleID: window.bundleID,
            title: window.title, ownerName: window.ownerName, bounds: window.bounds
        )
        let revision = WriteCapabilityAuthorization.windowRevision(window)
        let previewHash = digest(["wechat-conversation-preview-v1", "刚发来的问题"])
        let lines = evidenceLines(preview: "刚发来的问题")
        let receipt = try WindowAccess.captureWechatIdentitySamples(
            windowID: window.windowID,
            expectedBundleID: window.bundleID,
            expectedTitle: window.title,
            expectedConversationTitle: "我",
            expectedPreviewHash: previewHash,
            expectedWindowRevision: revision,
            sampleCount: 3,
            windowListProvider: { _ in [window] },
            descriptorProvider: { _ in window },
            frameProvider: { _ in (try self.image(), lines) }
        )
        let enrollment = WechatIdentityEnrollmentPayload(
            version: 2,
            conversationId: nil,
            visibleName: nil,
            contactId: "contact-0123456789abcdef0123456789abcdef",
            displayName: "我",
            fingerprintVersion: receipt.fingerprintVersion,
            referenceSamples: receipt.referenceSamples,
            enrolledAt: "2026-08-31T00:00:00Z"
        )

        for phase in ["pre-click", "selected"] {
            var listCalls = 0
            var frameCalls = 0
            XCTAssertThrowsError(try WindowAccess.matchWechatIdentityRows(
                windowID: window.windowID,
                expectedBundleID: window.bundleID,
                expectedTitle: window.title,
                expectedConversationTitle: "我",
                proofPhase: phase,
                enrollment: enrollment,
                windowListProvider: { _ in
                    listCalls += 1
                    return listCalls == 4 ? [window, duplicate] : [window]
                },
                descriptorProvider: { _ in window },
                frameProvider: { _ in
                    frameCalls += 1
                    return (try self.image(), lines)
                },
                selectedRowProvider: { _, _ in
                    [WechatSelectedRowAttestation(title: "我", normalizedY: 0.79)]
                }
            )) { error in
                XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IDENTITY_SELECTION_CHANGED")
            }
            XCTAssertEqual(frameCalls, 1, "phase: \(phase)")
            XCTAssertEqual(listCalls, 4, "phase: \(phase)")
        }
    }

    func testFiveSamplesComputeAllTenPairsAndRejectAnyUnstablePair() throws {
        let window = testWindow()
        let revision = WriteCapabilityAuthorization.windowRevision(window)
        let previewHash = digest(["wechat-conversation-preview-v1", "刚发来的问题"])
        var pairCalls = 0
        let receipt = try WindowAccess.captureWechatIdentitySamples(
            windowID: window.windowID,
            expectedBundleID: "com.tencent.xinWeChat",
            expectedTitle: "微信",
            expectedConversationTitle: "我",
            expectedPreviewHash: previewHash,
            expectedWindowRevision: revision,
            sampleCount: 5,
            windowListProvider: { _ in [window] },
            descriptorProvider: { _ in window },
            frameProvider: { _ in (try self.image(), self.evidenceLines(preview: "刚发来的问题")) },
            distanceCalculator: { _, _ in
                pairCalls += 1
                return 0.02
            }
        )
        XCTAssertEqual(pairCalls, 10)
        XCTAssertEqual(receipt.maximumPairwiseDistance, 0.02)

        pairCalls = 0
        XCTAssertThrowsError(try WindowAccess.captureWechatIdentitySamples(
            windowID: window.windowID,
            expectedBundleID: "com.tencent.xinWeChat",
            expectedTitle: "微信",
            expectedConversationTitle: "我",
            expectedPreviewHash: previewHash,
            expectedWindowRevision: revision,
            sampleCount: 5,
            windowListProvider: { _ in [window] },
            descriptorProvider: { _ in window },
            frameProvider: { _ in (try self.image(), self.evidenceLines(preview: "刚发来的问题")) },
            distanceCalculator: { _, _ in
                pairCalls += 1
                return pairCalls == 10 ? 0.19 : 0.02
            }
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IDENTITY_SAMPLES_UNSTABLE")
        }
        XCTAssertEqual(pairCalls, 10)
    }

    func testStrictTransportDecodesOnlyTheBoundReadOnlyShape() throws {
        let payload: [String: Any] = [
            "windowID": 42,
            "bundleID": "com.tencent.xinWeChat",
            "title": "微信",
            "conversationTitle": "我",
            "expectedPreviewHash": String(repeating: "a", count: 64),
            "expectedWindowRevision": String(repeating: "b", count: 64),
            "sampleCount": 5,
        ]
        let body = try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "command": "capture-wechat-identity-samples",
            "payload": payload,
        ], options: [.sortedKeys])
        var length = UInt32(body.count).bigEndian
        var frame = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
        frame.append(body)

        guard case let .captureWechatIdentitySamples(_, bundle, title, conversation, _, _, count) =
            try SensitiveCommandTransport.decodeFrame(frame) else {
            return XCTFail("wrong command")
        }
        XCTAssertEqual(bundle, "com.tencent.xinWeChat")
        XCTAssertEqual(title, "微信")
        XCTAssertEqual(conversation, "我")
        XCTAssertEqual(count, 5)
    }

    private func evidenceLines(preview: String) -> [OCRLine] {
        [
            OCRLine(text: "我", confidence: 0.99, bounds: OCRBounds(x: 0.10, y: 0.78, width: 0.08, height: 0.02)),
            OCRLine(text: preview, confidence: 0.99, bounds: OCRBounds(x: 0.10, y: 0.73, width: 0.18, height: 0.02)),
            OCRLine(text: "我", confidence: 0.99, bounds: OCRBounds(x: 0.50, y: 0.90, width: 0.08, height: 0.02)),
        ]
    }

    private func testWindow() -> WindowDescriptor {
        WindowDescriptor(
            windowID: 42,
            processID: 100,
            bundleID: "com.tencent.xinWeChat",
            title: "微信",
            ownerName: "微信",
            bounds: OCRBounds(x: 0, y: 0, width: 700, height: 600)
        )
    }

    private func image() throws -> CGImage {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil, width: 128, height: 128, bitsPerComponent: 8, bytesPerRow: 0,
            space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { throw BridgeError("TEST_IMAGE_FAILED") }
        context.setFillColor(NSColor.systemBlue.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: 128, height: 128))
        guard let image = context.makeImage() else { throw BridgeError("TEST_IMAGE_FAILED") }
        return image
    }

    private func digest(_ components: [String]) -> String {
        SHA256.hash(data: Data(components.joined(separator: "\0").utf8))
            .map { String(format: "%02x", $0) }.joined()
    }
}
