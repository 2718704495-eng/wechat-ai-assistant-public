import XCTest
@testable import WechatVisionBridge

final class VersionTests: XCTestCase {
    func testVersionPayloadUsesProtocolVersionOne() throws {
        let data = try versionPayload()
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Int]

        XCTAssertEqual(object, ["protocolVersion": 1])
    }
}
