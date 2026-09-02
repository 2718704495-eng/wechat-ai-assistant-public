import Foundation
import XCTest
@testable import WechatVisionBridge

final class SensitiveCommandTransportTests: XCTestCase {
    func testDecodesLengthFramedUTF8WithoutChangingBytes() throws {
        let text = "逐字节保留\r\n第二行\0🌙 ——示例用户"
        let token = String(repeating: "a1", count: 32)
        let capability: [String: Any] = [
            "version": 1,
            "capabilityId": token,
            "action": "replace-draft",
            "candidateHash": String(repeating: "b", count: 64),
            "slotHash": String(repeating: "c", count: 64),
            "identityFingerprint": String(repeating: "d", count: 64),
            "windowRevision": String(repeating: "e", count: 64),
            "expiresAt": "2026-08-24T00:10:00.000Z",
        ]
        let body = try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "command": "type-text",
            "payload": [
                "windowID": 42,
                "bundleID": "com.tencent.xinWeChat",
                "title": "微信",
                "conversationTitle": "示例联系人",
                "token": token,
                "slotKey": "2026-08-24/night",
                "text": text,
                "capability": capability,
            ],
        ], options: [.sortedKeys])
        let decoded = try SensitiveCommandTransport.decodeFrame(frame(body))

        guard case let .typeText(
            _, _, _, _, decodedToken, _, decodedText, decodedCapability
        ) = decoded else {
            return XCTFail("wrong command")
        }
        XCTAssertEqual(Data(decodedText.utf8), Data(text.utf8))
        XCTAssertEqual(decodedToken, token)
        XCTAssertEqual(decodedCapability.action, "replace-draft")
    }

    func testFailsClosedForEOFMalformedOversizeAndUnknownFields() throws {
        assertBridgeError(Data(), "SENSITIVE_REQUEST_EOF")
        assertBridgeError(Data([0, 0, 0]), "SENSITIVE_REQUEST_MALFORMED")

        var oversized = Data([0, 1, 0, 1])
        oversized.append(Data(repeating: 0, count: 65_537))
        assertBridgeError(oversized, "SENSITIVE_REQUEST_TOO_LARGE")

        let unknown = try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "command": "press-enter",
            "payload": ["token": String(repeating: "a1", count: 32), "extra": "forbidden"],
        ])
        assertBridgeError(frame(unknown), "SENSITIVE_REQUEST_MALFORMED")
    }

    func testReadsAValidFrameAcrossDeterministicPipeChunks() throws {
        let token = String(repeating: "a1", count: 32)
        let body = try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "command": "press-enter",
            "payload": ["token": token],
        ])
        var remaining = frame(body)

        let decoded = try SensitiveCommandTransport.readFrame { requested in
            guard !remaining.isEmpty else { return Data() }
            let count = min(requested, 2, remaining.count)
            let chunk = remaining.prefix(count)
            remaining.removeFirst(count)
            return Data(chunk)
        }

        XCTAssertEqual(decoded, .pressEnter(token: token))
    }

    func testDecodesOneBoundFileTransferImageAttachmentWithoutPathLeakage() throws {
        let token = String(repeating: "c3", count: 32)
        let imageHash = "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177"
        let slotHash = String(repeating: "d", count: 64)
        let body = try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "command": "attach-wechat-image",
            "payload": [
                "windowID": 42,
                "bundleID": "com.tencent.xinWeChat",
                "title": "微信",
                "conversationTitle": "文件传输助手",
                "token": token,
                "slotKey": "non-daily/\(slotHash)",
                "imagePath": "/tmp/reviewed-card.png",
                "imageSha256": imageHash,
                "width": 1080,
                "height": 1350,
                "capability": [
                    "version": 1,
                    "capabilityId": token,
                    "action": "attach-image",
                    "candidateHash": imageHash,
                    "slotHash": String(repeating: "e", count: 64),
                    "identityFingerprint": String(repeating: "f", count: 64),
                    "windowRevision": String(repeating: "a", count: 64),
                    "expiresAt": "2026-08-30T02:30:00.000Z",
                ],
            ],
        ], options: [.sortedKeys])

        XCTAssertNoThrow(try SensitiveCommandTransport.decodeFrame(frame(body)))
    }

    func testDecodesOneBoundComfortStationImageSend() throws {
        let token = String(repeating: "d4", count: 32)
        let imageHash = "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177"
        let body = try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "command": "send-wechat-image",
            "payload": [
                "windowID": 42,
                "bundleID": "com.tencent.xinWeChat",
                "title": "微信",
                "conversationTitle": "示例联系人",
                "token": token,
                "slotKey": "non-daily/\(String(repeating: "d", count: 64))",
                "imagePath": "/tmp/reviewed-card.png",
                "imageSha256": imageHash,
                "width": 1080,
                "height": 1350,
                "capability": [
                    "version": 1,
                    "capabilityId": token,
                    "action": "send-image",
                    "candidateHash": imageHash,
                    "slotHash": String(repeating: "e", count: 64),
                    "identityFingerprint": String(repeating: "f", count: 64),
                    "windowRevision": String(repeating: "a", count: 64),
                    "expiresAt": "2026-08-30T03:00:00.000Z",
                ],
            ],
        ], options: [.sortedKeys])

        guard case let .sendWechatImage(_, _, _, title, _, _, _, hash, width, height, capability) =
            try SensitiveCommandTransport.decodeFrame(frame(body)) else {
            return XCTFail("wrong command")
        }
        XCTAssertEqual(title, "示例联系人")
        XCTAssertEqual(hash, imageHash)
        XCTAssertEqual(width, 1080)
        XCTAssertEqual(height, 1350)
        XCTAssertEqual(capability.action, "send-image")
    }

    func testDecodesOnlyTheExactExampleContactImageQuarantineRecoveryShape() throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "command": "recover-wechat-image-quarantine",
            "payload": [
                "windowID": 42,
                "bundleID": "com.tencent.xinWeChat",
                "title": "微信",
                "conversationTitle": "示例联系人",
            ],
        ], options: [.sortedKeys])
        XCTAssertEqual(
            try SensitiveCommandTransport.decodeFrame(frame(body)),
            .recoverWechatImageQuarantine(
                windowID: 42,
                bundleID: "com.tencent.xinWeChat",
                title: "微信",
                conversationTitle: "示例联系人"
            )
        )
        var decoded = try JSONSerialization.jsonObject(with: body) as! [String: Any]
        var payload = decoded["payload"] as! [String: Any]
        payload["extra"] = true
        decoded["payload"] = payload
        let extra = try JSONSerialization.data(withJSONObject: decoded)
        assertBridgeError(frame(extra), "SENSITIVE_REQUEST_MALFORMED")
    }

    func testRejectsShapeOnlyNonceForPreliminaryMutations() throws {
        let token = String(repeating: "a1", count: 32)
        for (command, payload) in [
            ("type-text", ["text": "越权草稿", "token": token] as [String: Any]),
            ("click-wechat-point", [
                "windowID": 42,
                "bundleID": "com.tencent.xinWeChat",
                "title": "微信",
                "region": "composer",
                "normalizedX": 0.7,
                "normalizedY": 0.82,
                "token": token,
            ] as [String: Any]),
        ] {
            let body = try JSONSerialization.data(withJSONObject: [
                "version": 1,
                "command": command,
                "payload": payload,
            ])
            assertBridgeError(frame(body), "WRITE_CAPABILITY_REQUIRED")
        }
    }

    func testDynamicSubmitRequiresAnExactFinalConversationProof() throws {
        let token = String(repeating: "a", count: 64)
        let proof: [String: Any] = [
            "version": 1,
            "latestMessageId": String(repeating: "1", count: 64),
            "latestTextHash": String(repeating: "2", count: 64),
            "latestDirection": "incoming",
            "controlRevision": String(repeating: "3", count: 64),
        ]
        let capability: [String: Any] = [
            "version": 2, "capabilityId": token, "action": "submit-draft",
            "contactId": "contact-0123456789abcdef0123456789abcdef", "contactRevision": 1,
            "conversationTitle": "我", "enrollmentFingerprint": String(repeating: "4", count: 64),
            "bindingHash": String(repeating: "5", count: 64), "candidateHash": String(repeating: "6", count: 64),
            "slotHash": String(repeating: "7", count: 64), "windowRevision": String(repeating: "8", count: 64),
            "expiresAt": "2026-09-01T01:00:00.000Z", "authorizationMac": String(repeating: "9", count: 64),
            "requestBindingMac": String(repeating: "b", count: 64),
        ]
        let payload: [String: Any] = [
            "windowID": 42, "bundleID": "com.tencent.xinWeChat", "title": "微信",
            "conversationTitle": "我", "token": token,
            "slotKey": "non-daily/\(String(repeating: "c", count: 64))",
            "draftText": "测试", "conversationProof": proof, "capability": capability,
        ]
        let valid = try JSONSerialization.data(withJSONObject: [
            "version": 1, "command": "submit-wechat-draft", "payload": payload,
        ])
        XCTAssertNoThrow(try SensitiveCommandTransport.decodeFrame(frame(valid)))

        var missing = payload
        missing.removeValue(forKey: "conversationProof")
        let invalid = try JSONSerialization.data(withJSONObject: [
            "version": 1, "command": "submit-wechat-draft", "payload": missing,
        ])
        assertBridgeError(frame(invalid), "SENSITIVE_REQUEST_MALFORMED")
    }

    func testFixedV1SubmitRemainsCompatibleWithoutDynamicConversationProof() throws {
        let token = String(repeating: "a1", count: 32)
        let body = try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "command": "submit-wechat-draft",
            "payload": [
                "windowID": 42,
                "bundleID": "com.tencent.xinWeChat",
                "title": "微信",
                "conversationTitle": "示例联系人",
                "token": token,
                "slotKey": "2026-09-01/night",
                "draftText": "晚安",
                "capability": [
                    "version": 1,
                    "capabilityId": token,
                    "candidateHash": String(repeating: "b", count: 64),
                    "slotHash": String(repeating: "c", count: 64),
                    "identityFingerprint": String(repeating: "d", count: 64),
                    "windowRevision": String(repeating: "e", count: 64),
                    "expiresAt": "2026-09-01T01:00:00.000Z",
                ],
            ],
        ])

        guard case let .submitWechatDraft(_, _, _, _, _, _, _, proof, .v1(_)) =
            try SensitiveCommandTransport.decodeFrame(frame(body)) else {
            return XCTFail("wrong command")
        }
        XCTAssertNil(proof)
    }

    private func frame(_ body: Data) -> Data {
        var length = UInt32(body.count).bigEndian
        var result = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
        result.append(body)
        return result
    }

    private func assertBridgeError(
        _ input: Data,
        _ expected: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(try SensitiveCommandTransport.decodeFrame(input), file: file, line: line) { error in
            XCTAssertEqual((error as? BridgeError)?.code, expected, file: file, line: line)
        }
    }
}
