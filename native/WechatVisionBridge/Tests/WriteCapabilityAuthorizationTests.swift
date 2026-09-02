import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import WechatVisionBridge

private final class MemoryNativeTextCapabilityConsumptionStore:
    NativeTextCapabilityConsumptionStore {
    private var consumed = Set<String>()

    func consume(capabilityId: String, bindingDigest: String) throws {
        guard !consumed.contains(capabilityId) else {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        consumed.insert(capabilityId)
    }
}

private final class DirectorySyncRecorder {
    private let failingCall: Int?
    private(set) var synchronizedDirectoryIdentities: [String] = []

    init(failingCall: Int? = nil) {
        self.failingCall = failingCall
    }

    func synchronize(_ descriptor: Int32) -> Int32 {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else { return -1 }
        synchronizedDirectoryIdentities.append("\(metadata.st_dev):\(metadata.st_ino)")
        if synchronizedDirectoryIdentities.count == failingCall { return -1 }
        return fsync(descriptor)
    }
}

final class WriteCapabilityAuthorizationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_777_000_000)

    func testBindsAndConsumesCapabilityExactlyOnce() throws {
        let token = String(repeating: "a1", count: 32)
        let binding = makeBinding(token: token)

        XCTAssertNoThrow(try WriteCapabilityAuthorization.validateAndConsume(
            binding.capability,
            token: token,
            slotKey: binding.slotKey,
            draftText: binding.draft,
            conversationTitle: binding.conversationTitle,
            window: binding.window,
            now: now
        ))
        XCTAssertThrowsError(try WriteCapabilityAuthorization.validateAndConsume(
            binding.capability,
            token: token,
            slotKey: binding.slotKey,
            draftText: binding.draft,
            conversationTitle: binding.conversationTitle,
            window: binding.window,
            now: now
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WRITE_CAPABILITY_ALREADY_USED")
        }
    }

    func testRejectsCandidateSlotIdentityWindowAndExpiryDrift() throws {
        let binding = makeBinding(token: String(repeating: "b2", count: 32))
        let badHash = String(repeating: "f", count: 64)
        let mutations = [
            WriteCapabilityPayload(
                version: 1, capabilityId: binding.capability.capabilityId,
                candidateHash: badHash, slotHash: binding.capability.slotHash,
                identityFingerprint: binding.capability.identityFingerprint,
                windowRevision: binding.capability.windowRevision,
                expiresAt: binding.capability.expiresAt
            ),
            WriteCapabilityPayload(
                version: 1, capabilityId: binding.capability.capabilityId,
                candidateHash: binding.capability.candidateHash, slotHash: badHash,
                identityFingerprint: binding.capability.identityFingerprint,
                windowRevision: binding.capability.windowRevision,
                expiresAt: binding.capability.expiresAt
            ),
            WriteCapabilityPayload(
                version: 1, capabilityId: binding.capability.capabilityId,
                candidateHash: binding.capability.candidateHash, slotHash: binding.capability.slotHash,
                identityFingerprint: badHash,
                windowRevision: binding.capability.windowRevision,
                expiresAt: binding.capability.expiresAt
            ),
            WriteCapabilityPayload(
                version: 1, capabilityId: binding.capability.capabilityId,
                candidateHash: binding.capability.candidateHash, slotHash: binding.capability.slotHash,
                identityFingerprint: binding.capability.identityFingerprint,
                windowRevision: badHash,
                expiresAt: binding.capability.expiresAt
            ),
            WriteCapabilityPayload(
                version: 1, capabilityId: binding.capability.capabilityId,
                candidateHash: binding.capability.candidateHash, slotHash: binding.capability.slotHash,
                identityFingerprint: binding.capability.identityFingerprint,
                windowRevision: binding.capability.windowRevision,
                expiresAt: iso(now)
            ),
        ]

        for capability in mutations {
            XCTAssertThrowsError(try WriteCapabilityAuthorization.validateAndConsume(
                capability,
                token: binding.capability.capabilityId,
                slotKey: binding.slotKey,
                draftText: binding.draft,
                conversationTitle: binding.conversationTitle,
                window: binding.window,
                now: now
            ))
        }
    }

    func testAcceptsCanonicalNodeDynamicTextCapabilityFixtureAndConsumesItOnce() throws {
        let capability = dynamicCapability()
        let store = MemoryNativeTextCapabilityConsumptionStore()

        XCTAssertNoThrow(try DynamicTextTargetAuthorization.validateAndConsume(
            capability,
            key: Data((0..<32).map(UInt8.init)),
            expectedAction: "replace-draft",
            conversationTitle: "é小号",
            slotKey: "non-daily/\(String(repeating: "3", count: 64))",
            text: "回复 é\r\n第二行",
            window: dynamicWindow(),
            now: isoDate("2026-08-31T04:00:00.000Z"),
            consumptionStore: store
        ))
        XCTAssertThrowsError(try DynamicTextTargetAuthorization.validateAndConsume(
            capability,
            key: Data((0..<32).map(UInt8.init)),
            expectedAction: "replace-draft",
            conversationTitle: "é小号",
            slotKey: "non-daily/\(String(repeating: "3", count: 64))",
            text: "回复 é\n第二行",
            window: dynamicWindow(),
            now: isoDate("2026-08-31T04:00:00.000Z"),
            consumptionStore: store
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_CONTACT_CAPABILITY_INVALID")
        }
    }

    func testRejectsDynamicTextCapabilityTamperingWrongKeyExpiryAndNonNFC() throws {
        let valid = dynamicCapability()
        let badHash = String(repeating: "f", count: 64)
        let mutations = [
            DynamicTextTargetCapabilityPayload(
                version: 2, capabilityId: valid.capabilityId, action: valid.action,
                contactId: valid.contactId, contactRevision: 4,
                conversationTitle: valid.conversationTitle,
                enrollmentFingerprint: valid.enrollmentFingerprint,
                bindingHash: valid.bindingHash, candidateHash: valid.candidateHash,
                slotHash: valid.slotHash, windowRevision: valid.windowRevision,
                expiresAt: valid.expiresAt, authorizationMac: valid.authorizationMac
            ),
            DynamicTextTargetCapabilityPayload(
                version: 2, capabilityId: valid.capabilityId, action: valid.action,
                contactId: valid.contactId, contactRevision: valid.contactRevision,
                conversationTitle: "伪标题",
                enrollmentFingerprint: valid.enrollmentFingerprint,
                bindingHash: valid.bindingHash, candidateHash: valid.candidateHash,
                slotHash: valid.slotHash, windowRevision: valid.windowRevision,
                expiresAt: valid.expiresAt, authorizationMac: valid.authorizationMac
            ),
            DynamicTextTargetCapabilityPayload(
                version: 2, capabilityId: valid.capabilityId, action: valid.action,
                contactId: valid.contactId, contactRevision: valid.contactRevision,
                conversationTitle: valid.conversationTitle,
                enrollmentFingerprint: badHash,
                bindingHash: valid.bindingHash, candidateHash: valid.candidateHash,
                slotHash: valid.slotHash, windowRevision: valid.windowRevision,
                expiresAt: valid.expiresAt, authorizationMac: valid.authorizationMac
            ),
            DynamicTextTargetCapabilityPayload(
                version: 2, capabilityId: valid.capabilityId, action: valid.action,
                contactId: valid.contactId, contactRevision: valid.contactRevision,
                conversationTitle: valid.conversationTitle,
                enrollmentFingerprint: valid.enrollmentFingerprint,
                bindingHash: valid.bindingHash, candidateHash: valid.candidateHash,
                slotHash: valid.slotHash, windowRevision: badHash,
                expiresAt: valid.expiresAt, authorizationMac: valid.authorizationMac
            ),
            DynamicTextTargetCapabilityPayload(
                version: 2, capabilityId: valid.capabilityId, action: valid.action,
                contactId: valid.contactId, contactRevision: valid.contactRevision,
                conversationTitle: "e" + String(UnicodeScalar(0x0301)!) + "小号",
                enrollmentFingerprint: valid.enrollmentFingerprint,
                bindingHash: valid.bindingHash, candidateHash: valid.candidateHash,
                slotHash: valid.slotHash, windowRevision: valid.windowRevision,
                expiresAt: valid.expiresAt, authorizationMac: valid.authorizationMac
            ),
        ]

        for capability in mutations {
            XCTAssertThrowsError(try validateDynamic(capability)) { error in
                XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_CONTACT_CAPABILITY_INVALID")
            }
        }
        XCTAssertThrowsError(try DynamicTextTargetAuthorization.validateAndConsume(
            valid,
            key: Data(repeating: 0xff, count: 32),
            expectedAction: "replace-draft",
            conversationTitle: valid.conversationTitle,
            slotKey: "non-daily/\(String(repeating: "3", count: 64))",
            text: "回复 é\n第二行",
            window: dynamicWindow(),
            now: isoDate("2026-08-31T04:00:00.000Z"),
            consumptionStore: MemoryNativeTextCapabilityConsumptionStore()
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        XCTAssertThrowsError(try DynamicTextTargetAuthorization.validateAndConsume(
            valid,
            key: Data((0..<32).map(UInt8.init)),
            expectedAction: "replace-draft",
            conversationTitle: valid.conversationTitle,
            slotKey: "non-daily/\(String(repeating: "3", count: 64))",
            text: "回复 é\n第二行",
            window: dynamicWindow(),
            now: isoDate(valid.expiresAt),
            consumptionStore: MemoryNativeTextCapabilityConsumptionStore()
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_CONTACT_CAPABILITY_INVALID")
        }
    }

    func testRejectsDynamicTextCapabilityWithWrongLengthKey() {
        XCTAssertThrowsError(try DynamicTextTargetAuthorization.validateAndConsume(
            dynamicCapability(),
            key: Data(repeating: 0, count: 31),
            expectedAction: "replace-draft",
            conversationTitle: "é小号",
            slotKey: "non-daily/\(String(repeating: "3", count: 64))",
            text: "回复 é\n第二行",
            window: dynamicWindow(),
            now: isoDate("2026-08-31T04:00:00.000Z"),
            consumptionStore: MemoryNativeTextCapabilityConsumptionStore()
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_CONTACT_CAPABILITY_INVALID")
        }
    }

    func testDecodesOnlyCanonicalBase64KeychainRepresentation() throws {
        let raw = Data((0..<32).map(UInt8.init))
        let encoded = Data(raw.base64EncodedString().utf8)

        XCTAssertEqual(try DynamicTextTargetAuthorization.decodeKeychainKey(encoded), raw)
        XCTAssertThrowsError(try DynamicTextTargetAuthorization.decodeKeychainKey(Data("not base64".utf8)))
        XCTAssertThrowsError(try DynamicTextTargetAuthorization.decodeKeychainKey(
            Data(Data(repeating: 0, count: 31).base64EncodedString().utf8)
        ))
    }

    func testStrictlyDecodesV2EnrollmentInAFramedIdentityCommand() throws {
        let enrollment: [String: Any] = [
            "version": 2,
            "contactId": "contact-0123456789abcdef0123456789abcdef",
            "displayName": "我",
            "fingerprintVersion": "vision-featureprint-v1",
            "referenceSamples": ["c2FtcGxlMQ==", "c2FtcGxlMg==", "c2FtcGxlMw=="],
            "enrolledAt": "2026-08-31T03:00:00.000Z",
        ]
        let payload: [String: Any] = [
            "windowID": 42,
            "bundleID": "com.tencent.xinWeChat",
            "title": "微信",
            "conversationTitle": "我",
            "proofPhase": "pre-click",
            "enrollment": enrollment,
        ]
        let body = try JSONSerialization.data(withJSONObject: [
            "version": 1,
            "command": "match-wechat-identity",
            "payload": payload,
        ])
        var frame = Data([0, 0, 0, 0])
        frame[0] = UInt8((body.count >> 24) & 0xff)
        frame[1] = UInt8((body.count >> 16) & 0xff)
        frame[2] = UInt8((body.count >> 8) & 0xff)
        frame[3] = UInt8(body.count & 0xff)
        frame.append(body)

        guard case let .matchWechatIdentity(_, _, _, title, proofPhase, enrollmentPayload) =
            try SensitiveCommandTransport.decodeFrame(frame) else {
            return XCTFail("expected v2 identity command")
        }
        XCTAssertEqual(title, "我")
        XCTAssertEqual(proofPhase, "pre-click")
        XCTAssertEqual(enrollmentPayload.version, 2)
        XCTAssertEqual(enrollmentPayload.contactId, "contact-0123456789abcdef0123456789abcdef")
        XCTAssertEqual(enrollmentPayload.displayName, "我")
    }

    func testAcceptsLegacyExampleContactContactIDOnlyWhenItMatchesTheMAC() throws {
        let unsigned = [
            "wechat-native-text-target-capability", "2", "2", String(repeating: "66", count: 32),
            "replace-draft", "example-contact", "3", "é小号", String(repeating: "1", count: 64),
            String(repeating: "2", count: 64),
            "bae79ae779df36322566b7173c17d0373440fed453d82083a63ffc8bbfa76975",
            "d04a67fae257299f6c22a4594bb37d14c847c70926ca701fd77d0e9cf3993728",
            "013bc50c91aeebcdf9c7de6b1dc533f624379a0e0ca3fd4e8dc859f4cc2d2e05",
            "2026-08-31T04:02:00.000Z",
        ].joined(separator: "\0")
        let mac = HMAC<SHA256>.authenticationCode(
            for: Data(unsigned.utf8),
            using: SymmetricKey(data: Data((0..<32).map(UInt8.init)))
        ).map { String(format: "%02x", $0) }.joined()
        let legacy = DynamicTextTargetCapabilityPayload(
            version: 2, capabilityId: String(repeating: "66", count: 32), action: "replace-draft",
            contactId: "example-contact", contactRevision: 3, conversationTitle: "é小号",
            enrollmentFingerprint: String(repeating: "1", count: 64), bindingHash: String(repeating: "2", count: 64),
            candidateHash: "bae79ae779df36322566b7173c17d0373440fed453d82083a63ffc8bbfa76975",
            slotHash: "d04a67fae257299f6c22a4594bb37d14c847c70926ca701fd77d0e9cf3993728",
            windowRevision: "013bc50c91aeebcdf9c7de6b1dc533f624379a0e0ca3fd4e8dc859f4cc2d2e05",
            expiresAt: "2026-08-31T04:02:00.000Z", authorizationMac: mac
        )
        XCTAssertNoThrow(try validateDynamic(legacy))
        XCTAssertThrowsError(try validateDynamic(DynamicTextTargetCapabilityPayload(
            version: legacy.version, capabilityId: legacy.capabilityId, action: legacy.action,
            contactId: "contact-0123456789abcdef0123456789abcdef", contactRevision: legacy.contactRevision,
            conversationTitle: legacy.conversationTitle, enrollmentFingerprint: legacy.enrollmentFingerprint,
            bindingHash: legacy.bindingHash, candidateHash: legacy.candidateHash, slotHash: legacy.slotHash,
            windowRevision: legacy.windowRevision, expiresAt: legacy.expiresAt, authorizationMac: legacy.authorizationMac
        )))
    }

    func testFileDynamicCapabilityStoreConsumesOnlyOnceAcrossInstances() throws {
        let anchor = FileManager.default.temporaryDirectory
            .appendingPathComponent("dynamic-capability-store-\(UUID().uuidString)", isDirectory: true)
        let components = ["WechatVisionBridge", "native-text-capabilities"]
        let root = anchor.appendingPathComponent(components[0]).appendingPathComponent(components[1])
        defer { try? FileManager.default.removeItem(at: anchor) }
        try FileManager.default.createDirectory(at: anchor, withIntermediateDirectories: true)
        let first = FileNativeTextCapabilityConsumptionStore(anchorURL: anchor, relativeComponents: components)
        let second = FileNativeTextCapabilityConsumptionStore(anchorURL: anchor, relativeComponents: components)

        let capabilityId = String(repeating: "aa", count: 32)
        let bindingDigest = String(repeating: "bb", count: 32)
        XCTAssertNoThrow(try first.consume(capabilityId: capabilityId, bindingDigest: bindingDigest))
        XCTAssertThrowsError(try second.consume(capabilityId: capabilityId, bindingDigest: bindingDigest)) {
            XCTAssertEqual((($0 as? BridgeError)?.code), "WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        let receipt = root.appendingPathComponent(capabilityId)
        XCTAssertEqual(try String(contentsOf: receipt, encoding: .utf8), bindingDigest)
        let permissions = try FileManager.default.attributesOfItem(atPath: receipt.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual((permissions?.intValue ?? -1) & 0o777, 0o600)
        for component in [anchor.appendingPathComponent(components[0]), root] {
            let attributes = try FileManager.default.attributesOfItem(atPath: component.path)
            XCTAssertEqual(((attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1) & 0o777, 0o700)
            XCTAssertEqual((attributes[.ownerAccountID] as? NSNumber)?.intValue, Int(getuid()))
        }
    }

    func testFileDynamicCapabilityStorePersistsEachNewDirectoryParentBeforeWritingReceipt() throws {
        let anchor = FileManager.default.temporaryDirectory
            .appendingPathComponent("dynamic-capability-directory-fsync-\(UUID().uuidString)", isDirectory: true)
        let components = ["WechatVisionBridge", "native-text-capabilities"]
        let intermediate = anchor.appendingPathComponent(components[0], isDirectory: true)
        let root = intermediate.appendingPathComponent(components[1], isDirectory: true)
        defer { try? FileManager.default.removeItem(at: anchor) }
        try FileManager.default.createDirectory(at: anchor, withIntermediateDirectories: true)
        let recorder = DirectorySyncRecorder()
        let capabilityId = String(repeating: "fa", count: 32)
        let bindingDigest = String(repeating: "fb", count: 32)

        try FileNativeTextCapabilityConsumptionStore(
            anchorURL: anchor,
            relativeComponents: components,
            directorySynchronizer: recorder.synchronize
        ).consume(capabilityId: capabilityId, bindingDigest: bindingDigest)

        XCTAssertEqual(recorder.synchronizedDirectoryIdentities, [
            try directoryIdentity(at: anchor),
            try directoryIdentity(at: intermediate),
            try directoryIdentity(at: root),
        ])
        XCTAssertEqual(try String(
            contentsOf: root.appendingPathComponent(capabilityId),
            encoding: .utf8
        ), bindingDigest)
    }

    func testFileDynamicCapabilityStoreRetriesAnchorSyncBeforeAuthorizingAfterFirstParentSyncFailure() throws {
        let anchor = FileManager.default.temporaryDirectory
            .appendingPathComponent("dynamic-capability-anchor-fsync-retry-\(UUID().uuidString)", isDirectory: true)
        let components = ["WechatVisionBridge", "native-text-capabilities"]
        let intermediate = anchor.appendingPathComponent(components[0], isDirectory: true)
        let root = intermediate.appendingPathComponent(components[1], isDirectory: true)
        let capabilityId = String(repeating: "fc", count: 32)
        let bindingDigest = String(repeating: "fe", count: 32)
        defer { try? FileManager.default.removeItem(at: anchor) }
        try FileManager.default.createDirectory(at: anchor, withIntermediateDirectories: true)
        let recorder = DirectorySyncRecorder(failingCall: 1)
        let store = FileNativeTextCapabilityConsumptionStore(
            anchorURL: anchor,
            relativeComponents: components,
            directorySynchronizer: recorder.synchronize
        )

        XCTAssertThrowsError(try store.consume(capabilityId: capabilityId, bindingDigest: bindingDigest)) {
            XCTAssertEqual(($0 as? BridgeError)?.code, "WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(capabilityId).path))
        XCTAssertNoThrow(try store.consume(capabilityId: capabilityId, bindingDigest: bindingDigest))
        XCTAssertEqual(recorder.synchronizedDirectoryIdentities, [
            try directoryIdentity(at: anchor),
            try directoryIdentity(at: anchor),
            try directoryIdentity(at: intermediate),
            try directoryIdentity(at: root),
        ])
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent(capabilityId), encoding: .utf8), bindingDigest)
        XCTAssertThrowsError(try store.consume(capabilityId: capabilityId, bindingDigest: bindingDigest))
    }

    func testFileDynamicCapabilityStoreRetriesAllParentsAfterSecondParentSyncFailure() throws {
        let anchor = FileManager.default.temporaryDirectory
            .appendingPathComponent("dynamic-capability-intermediate-fsync-retry-\(UUID().uuidString)", isDirectory: true)
        let components = ["WechatVisionBridge", "native-text-capabilities"]
        let intermediate = anchor.appendingPathComponent(components[0], isDirectory: true)
        let root = intermediate.appendingPathComponent(components[1], isDirectory: true)
        let capabilityId = String(repeating: "fd", count: 32)
        let bindingDigest = String(repeating: "fe", count: 32)
        defer { try? FileManager.default.removeItem(at: anchor) }
        try FileManager.default.createDirectory(at: anchor, withIntermediateDirectories: true)
        let recorder = DirectorySyncRecorder(failingCall: 2)
        let store = FileNativeTextCapabilityConsumptionStore(
            anchorURL: anchor,
            relativeComponents: components,
            directorySynchronizer: recorder.synchronize
        )

        XCTAssertThrowsError(try store.consume(capabilityId: capabilityId, bindingDigest: bindingDigest)) {
            XCTAssertEqual(($0 as? BridgeError)?.code, "WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(capabilityId).path))
        XCTAssertNoThrow(try store.consume(capabilityId: capabilityId, bindingDigest: bindingDigest))
        XCTAssertEqual(recorder.synchronizedDirectoryIdentities, [
            try directoryIdentity(at: anchor),
            try directoryIdentity(at: intermediate),
            try directoryIdentity(at: anchor),
            try directoryIdentity(at: intermediate),
            try directoryIdentity(at: root),
        ])
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent(capabilityId), encoding: .utf8), bindingDigest)
        XCTAssertThrowsError(try store.consume(capabilityId: capabilityId, bindingDigest: bindingDigest))
    }

    func testFileDynamicCapabilityStoreSynchronizesEveryDirectoryWhenDirectoriesAlreadyExist() throws {
        let anchor = FileManager.default.temporaryDirectory
            .appendingPathComponent("dynamic-capability-existing-directory-fsync-\(UUID().uuidString)", isDirectory: true)
        let components = ["WechatVisionBridge", "native-text-capabilities"]
        let root = anchor.appendingPathComponent(components[0], isDirectory: true)
            .appendingPathComponent(components[1], isDirectory: true)
        defer { try? FileManager.default.removeItem(at: anchor) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [
            .posixPermissions: 0o700,
        ])
        let recorder = DirectorySyncRecorder()

        try FileNativeTextCapabilityConsumptionStore(
            anchorURL: anchor,
            relativeComponents: components,
            directorySynchronizer: recorder.synchronize
        ).consume(
            capabilityId: String(repeating: "ff", count: 32),
            bindingDigest: String(repeating: "ab", count: 32)
        )

        XCTAssertEqual(recorder.synchronizedDirectoryIdentities, [
            try directoryIdentity(at: anchor),
            try directoryIdentity(at: anchor.appendingPathComponent(components[0], isDirectory: true)),
            try directoryIdentity(at: root),
        ])
    }

    func testFileDynamicCapabilityStoreAtomicallyAllowsOnlyOneConcurrentInstance() throws {
        let anchor = FileManager.default.temporaryDirectory
            .appendingPathComponent("dynamic-capability-race-\(UUID().uuidString)", isDirectory: true)
        let components = ["WechatVisionBridge", "native-text-capabilities"]
        let root = anchor.appendingPathComponent(components[0]).appendingPathComponent(components[1])
        defer { try? FileManager.default.removeItem(at: anchor) }
        try FileManager.default.createDirectory(at: anchor, withIntermediateDirectories: true)
        let capabilityId = String(repeating: "cc", count: 32)
        let bindingDigest = String(repeating: "dd", count: 32)
        let resultLock = NSLock()
        var successes = 0
        let group = DispatchGroup()
        for _ in 0..<12 {
            group.enter()
            DispatchQueue.global().async {
                defer { group.leave() }
                do {
                    try FileNativeTextCapabilityConsumptionStore(
                        anchorURL: anchor,
                        relativeComponents: components
                    ).consume(
                        capabilityId: capabilityId,
                        bindingDigest: bindingDigest
                    )
                    resultLock.lock()
                    successes += 1
                    resultLock.unlock()
                } catch { }
            }
        }
        group.wait()
        XCTAssertEqual(successes, 1)
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent(capabilityId), encoding: .utf8), bindingDigest)
    }

    func testFileDynamicCapabilityStoreRejectsSymlinkRootsAndReceipts() throws {
        let parent = FileManager.default.temporaryDirectory
            .appendingPathComponent("dynamic-capability-symlink-\(UUID().uuidString)", isDirectory: true)
        let root = parent.appendingPathComponent("root", isDirectory: true)
        let outside = parent.appendingPathComponent("outside", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: root.path, withDestinationPath: outside.path)
        XCTAssertThrowsError(try FileNativeTextCapabilityConsumptionStore(
            anchorURL: parent,
            relativeComponents: ["root"]
        ).consume(
            capabilityId: String(repeating: "ee", count: 32), bindingDigest: String(repeating: "ff", count: 32)
        ))

        try FileManager.default.removeItem(at: root)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let receipt = root.appendingPathComponent(String(repeating: "ee", count: 32))
        try FileManager.default.createSymbolicLink(atPath: receipt.path, withDestinationPath: outside.path)
        XCTAssertThrowsError(try FileNativeTextCapabilityConsumptionStore(
            anchorURL: parent,
            relativeComponents: ["root"]
        ).consume(
            capabilityId: String(repeating: "ee", count: 32), bindingDigest: String(repeating: "ff", count: 32)
        ))
    }

    func testFileDynamicCapabilityStoreRejectsASymlinkedIntermediateDirectory() throws {
        let anchor = FileManager.default.temporaryDirectory
            .appendingPathComponent("dynamic-capability-intermediate-symlink-\(UUID().uuidString)", isDirectory: true)
        let outside = FileManager.default.temporaryDirectory
            .appendingPathComponent("dynamic-capability-intermediate-outside-\(UUID().uuidString)", isDirectory: true)
        defer {
            try? FileManager.default.removeItem(at: anchor)
            try? FileManager.default.removeItem(at: outside)
        }
        try FileManager.default.createDirectory(at: anchor, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            atPath: anchor.appendingPathComponent("WechatVisionBridge").path,
            withDestinationPath: outside.path
        )

        XCTAssertThrowsError(try FileNativeTextCapabilityConsumptionStore(
            anchorURL: anchor,
            relativeComponents: ["WechatVisionBridge", "native-text-capabilities"]
        ).consume(capabilityId: String(repeating: "ef", count: 32), bindingDigest: String(repeating: "01", count: 32)))
    }

    func testFileDynamicCapabilityStoreRejectsUnsafeExistingDirectoryPermissions() throws {
        let anchor = FileManager.default.temporaryDirectory
            .appendingPathComponent("dynamic-capability-permissions-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: anchor) }
        let intermediate = anchor.appendingPathComponent("WechatVisionBridge", isDirectory: true)
        try FileManager.default.createDirectory(at: intermediate, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o755])
        XCTAssertThrowsError(try FileNativeTextCapabilityConsumptionStore(
            anchorURL: anchor,
            relativeComponents: ["WechatVisionBridge", "native-text-capabilities"]
        ).consume(capabilityId: String(repeating: "ab", count: 32), bindingDigest: String(repeating: "cd", count: 32)))
    }

    func testRejectsNonCanonicalDynamicExpiryForms() throws {
        let valid = dynamicCapability()
        for expiresAt in [
            "2026-08-31T04:02:00Z",
            "2026-08-31T12:02:00.000+08:00",
            " 2026-08-31T04:02:00.000Z",
            "2026-08-31T04:02:00.000Z ",
        ] {
            let altered = DynamicTextTargetCapabilityPayload(
                version: valid.version, capabilityId: valid.capabilityId, action: valid.action,
                contactId: valid.contactId, contactRevision: valid.contactRevision,
                conversationTitle: valid.conversationTitle, enrollmentFingerprint: valid.enrollmentFingerprint,
                bindingHash: valid.bindingHash, candidateHash: valid.candidateHash, slotHash: valid.slotHash,
                windowRevision: valid.windowRevision, expiresAt: expiresAt, authorizationMac: valid.authorizationMac
            )
            XCTAssertThrowsError(try validateDynamic(altered))
        }
    }

    func testDynamicNativeWritePathsRejectAMismatchedTokenBeforeAccessibilityOrConsumption() throws {
        let capability = dynamicCapability()
        let wrongToken = String(repeating: "99", count: 32)
        let window = dynamicWindow()
        let slotKey = "non-daily/\(String(repeating: "3", count: 64))"

        XCTAssertThrowsError(try WindowAccess.typeText(
            "回复 é\n第二行", windowID: window.windowID, expectedBundleID: window.bundleID,
            expectedTitle: window.title, expectedConversationTitle: capability.conversationTitle,
            writeToken: wrongToken, slotKey: slotKey, capability: .dynamic(capability)
        )) { XCTAssertEqual(($0 as? BridgeError)?.code, "WECHAT_CONTACT_CAPABILITY_INVALID") }
        XCTAssertThrowsError(try WindowAccess.submitWechatDraft(
            windowID: window.windowID, expectedBundleID: window.bundleID, expectedTitle: window.title,
            expectedConversationTitle: capability.conversationTitle, writeToken: wrongToken,
            slotKey: slotKey, expectedDraftText: "回复 é\n第二行",
            conversationProof: SubmitConversationProofPayload(
                version: 1,
                latestMessageId: String(repeating: "1", count: 64),
                latestTextHash: String(repeating: "2", count: 64),
                latestDirection: "incoming",
                controlRevision: String(repeating: "3", count: 64)
            ),
            capability: .dynamic(capability)
        )) { XCTAssertEqual(($0 as? BridgeError)?.code, "WECHAT_CONTACT_CAPABILITY_INVALID") }
        XCTAssertThrowsError(try WindowAccess.clickWechatPoint(
            windowID: window.windowID, expectedBundleID: window.bundleID, expectedTitle: window.title,
            region: "conversation-list", normalizedX: 0.22, normalizedY: 0.44,
            writeToken: wrongToken, expectedConversationTitle: capability.conversationTitle,
            slotKey: slotKey, capability: .dynamic(capability)
        )) { XCTAssertEqual(($0 as? BridgeError)?.code, "WECHAT_CONTACT_CAPABILITY_INVALID") }
    }

    func testConsumesOneFileTransferImageCapabilityAndRejectsTargetOrHashDrift() throws {
        let receiptRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("image-capability-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: receiptRoot) }
        let consumptionStore = FileImageAttachmentCapabilityConsumptionStore(rootURL: receiptRoot)
        let token = String(repeating: "c3", count: 32)
        let slotKey = "non-daily/\(sha256(token))"
        let window = WindowDescriptor(
            windowID: 42,
            processID: 100,
            bundleID: "com.tencent.xinWeChat",
            title: "微信",
            ownerName: "WeChat",
            bounds: OCRBounds(x: 0, y: 0, width: 1200, height: 800)
        )
        let imageHash = "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177"
        let revision = WriteCapabilityAuthorization.windowRevision(window)
        let capability = MutationCapabilityPayload(
            version: 1,
            capabilityId: token,
            action: "attach-image",
            candidateHash: imageHash,
            slotHash: sha256(slotKey),
            identityFingerprint: WriteCapabilityAuthorization.titleIdentityFingerprint(
                "文件传输助手",
                windowRevision: revision
            ),
            windowRevision: revision,
            expiresAt: iso(now.addingTimeInterval(120))
        )

        XCTAssertNoThrow(try ImageAttachmentCapabilityAuthorization.validateAndConsume(
            capability,
            token: token,
            slotKey: slotKey,
            imageSha256: imageHash,
            conversationTitle: "文件传输助手",
            window: window,
            now: now,
            consumptionStore: consumptionStore
        ))
        XCTAssertThrowsError(try ImageAttachmentCapabilityAuthorization.validateAndConsume(
            capability,
            token: token,
            slotKey: slotKey,
            imageSha256: imageHash,
            conversationTitle: "文件传输助手",
            window: window,
            now: now,
            consumptionStore: consumptionStore
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WRITE_CAPABILITY_ALREADY_USED")
        }
        XCTAssertThrowsError(try ImageAttachmentCapabilityAuthorization.validateAndConsume(
            MutationCapabilityPayload(
                version: capability.version,
                capabilityId: String(repeating: "d4", count: 32),
                action: capability.action,
                candidateHash: capability.candidateHash,
                slotHash: capability.slotHash,
                identityFingerprint: capability.identityFingerprint,
                windowRevision: capability.windowRevision,
                expiresAt: capability.expiresAt
            ),
            token: String(repeating: "d4", count: 32),
            slotKey: slotKey,
            imageSha256: imageHash,
            conversationTitle: "示例联系人",
            window: window,
            now: now,
            consumptionStore: consumptionStore
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WECHAT_IMAGE_ATTACHMENT_TARGET_NOT_ALLOWED")
        }
    }

    func testRejectsAnEnrollmentFingerprintBeforeImageAttachmentFocus() throws {
        let receiptRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("image-identity-focus-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: receiptRoot) }
        let store = FileImageAttachmentCapabilityConsumptionStore(rootURL: receiptRoot)
        let token = String(repeating: "e5", count: 32)
        let slotKey = "non-daily/\(sha256(token))"
        let window = WindowDescriptor(
            windowID: 42,
            processID: 100,
            bundleID: "com.tencent.xinWeChat",
            title: "微信",
            ownerName: "WeChat",
            bounds: OCRBounds(x: 0, y: 0, width: 1200, height: 800)
        )
        let imageHash = "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177"
        let revision = WriteCapabilityAuthorization.windowRevision(window)
        let capability = MutationCapabilityPayload(
            version: 1,
            capabilityId: token,
            action: "attach-image",
            candidateHash: imageHash,
            slotHash: sha256(slotKey),
            identityFingerprint: sha256("synthetic-enrollment-fingerprint"),
            windowRevision: revision,
            expiresAt: iso(now.addingTimeInterval(120))
        )
        var focusCount = 0

        XCTAssertThrowsError(try ImageAttachmentAdmission.authorizeThenFocus(
            assertHeader: {},
            consumeCapability: {
                try ImageAttachmentCapabilityAuthorization.validateAndConsume(
                    capability,
                    token: token,
                    slotKey: slotKey,
                    imageSha256: imageHash,
                    conversationTitle: "文件传输助手",
                    window: window,
                    now: now,
                    consumptionStore: store
                )
            },
            focus: { focusCount += 1 },
            reassertHeader: {}
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WRITE_CAPABILITY_IDENTITY_MISMATCH")
        }
        XCTAssertEqual(focusCount, 0)
    }

    func testBindsAndConsumesOneComfortStationImageSendCapability() throws {
        let receiptRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("image-send-capability-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: receiptRoot) }
        let store = FileImageAttachmentCapabilityConsumptionStore(rootURL: receiptRoot)
        let token = String(repeating: "f6", count: 32)
        let slotKey = "non-daily/\(sha256("comfort-station-delivery"))"
        let window = WindowDescriptor(
            windowID: 42,
            processID: 100,
            bundleID: "com.tencent.xinWeChat",
            title: "微信",
            ownerName: "WeChat",
            bounds: OCRBounds(x: 0, y: 0, width: 1200, height: 800)
        )
        let imageHash = "3e72282a6fa81c14eb12f10ee68f9e4c8f63eebe1ca8802f9859974658075177"
        let revision = WriteCapabilityAuthorization.windowRevision(window)
        let capability = MutationCapabilityPayload(
            version: 1,
            capabilityId: token,
            action: "send-image",
            candidateHash: imageHash,
            slotHash: sha256(slotKey),
            identityFingerprint: WriteCapabilityAuthorization.titleIdentityFingerprint(
                "示例联系人",
                windowRevision: revision
            ),
            windowRevision: revision,
            expiresAt: iso(now.addingTimeInterval(120))
        )

        XCTAssertNoThrow(try ImageSendCapabilityAuthorization.validateAndConsume(
            capability,
            token: token,
            slotKey: slotKey,
            imageSha256: imageHash,
            conversationTitle: "示例联系人",
            window: window,
            now: now,
            consumptionStore: store
        ))
        XCTAssertThrowsError(try ImageSendCapabilityAuthorization.validateAndConsume(
            capability,
            token: token,
            slotKey: slotKey,
            imageSha256: imageHash,
            conversationTitle: "示例联系人",
            window: window,
            now: now,
            consumptionStore: store
        )) { error in
            XCTAssertEqual((error as? BridgeError)?.code, "WRITE_CAPABILITY_ALREADY_USED")
        }
    }

    private func makeBinding(token: String) -> (
        capability: WriteCapabilityPayload,
        slotKey: String,
        draft: String,
        conversationTitle: String,
        window: WindowDescriptor
    ) {
        let slotKey = "2026-08-23/night"
        let draft = "正文\r\n——示例用户"
        let conversationTitle = "示例联系人"
        let window = WindowDescriptor(
            windowID: 42,
            processID: 100,
            bundleID: "com.tencent.xinWeChat",
            title: "微信",
            ownerName: "WeChat",
            bounds: OCRBounds(x: 0, y: 0, width: 1200, height: 800)
        )
        return (
            WriteCapabilityPayload(
                version: 1,
                capabilityId: token,
                candidateHash: sha256("正文\n——示例用户"),
                slotHash: sha256(slotKey),
                identityFingerprint: WriteCapabilityAuthorization.titleIdentityFingerprint(
                    conversationTitle,
                    windowRevision: WriteCapabilityAuthorization.windowRevision(window)
                ),
                windowRevision: WriteCapabilityAuthorization.windowRevision(window),
                expiresAt: iso(now.addingTimeInterval(120))
            ),
            slotKey,
            draft,
            conversationTitle,
            window
        )
    }

    private func dynamicCapability() -> DynamicTextTargetCapabilityPayload {
        DynamicTextTargetCapabilityPayload(
            version: 2,
            capabilityId: String(repeating: "55", count: 32),
            action: "replace-draft",
            contactId: "contact-0123456789abcdef0123456789abcdef",
            contactRevision: 3,
            conversationTitle: "é小号",
            enrollmentFingerprint: String(repeating: "1", count: 64),
            bindingHash: String(repeating: "2", count: 64),
            candidateHash: "bae79ae779df36322566b7173c17d0373440fed453d82083a63ffc8bbfa76975",
            slotHash: "d04a67fae257299f6c22a4594bb37d14c847c70926ca701fd77d0e9cf3993728",
            windowRevision: "013bc50c91aeebcdf9c7de6b1dc533f624379a0e0ca3fd4e8dc859f4cc2d2e05",
            expiresAt: "2026-08-31T04:02:00.000Z",
            authorizationMac: "74f1045a72c365715b73a7e8cf65f2bacae84b4553d974507389ee8adac36cb4"
        )
    }

    private func dynamicWindow() -> WindowDescriptor {
        WindowDescriptor(
            windowID: 42,
            processID: 100,
            bundleID: "com.tencent.xinWeChat",
            title: "微信",
            ownerName: "WeChat",
            bounds: OCRBounds(x: 0, y: 0, width: 1200, height: 800)
        )
    }

    private func validateDynamic(_ capability: DynamicTextTargetCapabilityPayload) throws {
        try DynamicTextTargetAuthorization.validateAndConsume(
            capability,
            key: Data((0..<32).map(UInt8.init)),
            expectedAction: "replace-draft",
            conversationTitle: "é小号",
            slotKey: "non-daily/\(String(repeating: "3", count: 64))",
            text: "回复 é\n第二行",
            window: dynamicWindow(),
            now: isoDate("2026-08-31T04:00:00.000Z"),
            consumptionStore: MemoryNativeTextCapabilityConsumptionStore()
        )
    }

    private func isoDate(_ value: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)!
    }

    private func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func directoryIdentity(at url: URL) throws -> String {
        let descriptor = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard descriptor >= 0 else { throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID") }
        defer { _ = close(descriptor) }
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0 else {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        return "\(metadata.st_dev):\(metadata.st_ino)"
    }
}
