import Foundation
import XCTest
@testable import WechatVisionBridge

final class FixturesTests: XCTestCase {
    func testWindowCaptureUsesCGWindowAlignedImageWithoutShadow() {
        let outputURL = URL(fileURLWithPath: "/tmp/wechat-window.png")

        XCTAssertEqual(
            WindowCaptureCommand.arguments(windowID: 42, outputURL: outputURL),
            ["-x", "-o", "-l", "42", outputURL.path]
        )
    }

    func testRecognizesRedactedChineseFixtureWithConfidenceAndTopToBottomOrder() throws {
        let fixture = fixtureURL("wechat-redacted.png")

        let lines = try VisionOCR.recognize(fileURL: fixture)

        XCTAssertGreaterThanOrEqual(lines.count, 3)
        XCTAssertTrue(lines.contains { $0.text.contains("示例联系人") })
        XCTAssertTrue(lines.contains { $0.text.contains("今天上夜班") })
        XCTAssertTrue(lines.allSatisfy { $0.confidence > 0 && $0.confidence <= 1 })
        XCTAssertEqual(lines.map(\.bounds.y), lines.map(\.bounds.y).sorted(by: >))
    }

    func testSortsEqualHeightLinesFromLeftToRight() {
        let lines = [
            OCRLine(text: "右", confidence: 0.9, bounds: OCRBounds(x: 0.7, y: 0.5, width: 0.1, height: 0.1)),
            OCRLine(text: "左", confidence: 0.9, bounds: OCRBounds(x: 0.1, y: 0.5, width: 0.1, height: 0.1)),
        ]

        XCTAssertEqual(VisionOCR.sortTopToBottom(lines).map(\.text), ["左", "右"])
    }

    func testWriteAuthorizationRequiresAFullHexToken() throws {
        XCTAssertThrowsError(try WriteAuthorization.validate(token: nil))
        XCTAssertThrowsError(try WriteAuthorization.validate(token: "abcd"))
        XCTAssertNoThrow(try WriteAuthorization.validate(token: String(repeating: "a1", count: 32)))
    }

    func testWechatClickAuthorizationRestrictsWindowAndRegions() throws {
        XCTAssertNoThrow(try WechatClickAuthorization.validate(
            bundleID: "com.tencent.xinWeChat", title: "微信", region: "composer", x: 0.7, y: 0.82
        ))
        XCTAssertNoThrow(try WechatClickAuthorization.validate(
            bundleID: "com.tencent.xinWeChat", title: "微信", region: "conversation-list", x: 0.22, y: 0.18
        ))
        XCTAssertThrowsError(try WechatClickAuthorization.validate(
            bundleID: "com.apple.Safari", title: "微信", region: "composer", x: 0.7, y: 0.82
        ))
        XCTAssertThrowsError(try WechatClickAuthorization.validate(
            bundleID: "com.tencent.xinWeChat", title: "微信", region: "composer", x: 0.2, y: 0.2
        ))
    }

    func testConversationListGuardAllowsOnlyOneLowConfidenceFileTransferRow() {
        let truncatedFileTransfer = OCRLine(
            text: "文件传输⋯. 昨天 18:43",
            confidence: 0.30,
            bounds: OCRBounds(x: 0.20, y: 0.80, width: 0.14, height: 0.04)
        )

        XCTAssertTrue(ConversationListSelectionGuard.hasUniqueMatch(
            lines: [truncatedFileTransfer],
            expected: "文件传输助手",
            normalizedY: 0.18
        ))
        XCTAssertFalse(ConversationListSelectionGuard.hasUniqueMatch(
            lines: [truncatedFileTransfer, truncatedFileTransfer],
            expected: "文件传输助手",
            normalizedY: 0.18
        ))
        XCTAssertFalse(ConversationListSelectionGuard.hasUniqueMatch(
            lines: [OCRLine(
                text: "文件传输⋯. 昨天 18:43",
                confidence: 0.24,
                bounds: truncatedFileTransfer.bounds
            )],
            expected: "文件传输助手",
            normalizedY: 0.18
        ))
        XCTAssertFalse(ConversationListSelectionGuard.hasUniqueMatch(
            lines: [OCRLine(
                text: "文件传输助手",
                confidence: 1,
                bounds: OCRBounds(x: 0.315, y: 0.80, width: 0.14, height: 0.04)
            )],
            expected: "文件传输助手",
            normalizedY: 0.18
        ))
    }

    func testConversationListGuardAcceptsOneExactExampleContactLabelAtTheProductionConfidenceFloor() {
        let lowConfidenceExampleContact = OCRLine(
            text: "示例联系人",
            confidence: 0.49,
            bounds: OCRBounds(x: 0.20, y: 0.80, width: 0.10, height: 0.04)
        )
        let exactExampleContact = OCRLine(
            text: "示例联系人",
            confidence: 0.50,
            bounds: lowConfidenceExampleContact.bounds
        )

        XCTAssertFalse(ConversationListSelectionGuard.hasUniqueMatch(
            lines: [lowConfidenceExampleContact],
            expected: "示例联系人",
            normalizedY: 0.18
        ))
        XCTAssertTrue(ConversationListSelectionGuard.hasUniqueMatch(
            lines: [exactExampleContact],
            expected: "示例联系人",
            normalizedY: 0.18
        ))
        XCTAssertFalse(ConversationListSelectionGuard.hasUniqueMatch(
            lines: [exactExampleContact, exactExampleContact],
            expected: "示例联系人",
            normalizedY: 0.18
        ))
    }

    func testReadOnlyScrollAuthorizationRestrictsTargetAndMagnitude() throws {
        XCTAssertNoThrow(try ReadOnlyScrollAuthorization.validate(
            bundleID: "com.tencent.xinWeChat",
            title: "与“示例联系人”的聊天记录",
            deltaY: -600
        ))
        XCTAssertThrowsError(try ReadOnlyScrollAuthorization.validate(
            bundleID: "com.apple.Safari",
            title: "与“示例联系人”的聊天记录",
            deltaY: -600
        ))
        XCTAssertThrowsError(try ReadOnlyScrollAuthorization.validate(
            bundleID: "com.tencent.xinWeChat",
            title: "微信",
            deltaY: -600
        ))
        XCTAssertThrowsError(try ReadOnlyScrollAuthorization.validate(
            bundleID: "com.tencent.xinWeChat",
            title: "与“示例联系人”的聊天记录",
            deltaY: -5000
        ))
    }

    func testReadOnlyScrollbarDragAuthorizationAllowsOnlyDownwardTargetDrag() throws {
        XCTAssertNoThrow(try ReadOnlyScrollbarDragAuthorization.validate(
            bundleID: "com.tencent.xinWeChat",
            title: "与“示例联系人”的聊天记录",
            fromY: 340,
            toY: 600
        ))
        XCTAssertThrowsError(try ReadOnlyScrollbarDragAuthorization.validate(
            bundleID: "com.tencent.xinWeChat",
            title: "与“示例联系人”的聊天记录",
            fromY: 600,
            toY: 340
        ))
        XCTAssertThrowsError(try ReadOnlyScrollbarDragAuthorization.validate(
            bundleID: "com.apple.Safari",
            title: "抖音",
            fromY: 340,
            toY: 600
        ))
    }

    private func fixtureURL(_ filename: String) -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("../../../tests/fixtures")
            .standardizedFileURL
            .appendingPathComponent(filename)
    }
}
