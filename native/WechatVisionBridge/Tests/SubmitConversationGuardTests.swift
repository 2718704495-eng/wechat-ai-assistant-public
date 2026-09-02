import CryptoKit
import XCTest
@testable import WechatVisionBridge

final class SubmitConversationGuardTests: XCTestCase {
    private func header(_ text: String, confidence: Double = 0.99) -> OCRLine {
        OCRLine(
            text: text,
            confidence: confidence,
            bounds: OCRBounds(x: 0.40, y: 0.89, width: 0.20, height: 0.04)
        )
    }

    private func conversationListLabel(
        _ text: String,
        confidence: Double = 0.99,
        y: Double = 0.38
    ) -> OCRLine {
        OCRLine(
            text: text,
            confidence: confidence,
            bounds: OCRBounds(x: 0.14, y: y, width: 0.12, height: 0.04)
        )
    }

    func testAcceptsExactlyOneHighConfidenceAllowlistedHeader() {
        XCTAssertTrue(SubmitConversationGuard.hasUniqueHeader(
            lines: [header("文件传输助手")],
            expected: "文件传输助手"
        ))
        XCTAssertTrue(SubmitConversationGuard.hasUniqueHeader(
            lines: [header("示例联系人")],
            expected: "示例联系人"
        ))
    }

    func testRejectsMissingDuplicateLowConfidenceOrUnknownHeaders() {
        XCTAssertFalse(SubmitConversationGuard.hasUniqueHeader(lines: [], expected: "文件传输助手"))
        XCTAssertFalse(SubmitConversationGuard.hasUniqueHeader(
            lines: [header("文件传输助手"), header("文件传输助手")],
            expected: "文件传输助手"
        ))
        XCTAssertFalse(SubmitConversationGuard.hasUniqueHeader(
            lines: [header("文件传输助手", confidence: 0.89)],
            expected: "文件传输助手"
        ))
        XCTAssertFalse(SubmitConversationGuard.hasUniqueHeader(
            lines: [header("任意联系人")],
            expected: "任意联系人"
        ))
    }

    func testRejectsTheSameTextOutsideTheHeaderRegion() {
        let line = OCRLine(
            text: "文件传输助手",
            confidence: 0.99,
            bounds: OCRBounds(x: 0.20, y: 0.50, width: 0.20, height: 0.04)
        )
        XCTAssertFalse(SubmitConversationGuard.hasUniqueHeader(
            lines: [line],
            expected: "文件传输助手"
        ))
    }

    func testAcceptsTheModernSplitPaneHeaderAndRejectsTheIsolationBand() {
        let modernHeader = OCRLine(
            text: "文件传输助手",
            confidence: 1,
            bounds: OCRBounds(x: 0.3386, y: 0.9324, width: 0.115, height: 0.028)
        )
        let isolationBand = OCRLine(
            text: "文件传输助手",
            confidence: 1,
            bounds: OCRBounds(x: 0.315, y: 0.9324, width: 0.115, height: 0.028)
        )

        XCTAssertTrue(SubmitConversationGuard.hasUniqueHeader(
            lines: [modernHeader],
            expected: "文件传输助手"
        ))
        XCTAssertFalse(SubmitConversationGuard.hasUniqueHeader(
            lines: [isolationBand],
            expected: "文件传输助手"
        ))
    }

    func testAcceptsLossyExactHeaderOnlyWithOneHighConfidenceExactListLabel() {
        let lossyHeader = header("示例联系人", confidence: 0.50)
        let exactListLabel = conversationListLabel("示例联系人", confidence: 1)

        XCTAssertTrue(SubmitConversationGuard.hasUniqueHeader(
            lines: [lossyHeader, exactListLabel],
            expected: "示例联系人"
        ))
        XCTAssertFalse(SubmitConversationGuard.hasUniqueHeader(
            lines: [lossyHeader],
            expected: "示例联系人"
        ))
        XCTAssertFalse(SubmitConversationGuard.hasUniqueHeader(
            lines: [lossyHeader, exactListLabel, conversationListLabel("示例联系人", y: 0.48)],
            expected: "示例联系人"
        ))
        XCTAssertFalse(SubmitConversationGuard.hasUniqueHeader(
            lines: [lossyHeader, conversationListLabel("示例联系人", confidence: 0.89)],
            expected: "示例联系人"
        ))
    }

    func testFinalStateProofAcceptsOnlyTheExactLatestIncomingRevision() {
        let contactId = "contact-0123456789abcdef0123456789abcdef"
        let incoming = OCRLine(
            text: "还在吗",
            confidence: 0.99,
            bounds: OCRBounds(x: 0.40, y: 0.60, width: 0.12, height: 0.03)
        )
        let messageId = digest([contactId, "incoming", incoming.text].joined(separator: "\0"))
        let proof = SubmitConversationProofPayload(
            version: 1,
            latestMessageId: messageId,
            latestTextHash: digest(incoming.text),
            latestDirection: "incoming",
            controlRevision: digest("\(messageId)\0incoming")
        )

        XCTAssertTrue(SubmitConversationGuard.matchesFinalState(
            lines: [incoming], contactId: contactId, proof: proof
        ))

        let manualOutgoing = OCRLine(
            text: "我已经手动回复",
            confidence: 0.99,
            bounds: OCRBounds(x: 0.72, y: 0.50, width: 0.16, height: 0.03)
        )
        XCTAssertFalse(SubmitConversationGuard.matchesFinalState(
            lines: [incoming, manualOutgoing], contactId: contactId, proof: proof
        ))
        let stop = OCRLine(
            text: "STOP",
            confidence: 0.99,
            bounds: OCRBounds(x: 0.40, y: 0.50, width: 0.10, height: 0.03)
        )
        XCTAssertFalse(SubmitConversationGuard.matchesFinalState(
            lines: [incoming, stop], contactId: contactId, proof: proof
        ))
    }

    private func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
