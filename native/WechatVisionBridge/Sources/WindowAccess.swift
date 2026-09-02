import AppKit
import ApplicationServices
import CoreGraphics
import CryptoKit
import Darwin
import Foundation
import Security
import Vision

struct BridgeError: Error, LocalizedError {
    let code: String

    init(_ code: String) {
        self.code = code
    }

    var errorDescription: String? { code }
}

struct WindowDescriptor: Codable, Equatable {
    let windowID: UInt32
    let processID: Int32
    let bundleID: String
    let title: String
    let ownerName: String
    let bounds: OCRBounds
}

struct PermissionReport: Codable, Equatable {
    let accessibility: Bool
    let screenRecording: Bool
}

struct WechatIdentityEnrollmentPayload: Codable, Equatable {
    let version: Int
    let conversationId: String?
    let visibleName: String?
    let contactId: String?
    let displayName: String?
    let fingerprintVersion: String
    let referenceSamples: [String]
    let enrolledAt: String
}

struct WechatIdentityMatchResult: Codable, Equatable {
    let normalizedY: Double
    let distance: Float
    let observedFingerprint: String
    let fingerprintVersion: String
    let proofPhase: String
    let selected: Bool
    let selectedRowTitle: String?
    let selectedRowNormalizedY: Double?
    let selectionProofHash: String?
}

struct WechatSelectedRowAttestation: Equatable {
    let title: String
    let normalizedY: Double
}

struct WechatIdentityCaptureReceipt: Codable, Equatable {
    let fingerprintVersion: String
    let windowRevision: String
    let leftPaneProofHash: String
    let headerProofHash: String
    let referenceSamples: [String]
    let observedFingerprints: [String]
    let maximumPairwiseDistance: Float
}

struct WriteCapabilityPayload: Codable, Equatable {
    let version: Int
    let capabilityId: String
    let candidateHash: String
    let slotHash: String
    let identityFingerprint: String
    let windowRevision: String
    let expiresAt: String
}

struct MutationCapabilityPayload: Codable, Equatable {
    let version: Int
    let capabilityId: String
    let action: String
    let candidateHash: String
    let slotHash: String
    let identityFingerprint: String
    let windowRevision: String
    let expiresAt: String
}

struct DynamicTextTargetCapabilityPayload: Codable, Equatable {
    let version: Int
    let capabilityId: String
    let action: String
    let contactId: String
    let contactRevision: Int
    let conversationTitle: String
    let enrollmentFingerprint: String
    let bindingHash: String
    let candidateHash: String
    let slotHash: String
    let windowRevision: String
    let expiresAt: String
    let authorizationMac: String
    let requestBindingMac: String?

    init(
        version: Int,
        capabilityId: String,
        action: String,
        contactId: String,
        contactRevision: Int,
        conversationTitle: String,
        enrollmentFingerprint: String,
        bindingHash: String,
        candidateHash: String,
        slotHash: String,
        windowRevision: String,
        expiresAt: String,
        authorizationMac: String,
        requestBindingMac: String? = nil
    ) {
        self.version = version
        self.capabilityId = capabilityId
        self.action = action
        self.contactId = contactId
        self.contactRevision = contactRevision
        self.conversationTitle = conversationTitle
        self.enrollmentFingerprint = enrollmentFingerprint
        self.bindingHash = bindingHash
        self.candidateHash = candidateHash
        self.slotHash = slotHash
        self.windowRevision = windowRevision
        self.expiresAt = expiresAt
        self.authorizationMac = authorizationMac
        self.requestBindingMac = requestBindingMac
    }
}

struct SubmitConversationProofPayload: Codable, Equatable {
    let version: Int
    let latestMessageId: String
    let latestTextHash: String
    let latestDirection: String
    let controlRevision: String
}

enum TextMutationCapabilityPayload: Equatable {
    case v1(MutationCapabilityPayload)
    case dynamic(DynamicTextTargetCapabilityPayload)

    var action: String {
        switch self {
        case let .v1(capability): return capability.action
        case let .dynamic(capability): return capability.action
        }
    }
}

enum TextSubmitCapabilityPayload: Equatable {
    case v1(WriteCapabilityPayload)
    case dynamic(DynamicTextTargetCapabilityPayload)
}

protocol NativeTextCapabilityConsumptionStore {
    func consume(capabilityId: String, bindingDigest: String) throws
}

struct FileNativeTextCapabilityConsumptionStore: NativeTextCapabilityConsumptionStore {
    private static let productionComponents = ["WechatVisionBridge", "native-text-capabilities"]
    private let anchorURL: URL
    private let relativeComponents: [String]
    private let directorySynchronizer: (Int32) -> Int32

    init(
        anchorURL: URL? = nil,
        relativeComponents: [String] = productionComponents,
        directorySynchronizer: @escaping (Int32) -> Int32 = { fsync($0) }
    ) {
        self.anchorURL = anchorURL ?? FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0]
        self.relativeComponents = relativeComponents
        self.directorySynchronizer = directorySynchronizer
    }

    func consume(capabilityId: String, bindingDigest: String) throws {
        guard isLowerHexHash(capabilityId), isLowerHexHash(bindingDigest),
              !relativeComponents.isEmpty, relativeComponents.allSatisfy(isSafePathComponent) else {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        let anchorDescriptor = open(anchorURL.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard anchorDescriptor >= 0 else {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        var directoryDescriptors: [Int32] = [anchorDescriptor]
        var receiptDescriptor: Int32? = nil
        var receiptCreated = false
        var fullyWritten = false
        do {
            try validateDirectory(anchorDescriptor, requiresPrivatePermissions: false)
            for component in relativeComponents {
                let parentDescriptor = directoryDescriptors.last!
                let childDescriptor = try openOrCreatePrivateDirectory(
                    parentDescriptor: parentDescriptor,
                    component: component
                )
                directoryDescriptors.append(childDescriptor)
            }
            let rootDescriptor = directoryDescriptors.last!
            let descriptor = openat(
                rootDescriptor,
                capabilityId,
                O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW,
                S_IRUSR | S_IWUSR
            )
            guard descriptor >= 0 else { throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID") }
            receiptDescriptor = descriptor
            receiptCreated = true
            try validateReceipt(descriptor)
            try writeFully(Data(bindingDigest.utf8), to: descriptor)
            fullyWritten = true
            guard fsync(descriptor) == 0 else {
                throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
            }
            receiptDescriptor = nil
            guard close(descriptor) == 0 else {
                throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
            }
            guard directorySynchronizer(rootDescriptor) == 0 else {
                throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
            }
            let descriptorsToClose = directoryDescriptors
            directoryDescriptors.removeAll()
            try closeAll(descriptorsToClose)
        } catch {
            var closeFailed = false
            if let descriptor = receiptDescriptor {
                if close(descriptor) != 0 { closeFailed = true }
            }
            // A receipt that is complete or whose durability is uncertain remains
            // present. A later invocation therefore cannot authorize a second UI write.
            if receiptCreated, !fullyWritten, let rootDescriptor = directoryDescriptors.last {
                if unlinkat(rootDescriptor, capabilityId, 0) != 0 { closeFailed = true }
            }
            if !closeAllAfterFailure(directoryDescriptors) { closeFailed = true }
            if closeFailed {
                throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
            }
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
    }

    private func openOrCreatePrivateDirectory(parentDescriptor: Int32, component: String) throws -> Int32 {
        var descriptor = openat(parentDescriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        if descriptor < 0, errno == ENOENT {
            if mkdirat(parentDescriptor, component, S_IRWXU) != 0, errno != EEXIST {
                throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
            }
            descriptor = openat(parentDescriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        }
        guard descriptor >= 0 else { throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID") }
        do {
            try validateDirectory(descriptor, requiresPrivatePermissions: true)
            // This also confirms the directory link when it was created by an
            // earlier failed attempt. Without it, a retry could write a receipt
            // into a directory chain whose prior creation was never durable.
            guard directorySynchronizer(parentDescriptor) == 0 else {
                throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
            }
            return descriptor
        } catch {
            guard close(descriptor) == 0 else {
                throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
            }
            throw error
        }
    }

    private func validateDirectory(_ descriptor: Int32, requiresPrivatePermissions: Bool) throws {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFDIR,
              metadata.st_uid == getuid(),
              !requiresPrivatePermissions || (metadata.st_mode & 0o777) == S_IRWXU else {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
    }

    private func validateReceipt(_ descriptor: Int32) throws {
        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              (metadata.st_mode & S_IFMT) == S_IFREG,
              metadata.st_uid == getuid(),
              (metadata.st_mode & 0o777) == (S_IRUSR | S_IWUSR) else {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
    }

    private func writeFully(_ data: Data, to descriptor: Int32) throws {
        let bytes = Array(data)
        var offset = 0
        while offset < bytes.count {
            let written = bytes.withUnsafeBytes { rawBuffer -> Int in
                guard let baseAddress = rawBuffer.baseAddress else { return -1 }
                return write(descriptor, baseAddress.advanced(by: offset), bytes.count - offset)
            }
            guard written > 0 else { throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID") }
            offset += written
        }
    }

    private func closeAll(_ descriptors: [Int32]) throws {
        var failed = false
        for descriptor in descriptors.reversed() {
            if close(descriptor) != 0 { failed = true }
        }
        if failed { throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID") }
    }

    private func closeAllAfterFailure(_ descriptors: [Int32]) -> Bool {
        var succeeded = true
        for descriptor in descriptors.reversed() {
            if close(descriptor) != 0 { succeeded = false }
        }
        return succeeded
    }

    private func isLowerHexHash(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }

    private func isSafePathComponent(_ value: String) -> Bool {
        !value.isEmpty && value != "." && value != ".." &&
            !value.contains("/") && !value.contains("\\") && !value.contains("\0")
    }
}

enum SensitiveWriteCommand: Equatable {
    case typeText(
        windowID: UInt32,
        bundleID: String,
        title: String,
        conversationTitle: String,
        token: String,
        slotKey: String,
        text: String,
        capability: TextMutationCapabilityPayload
    )
    case pressEnter(token: String)
    case clickWechatPoint(
        windowID: UInt32,
        bundleID: String,
        title: String,
        region: String,
        normalizedX: Double,
        normalizedY: Double,
        token: String,
        conversationTitle: String,
        slotKey: String,
        capability: TextMutationCapabilityPayload
    )
    case submitWechatDraft(
        windowID: UInt32,
        bundleID: String,
        title: String,
        conversationTitle: String,
        token: String,
        slotKey: String,
        draftText: String,
        conversationProof: SubmitConversationProofPayload?,
        capability: TextSubmitCapabilityPayload
    )
    case attachWechatImage(
        windowID: UInt32,
        bundleID: String,
        title: String,
        conversationTitle: String,
        token: String,
        slotKey: String,
        imagePath: String,
        imageSha256: String,
        width: UInt32,
        height: UInt32,
        capability: MutationCapabilityPayload
    )
    case sendWechatImage(
        windowID: UInt32,
        bundleID: String,
        title: String,
        conversationTitle: String,
        token: String,
        slotKey: String,
        imagePath: String,
        imageSha256: String,
        width: UInt32,
        height: UInt32,
        capability: MutationCapabilityPayload
    )
    case recoverWechatImageQuarantine(
        windowID: UInt32,
        bundleID: String,
        title: String,
        conversationTitle: String
    )
    case matchWechatIdentity(
        windowID: UInt32,
        bundleID: String,
        title: String,
        conversationTitle: String,
        proofPhase: String,
        enrollment: WechatIdentityEnrollmentPayload
    )
    case captureWechatIdentitySamples(
        windowID: UInt32,
        bundleID: String,
        title: String,
        conversationTitle: String,
        expectedPreviewHash: String,
        expectedWindowRevision: String,
        sampleCount: UInt32
    )
}

enum SensitiveCommandTransport {
    static let maximumBodyBytes = 64 * 1024

    static func readFrame(_ handle: FileHandle) throws -> SensitiveWriteCommand {
        try readFrame { count in try handle.read(upToCount: count) ?? Data() }
    }

    static func readFrame(_ read: (Int) throws -> Data) throws -> SensitiveWriteCommand {
        let prefix = try readExact(count: 4, read: read)
        guard !prefix.isEmpty else {
            throw BridgeError("SENSITIVE_REQUEST_EOF")
        }
        guard prefix.count == 4 else { throw BridgeError("SENSITIVE_REQUEST_MALFORMED") }
        let declared = prefix.reduce(0) { ($0 << 8) | Int($1) }
        guard declared <= maximumBodyBytes else {
            throw BridgeError("SENSITIVE_REQUEST_TOO_LARGE")
        }
        let body = try readExact(count: declared, read: read)
        guard body.count == declared else {
            throw BridgeError("SENSITIVE_REQUEST_EOF")
        }
        if !((try read(1)).isEmpty) {
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
        var frame = prefix
        frame.append(body)
        return try decodeFrame(frame)
    }

    private static func readExact(
        count: Int,
        read: (Int) throws -> Data
    ) throws -> Data {
        guard count > 0 else { return Data() }
        var result = Data()
        while result.count < count {
            let chunk = try read(count - result.count)
            if chunk.isEmpty { break }
            guard chunk.count <= count - result.count else {
                throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
            }
            result.append(chunk)
        }
        return result
    }

    static func decodeFrame(_ frame: Data) throws -> SensitiveWriteCommand {
        guard !frame.isEmpty else { throw BridgeError("SENSITIVE_REQUEST_EOF") }
        guard frame.count >= 4 else { throw BridgeError("SENSITIVE_REQUEST_MALFORMED") }
        let declared = frame.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
        guard declared <= maximumBodyBytes else {
            throw BridgeError("SENSITIVE_REQUEST_TOO_LARGE")
        }
        guard declared > 0, frame.count == declared + 4 else {
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
        let value: Any
        do {
            value = try JSONSerialization.jsonObject(with: frame.dropFirst(4))
        } catch {
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
        guard let request = value as? [String: Any],
              Set(request.keys) == Set(["version", "command", "payload"]),
              (request["version"] as? NSNumber)?.intValue == 1,
              let command = request["command"] as? String,
              let payload = request["payload"] as? [String: Any] else {
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
        return try decode(command: command, payload: payload)
    }

    private static func decode(command: String, payload: [String: Any]) throws -> SensitiveWriteCommand {
        switch command {
        case "type-text":
            guard Set(payload.keys) == Set([
                "windowID", "bundleID", "title", "conversationTitle", "token", "slotKey", "text", "capability",
            ]) else { throw BridgeError("WRITE_CAPABILITY_REQUIRED") }
            return .typeText(
                windowID: try uint32(payload, "windowID"),
                bundleID: try string(payload, "bundleID"),
                title: try string(payload, "title"),
                conversationTitle: try string(payload, "conversationTitle"),
                token: try string(payload, "token"),
                slotKey: try string(payload, "slotKey"),
                text: try string(payload, "text", allowEmpty: true),
                capability: try decodeTextMutationCapability(payload, "capability")
            )
        case "press-enter":
            try requireExactKeys(payload, ["token"])
            return .pressEnter(token: try string(payload, "token"))
        case "click-wechat-point":
            guard Set(payload.keys) == Set([
                "windowID", "bundleID", "title", "region", "normalizedX", "normalizedY", "token",
                "conversationTitle", "slotKey", "capability",
            ]) else { throw BridgeError("WRITE_CAPABILITY_REQUIRED") }
            return .clickWechatPoint(
                windowID: try uint32(payload, "windowID"),
                bundleID: try string(payload, "bundleID"),
                title: try string(payload, "title"),
                region: try string(payload, "region"),
                normalizedX: try double(payload, "normalizedX"),
                normalizedY: try double(payload, "normalizedY"),
                token: try string(payload, "token"),
                conversationTitle: try string(payload, "conversationTitle"),
                slotKey: try string(payload, "slotKey"),
                capability: try decodeTextMutationCapability(payload, "capability")
            )
        case "submit-wechat-draft":
            let capability = try decodeTextSubmitCapability(payload, "capability")
            let fixedKeys: Set<String> = [
                "windowID", "bundleID", "title", "conversationTitle", "token", "slotKey", "draftText",
                "capability",
            ]
            switch capability {
            case .v1:
                try requireExactKeys(payload, fixedKeys)
            case .dynamic:
                try requireExactKeys(payload, fixedKeys.union(["conversationProof"]))
            }
            return .submitWechatDraft(
                windowID: try uint32(payload, "windowID"),
                bundleID: try string(payload, "bundleID"),
                title: try string(payload, "title"),
                conversationTitle: try string(payload, "conversationTitle"),
                token: try string(payload, "token"),
                slotKey: try string(payload, "slotKey"),
                draftText: try string(payload, "draftText", allowEmpty: true),
                conversationProof: payload["conversationProof"] == nil ? nil : try decodeObject(
                    payload,
                    "conversationProof",
                    as: SubmitConversationProofPayload.self,
                    keys: ["version", "latestMessageId", "latestTextHash", "latestDirection", "controlRevision"]
                ),
                capability: capability
            )
        case "attach-wechat-image":
            guard Set(payload.keys) == Set([
                "windowID", "bundleID", "title", "conversationTitle", "token", "slotKey",
                "imagePath", "imageSha256", "width", "height", "capability",
            ]) else { throw BridgeError("WRITE_CAPABILITY_REQUIRED") }
            return .attachWechatImage(
                windowID: try uint32(payload, "windowID"),
                bundleID: try string(payload, "bundleID"),
                title: try string(payload, "title"),
                conversationTitle: try string(payload, "conversationTitle"),
                token: try string(payload, "token"),
                slotKey: try string(payload, "slotKey"),
                imagePath: try string(payload, "imagePath"),
                imageSha256: try string(payload, "imageSha256"),
                width: try uint32(payload, "width"),
                height: try uint32(payload, "height"),
                capability: try decodeObject(
                    payload,
                    "capability",
                    as: MutationCapabilityPayload.self,
                    keys: [
                        "version", "capabilityId", "action", "candidateHash", "slotHash",
                        "identityFingerprint", "windowRevision", "expiresAt",
                    ]
                )
            )
        case "send-wechat-image":
            guard Set(payload.keys) == Set([
                "windowID", "bundleID", "title", "conversationTitle", "token", "slotKey",
                "imagePath", "imageSha256", "width", "height", "capability",
            ]) else { throw BridgeError("WRITE_CAPABILITY_REQUIRED") }
            return .sendWechatImage(
                windowID: try uint32(payload, "windowID"),
                bundleID: try string(payload, "bundleID"),
                title: try string(payload, "title"),
                conversationTitle: try string(payload, "conversationTitle"),
                token: try string(payload, "token"),
                slotKey: try string(payload, "slotKey"),
                imagePath: try string(payload, "imagePath"),
                imageSha256: try string(payload, "imageSha256"),
                width: try uint32(payload, "width"),
                height: try uint32(payload, "height"),
                capability: try decodeObject(
                    payload,
                    "capability",
                    as: MutationCapabilityPayload.self,
                    keys: [
                        "version", "capabilityId", "action", "candidateHash", "slotHash",
                        "identityFingerprint", "windowRevision", "expiresAt",
                    ]
                )
            )
        case "recover-wechat-image-quarantine":
            try requireExactKeys(payload, [
                "windowID", "bundleID", "title", "conversationTitle",
            ])
            return .recoverWechatImageQuarantine(
                windowID: try uint32(payload, "windowID"),
                bundleID: try string(payload, "bundleID"),
                title: try string(payload, "title"),
                conversationTitle: try string(payload, "conversationTitle")
            )
        case "match-wechat-identity":
            try requireExactKeys(payload, [
                "windowID", "bundleID", "title", "conversationTitle", "proofPhase", "enrollment",
            ])
            return .matchWechatIdentity(
                windowID: try uint32(payload, "windowID"),
                bundleID: try string(payload, "bundleID"),
                title: try string(payload, "title"),
                conversationTitle: try string(payload, "conversationTitle"),
                proofPhase: try string(payload, "proofPhase"),
                enrollment: try decodeWechatIdentityEnrollment(payload, "enrollment")
            )
        case "capture-wechat-identity-samples":
            try requireExactKeys(payload, [
                "windowID", "bundleID", "title", "conversationTitle", "expectedPreviewHash",
                "expectedWindowRevision", "sampleCount",
            ])
            return .captureWechatIdentitySamples(
                windowID: try uint32(payload, "windowID"),
                bundleID: try string(payload, "bundleID"),
                title: try string(payload, "title"),
                conversationTitle: try string(payload, "conversationTitle"),
                expectedPreviewHash: try string(payload, "expectedPreviewHash"),
                expectedWindowRevision: try string(payload, "expectedWindowRevision"),
                sampleCount: try uint32(payload, "sampleCount")
            )
        default:
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
    }

    private static func requireExactKeys(_ payload: [String: Any], _ keys: Set<String>) throws {
        guard Set(payload.keys) == keys else { throw BridgeError("SENSITIVE_REQUEST_MALFORMED") }
    }

    private static func string(
        _ payload: [String: Any],
        _ key: String,
        allowEmpty: Bool = false
    ) throws -> String {
        guard let value = payload[key] as? String, allowEmpty || !value.isEmpty else {
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
        return value
    }

    private static func uint32(_ payload: [String: Any], _ key: String) throws -> UInt32 {
        guard let number = payload[key] as? NSNumber,
              number.doubleValue.rounded() == number.doubleValue,
              let value = UInt32(exactly: number.uint64Value) else {
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
        return value
    }

    private static func double(_ payload: [String: Any], _ key: String) throws -> Double {
        guard let number = payload[key] as? NSNumber, number.doubleValue.isFinite else {
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
        return number.doubleValue
    }

    private static func decodeObject<T: Decodable>(
        _ payload: [String: Any],
        _ key: String,
        as type: T.Type,
        keys: Set<String>
    ) throws -> T {
        guard let value = payload[key],
              let object = value as? [String: Any],
              Set(object.keys) == keys,
              JSONSerialization.isValidJSONObject(object) else {
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
        do {
            return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
        } catch {
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
    }

    private static func decodeTextMutationCapability(
        _ payload: [String: Any],
        _ key: String
    ) throws -> TextMutationCapabilityPayload {
        guard let object = payload[key] as? [String: Any] else {
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
        if (object["version"] as? NSNumber)?.intValue == 2 {
            return .dynamic(try decodeObject(
                payload,
                key,
                as: DynamicTextTargetCapabilityPayload.self,
                keys: dynamicCapabilityKeys
            ))
        }
        return .v1(try decodeObject(
            payload,
            key,
            as: MutationCapabilityPayload.self,
            keys: [
                "version", "capabilityId", "action", "candidateHash", "slotHash",
                "identityFingerprint", "windowRevision", "expiresAt",
            ]
        ))
    }

    private static func decodeTextSubmitCapability(
        _ payload: [String: Any],
        _ key: String
    ) throws -> TextSubmitCapabilityPayload {
        guard let object = payload[key] as? [String: Any] else {
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
        if (object["version"] as? NSNumber)?.intValue == 2 {
            return .dynamic(try decodeObject(
                payload,
                key,
                as: DynamicTextTargetCapabilityPayload.self,
                keys: dynamicCapabilityKeys.union(["requestBindingMac"])
            ))
        }
        return .v1(try decodeObject(
            payload,
            key,
            as: WriteCapabilityPayload.self,
            keys: [
                "version", "capabilityId", "candidateHash", "slotHash",
                "identityFingerprint", "windowRevision", "expiresAt",
            ]
        ))
    }

    private static let dynamicCapabilityKeys: Set<String> = [
        "version", "capabilityId", "action", "contactId", "contactRevision",
        "conversationTitle", "enrollmentFingerprint", "bindingHash", "candidateHash",
        "slotHash", "windowRevision", "expiresAt", "authorizationMac",
    ]

    private static func decodeWechatIdentityEnrollment(
        _ payload: [String: Any],
        _ key: String
    ) throws -> WechatIdentityEnrollmentPayload {
        guard let object = payload[key] as? [String: Any],
              let version = (object["version"] as? NSNumber)?.intValue else {
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
        let keys: Set<String>
        switch version {
        case 1:
            keys = ["version", "conversationId", "visibleName", "fingerprintVersion", "referenceSamples", "enrolledAt"]
        case 2:
            keys = ["version", "contactId", "displayName", "fingerprintVersion", "referenceSamples", "enrolledAt"]
        default:
            throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
        }
        return try decodeObject(payload, key, as: WechatIdentityEnrollmentPayload.self, keys: keys)
    }
}

enum WriteAuthorization {
    static func validate(token: String?) throws {
        guard let token, token.range(of: "^[0-9a-fA-F]{64}$", options: .regularExpression) != nil else {
            throw BridgeError("WRITE_TOKEN_REQUIRED")
        }
    }
}

enum WriteCapabilityAuthorization {
    private static let lock = NSLock()
    private static var consumed = Set<String>()

    static func validateAndConsume(
        _ capability: WriteCapabilityPayload,
        token: String,
        slotKey: String,
        draftText: String,
        conversationTitle: String,
        window: WindowDescriptor,
        now: Date = Date()
    ) throws {
        try WriteAuthorization.validate(token: token)
        guard capability.version == 1,
              capability.capabilityId == token,
              isHash(capability.capabilityId),
              isHash(capability.candidateHash),
              isHash(capability.slotHash),
              isHash(capability.identityFingerprint),
              isHash(capability.windowRevision) else {
            throw BridgeError("WRITE_CAPABILITY_REQUIRED")
        }
        guard slotKey.range(
            of: "^(?:\\d{4}-\\d{2}-\\d{2}/(?:morning|night)|non-daily/[a-f0-9]{64})$",
            options: .regularExpression
        ) != nil, sha256(slotKey) == capability.slotHash else {
            throw BridgeError("WRITE_CAPABILITY_SLOT_MISMATCH")
        }
        let canonicalDraft = draftText.precomposedStringWithCanonicalMapping
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        guard sha256(canonicalDraft) == capability.candidateHash else {
            throw BridgeError("WRITE_CAPABILITY_CANDIDATE_MISMATCH")
        }
        guard titleIdentityFingerprint(conversationTitle, windowRevision: capability.windowRevision) ==
                capability.identityFingerprint else {
            throw BridgeError("WRITE_CAPABILITY_IDENTITY_MISMATCH")
        }
        guard windowRevision(window) == capability.windowRevision else {
            throw BridgeError("WRITE_CAPABILITY_WINDOW_MISMATCH")
        }
        guard let expiry = parseISO8601(capability.expiresAt),
              expiry > now,
              expiry.timeIntervalSince(now) <= 180 else {
            throw BridgeError("WRITE_CAPABILITY_EXPIRED")
        }
        lock.lock()
        defer { lock.unlock() }
        guard !consumed.contains(capability.capabilityId) else {
            throw BridgeError("WRITE_CAPABILITY_ALREADY_USED")
        }
        consumed.insert(capability.capabilityId)
    }

    static func enrollmentFingerprint(_ enrollment: WechatIdentityEnrollmentPayload) -> String {
        sha256(([
            String(enrollment.version),
            enrollment.conversationId ?? enrollment.contactId ?? "",
            enrollment.visibleName ?? enrollment.displayName ?? "",
            enrollment.fingerprintVersion,
            "0.18",
        ] + enrollment.referenceSamples).joined(separator: "\0"))
    }

    static func titleIdentityFingerprint(_ title: String, windowRevision: String) -> String {
        sha256(["wechat-unique-title-v1", title, windowRevision].joined(separator: "\0"))
    }

    static func windowRevision(_ window: WindowDescriptor) -> String {
        sha256([
            String(window.windowID),
            String(window.processID),
            window.bundleID,
            window.title,
            window.ownerName,
        ].joined(separator: "\0"))
    }

    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func isHash(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }

    private static func parseISO8601(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
}

enum MutationCapabilityAuthorization {
    static func validate(
        _ capability: MutationCapabilityPayload,
        token: String,
        expectedAction: String,
        slotKey: String,
        text: String?,
        conversationTitle: String,
        window: WindowDescriptor,
        now: Date = Date()
    ) throws {
        try WriteAuthorization.validate(token: token)
        guard capability.version == 1,
              capability.capabilityId == token,
              capability.action == expectedAction,
              isHash(capability.capabilityId),
              isHash(capability.candidateHash),
              isHash(capability.slotHash),
              isHash(capability.identityFingerprint),
              isHash(capability.windowRevision) else {
            throw BridgeError("WRITE_CAPABILITY_REQUIRED")
        }
        guard ["文件传输助手", "示例联系人"].contains(conversationTitle) else {
            throw BridgeError("WECHAT_CONVERSATION_TARGET_NOT_ALLOWED")
        }
        guard slotKey.range(
            of: "^(?:\\d{4}-\\d{2}-\\d{2}/(?:morning|night)|non-daily/[a-f0-9]{64})$",
            options: .regularExpression
        ) != nil, sha256(slotKey) == capability.slotHash else {
            throw BridgeError("WRITE_CAPABILITY_SLOT_MISMATCH")
        }
        if expectedAction == "replace-draft" {
            guard let text, sha256(canonical(text)) == capability.candidateHash else {
                throw BridgeError("WRITE_CAPABILITY_CANDIDATE_MISMATCH")
            }
        } else if expectedAction == "clear-draft", text != "" {
            throw BridgeError("WRITE_CAPABILITY_CANDIDATE_MISMATCH")
        }
        guard WriteCapabilityAuthorization.windowRevision(window) == capability.windowRevision else {
            throw BridgeError("WRITE_CAPABILITY_WINDOW_MISMATCH")
        }
        guard WriteCapabilityAuthorization.titleIdentityFingerprint(
            conversationTitle,
            windowRevision: capability.windowRevision
        ) == capability.identityFingerprint else {
            throw BridgeError("WRITE_CAPABILITY_IDENTITY_MISMATCH")
        }
        guard let expiry = parseISO8601(capability.expiresAt),
              expiry > now,
              expiry.timeIntervalSince(now) <= 180 else {
            throw BridgeError("WRITE_CAPABILITY_EXPIRED")
        }
    }

    private static func canonical(_ value: String) -> String {
        value.precomposedStringWithCanonicalMapping
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }

    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func isHash(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }

    private static func parseISO8601(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }
}

enum DynamicTextTargetAuthorization {
    private static let domain = "wechat-native-text-target-capability"
    private static let requestBindingDomain = "wechat-native-request-binding-v1"

    static func validateRequestBinding(
        _ capability: DynamicTextTargetCapabilityPayload,
        proof: SubmitConversationProofPayload,
        key: Data,
        windowID: UInt32,
        bundleID: String,
        title: String,
        conversationTitle: String,
        token: String,
        slotKey: String,
        draftText: String
    ) throws {
        guard key.count == 32,
              proof.version == 1,
              proof.latestDirection == "incoming",
              isHash(proof.latestMessageId),
              isHash(proof.latestTextHash),
              isHash(proof.controlRevision),
              let mac = capability.requestBindingMac,
              isHash(mac),
              let received = Data(hex: mac) else {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        let canonical = [
            requestBindingDomain,
            capability.authorizationMac,
            String(windowID),
            bundleID,
            title,
            conversationTitle,
            token,
            slotKey,
            canonical(draftText),
            capability.windowRevision,
            String(proof.version),
            proof.latestMessageId,
            proof.latestTextHash,
            proof.latestDirection,
            proof.controlRevision,
        ].joined(separator: "\0")
        let expected = Data(HMAC<SHA256>.authenticationCode(
            for: Data(canonical.utf8),
            using: SymmetricKey(data: key)
        ))
        guard constantTimeEqual(received, expected) else {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
    }

    static func validateAndConsume(
        _ capability: DynamicTextTargetCapabilityPayload,
        key: Data,
        expectedAction: String,
        conversationTitle: String,
        slotKey: String,
        text: String,
        window: WindowDescriptor,
        now: Date = Date(),
        consumptionStore: any NativeTextCapabilityConsumptionStore =
            FileNativeTextCapabilityConsumptionStore()
    ) throws {
        guard key.count == 32,
              capability.version == 2,
              capability.action == expectedAction,
              ["select-conversation", "focus-composer", "replace-draft", "clear-draft", "submit-draft"]
                .contains(capability.action),
              isHash(capability.capabilityId),
              capability.contactId.range(of: "^(?:example-contact|contact-[a-f0-9]{32})$", options: .regularExpression) != nil,
              capability.contactRevision > 0,
              isHash(capability.enrollmentFingerprint),
              isHash(capability.bindingHash),
              isHash(capability.candidateHash),
              isHash(capability.slotHash),
              isHash(capability.windowRevision),
              isHash(capability.authorizationMac),
              isNFC(capability.capabilityId), isNFC(capability.action),
              isNFC(capability.contactId), isNFC(capability.conversationTitle),
              isNFC(capability.enrollmentFingerprint), isNFC(capability.bindingHash),
              isNFC(capability.candidateHash), isNFC(capability.slotHash),
              isNFC(capability.windowRevision), isNFC(capability.expiresAt),
              isNFC(capability.authorizationMac),
              capability.conversationTitle == conversationTitle,
              sha256(canonical(text)) == capability.candidateHash,
              sha256(slotKey) == capability.slotHash,
              WriteCapabilityAuthorization.windowRevision(window) == capability.windowRevision,
              let expiry = parseISO8601(capability.expiresAt),
              canonicalISO8601(expiry) == capability.expiresAt,
              expiry > now, expiry.timeIntervalSince(now) <= 180,
              let received = Data(hex: capability.authorizationMac) else {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        let expected = Data(HMAC<SHA256>.authenticationCode(
            for: canonicalBytes(capability),
            using: SymmetricKey(data: key)
        ))
        guard constantTimeEqual(received, expected) else {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        try consumptionStore.consume(
            capabilityId: capability.capabilityId,
            bindingDigest: sha256(capability.authorizationMac)
        )
    }

    static func defaultKey() throws -> Data {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "Codex.WeChatChatAssistant.NativeCapability.v1",
            kSecAttrAccount as String: NSUserName(),
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let value = result as? Data else {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        return try decodeKeychainKey(value)
    }

    static func decodeKeychainKey(_ stored: Data) throws -> Data {
        guard let encoded = String(data: stored, encoding: .utf8),
              let decoded = Data(base64Encoded: encoded), decoded.count == 32,
              decoded.base64EncodedString() == encoded else {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        return decoded
    }

    private static func canonicalBytes(_ capability: DynamicTextTargetCapabilityPayload) -> Data {
        Data(([
            domain,
            "2",
            String(capability.version),
            capability.capabilityId,
            capability.action,
            capability.contactId,
            String(capability.contactRevision),
            capability.conversationTitle,
            capability.enrollmentFingerprint,
            capability.bindingHash,
            capability.candidateHash,
            capability.slotHash,
            capability.windowRevision,
            capability.expiresAt,
        ].map { $0.precomposedStringWithCanonicalMapping }).joined(separator: "\0").utf8)
    }

    private static func canonical(_ value: String) -> String {
        value.precomposedStringWithCanonicalMapping
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }

    private static func isHash(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }

    private static func isNFC(_ value: String) -> Bool {
        value.unicodeScalars.elementsEqual(
            value.precomposedStringWithCanonicalMapping.unicodeScalars
        )
    }

    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func parseISO8601(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value)
    }

    private static func canonicalISO8601(_ value: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: value)
    }

    private static func constantTimeEqual(_ left: Data, _ right: Data) -> Bool {
        guard left.count == right.count else { return false }
        var difference: UInt8 = 0
        for (a, b) in zip(left, right) {
            difference |= a ^ b
        }
        return difference == 0
    }
}

private extension Data {
    init?(hex: String) {
        guard hex.count % 2 == 0 else { return nil }
        var bytes = Data()
        bytes.reserveCapacity(hex.count / 2)
        var index = hex.startIndex
        while index < hex.endIndex {
            let end = hex.index(index, offsetBy: 2)
            guard let byte = UInt8(hex[index..<end], radix: 16) else { return nil }
            bytes.append(byte)
            index = end
        }
        self = bytes
    }
}

enum ImageAttachmentCapabilityAuthorization {
    static func validateAndConsume(
        _ capability: MutationCapabilityPayload,
        token: String,
        slotKey: String,
        imageSha256: String,
        conversationTitle: String,
        window: WindowDescriptor,
        now: Date = Date(),
        consumptionStore: any ImageAttachmentCapabilityConsumptionStore =
            FileImageAttachmentCapabilityConsumptionStore()
    ) throws {
        guard conversationTitle == "文件传输助手" else {
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_TARGET_NOT_ALLOWED")
        }
        try MutationCapabilityAuthorization.validate(
            capability,
            token: token,
            expectedAction: "attach-image",
            slotKey: slotKey,
            text: nil,
            conversationTitle: conversationTitle,
            window: window,
            now: now
        )
        guard imageSha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              imageSha256 == capability.candidateHash else {
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_CANDIDATE_MISMATCH")
        }
        try consumptionStore.consume(ImageAttachmentCapabilityBinding(
            capabilityId: capability.capabilityId,
            action: capability.action,
            target: conversationTitle,
            slotHash: capability.slotHash,
            imageSha256: imageSha256,
            windowRevision: capability.windowRevision,
            identityFingerprint: capability.identityFingerprint,
            expiresAt: capability.expiresAt
        ))
    }
}

enum ImageSendCapabilityAuthorization {
    static func validateAndConsume(
        _ capability: MutationCapabilityPayload,
        token: String,
        slotKey: String,
        imageSha256: String,
        conversationTitle: String,
        window: WindowDescriptor,
        now: Date = Date(),
        consumptionStore: any ImageAttachmentCapabilityConsumptionStore =
            FileImageAttachmentCapabilityConsumptionStore()
    ) throws {
        guard conversationTitle == "示例联系人" else {
            throw BridgeError("WECHAT_IMAGE_SEND_TARGET_NOT_ALLOWED")
        }
        try MutationCapabilityAuthorization.validate(
            capability,
            token: token,
            expectedAction: "send-image",
            slotKey: slotKey,
            text: nil,
            conversationTitle: conversationTitle,
            window: window,
            now: now
        )
        guard imageSha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              imageSha256 == capability.candidateHash else {
            throw BridgeError("WECHAT_IMAGE_SEND_CANDIDATE_MISMATCH")
        }
        try consumptionStore.consume(ImageAttachmentCapabilityBinding(
            capabilityId: capability.capabilityId,
            action: capability.action,
            target: conversationTitle,
            slotHash: capability.slotHash,
            imageSha256: imageSha256,
            windowRevision: capability.windowRevision,
            identityFingerprint: capability.identityFingerprint,
            expiresAt: capability.expiresAt
        ))
    }
}

enum WechatClickAuthorization {
    static func validate(bundleID: String, title: String, region: String, x: Double, y: Double) throws {
        guard bundleID == "com.tencent.xinWeChat", title == "微信" else {
            throw BridgeError("WECHAT_CLICK_TARGET_NOT_ALLOWED")
        }
        let allowed: Bool
        switch region {
        case "conversation-list":
            allowed = (0.08...0.36).contains(x) && (0.05...0.95).contains(y)
        case "composer":
            allowed = (0.38...0.98).contains(x) && (0.62...0.98).contains(y)
        default:
            throw BridgeError("WECHAT_CLICK_REGION_NOT_ALLOWED")
        }
        guard allowed else { throw BridgeError("WECHAT_CLICK_POINT_NOT_ALLOWED") }
    }
}

enum WechatPaneGeometry {
    static let conversationListMaxX = 0.31
    static let conversationHeaderMinX = 0.32
}

enum ConversationListSelectionGuard {
    static func hasUniqueMatch(
        lines: [OCRLine],
        expected: String,
        normalizedY: Double,
        allowsDynamicTitle: Bool = false
    ) -> Bool {
        let matches = lines.filter { line in
            guard line.bounds.x < WechatPaneGeometry.conversationListMaxX else { return false }
            if expected == "文件传输助手" {
                return line.confidence >= 0.25 && line.text.hasPrefix("文件传输")
            }
            return (expected == "示例联系人" || allowsDynamicTitle) &&
                line.confidence >= 0.50 && line.text == expected
        }
        guard matches.count == 1, let match = matches.first else { return false }
        return abs((1 - match.bounds.y - match.bounds.height / 2) - normalizedY) <= 0.08
    }
}

enum ReadOnlyScrollAuthorization {
    static func validate(bundleID: String, title: String, deltaY: Int32) throws {
        guard bundleID == "com.tencent.xinWeChat",
              title == "与“示例联系人”的聊天记录" else {
            throw BridgeError("READ_ONLY_SCROLL_TARGET_NOT_ALLOWED")
        }
        guard deltaY != 0, abs(Int(deltaY)) <= 1_200 else {
            throw BridgeError("READ_ONLY_SCROLL_DELTA_NOT_ALLOWED")
        }
    }
}

enum ReadOnlyScrollbarDragAuthorization {
    static func validate(bundleID: String, title: String, fromY: Int32, toY: Int32) throws {
        guard bundleID == "com.tencent.xinWeChat",
              title == "与“示例联系人”的聊天记录" else {
            throw BridgeError("READ_ONLY_SCROLLBAR_DRAG_TARGET_NOT_ALLOWED")
        }
        guard fromY >= 40, toY > fromY, toY - fromY <= 600 else {
            throw BridgeError("READ_ONLY_SCROLLBAR_DRAG_NOT_ALLOWED")
        }
    }
}

enum SubmitConversationGuard {
    private static let allowedTitles = Set(["文件传输助手", "示例联系人"])

    static func hasUniqueHeader(
        lines: [OCRLine],
        expected: String,
        allowsDynamicTitle: Bool = false
    ) -> Bool {
        guard allowedTitles.contains(expected) || allowsDynamicTitle else { return false }
        let headers = lines.filter { line in
            line.text == expected &&
                line.confidence >= 0.50 &&
                line.bounds.x >= WechatPaneGeometry.conversationHeaderMinX &&
                line.bounds.y >= 0.86
        }
        guard headers.count == 1, let header = headers.first else { return false }
        if header.confidence >= 0.90 { return true }
        let exactListLabels = lines.filter { line in
            line.text == expected &&
                line.confidence >= 0.90 &&
                line.bounds.x < WechatPaneGeometry.conversationListMaxX
        }
        return exactListLabels.count == 1
    }

    static func matchesFinalState(
        lines: [OCRLine],
        contactId: String,
        proof: SubmitConversationProofPayload
    ) -> Bool {
        guard proof.version == 1,
              proof.latestDirection == "incoming",
              isHash(proof.latestMessageId),
              isHash(proof.latestTextHash),
              isHash(proof.controlRevision) else { return false }
        let messages = visibleMessages(lines)
        guard let latest = messages.last,
              latest.direction == "incoming",
              !["STOP", "停止", "暂停"].contains(
                latest.text.precomposedStringWithCanonicalMapping
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .uppercased()
              ) else { return false }
        let latestId = sha256([contactId, latest.direction, latest.text].joined(separator: "\0"))
        let latestTextHash = sha256(canonical(latest.text))
        let controlRevision = sha256(messages.map { message in
            let id = sha256([contactId, message.direction, message.text].joined(separator: "\0"))
            return "\(id)\0\(message.direction)"
        }.joined(separator: "\0"))
        return latestId == proof.latestMessageId &&
            latestTextHash == proof.latestTextHash &&
            controlRevision == proof.controlRevision
    }

    private struct VisibleMessage {
        let direction: String
        let text: String
    }

    private static func visibleMessages(_ lines: [OCRLine]) -> [VisibleMessage] {
        let candidates = lines.filter { line in
            line.confidence >= 0.5 &&
                line.bounds.x >= 0.38 && line.bounds.y >= 0.4 && line.bounds.y <= 0.86 &&
                line.text.range(of: "[\\p{L}\\p{N}]", options: .regularExpression) != nil &&
                line.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    .range(of: "^(?:昨天\\s*)?\\d{1,2}:\\d{2}$", options: .regularExpression) == nil
        }.sorted { left, right in
            if left.bounds.y != right.bounds.y { return left.bounds.y > right.bounds.y }
            return left.bounds.x < right.bounds.x
        }
        var groups: [[OCRLine]] = []
        for line in candidates {
            if let previous = groups.last?.last {
                let verticalGap = previous.bounds.y - (line.bounds.y + line.bounds.height)
                if abs(previous.bounds.x - line.bounds.x) <= 0.015 &&
                    verticalGap >= -0.005 && verticalGap <= 0.02 {
                    groups[groups.count - 1].append(line)
                    continue
                }
            }
            groups.append([line])
        }
        return groups.map { group in
            let text = group.map { line in
                line.text.replacingOccurrences(
                    of: "\\s+",
                    with: " ",
                    options: .regularExpression
                ).trimmingCharacters(in: .whitespacesAndNewlines)
            }.joined()
            let outgoing = group.map { $0.bounds.x + $0.bounds.width / 2 }.max() ?? 0
            return VisibleMessage(direction: outgoing >= 0.64 ? "outgoing" : "incoming", text: text)
        }
    }

    private static func canonical(_ value: String) -> String {
        value.precomposedStringWithCanonicalMapping
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
    }

    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func isHash(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }
}

enum WindowCaptureCommand {
    static func arguments(windowID: UInt32, outputURL: URL) -> [String] {
        ["-x", "-o", "-l", String(windowID), outputURL.path]
    }
}

enum WindowAccess {
    static func listWindows(bundleID: String) throws -> [WindowDescriptor] {
        guard !bundleID.isEmpty else {
            throw BridgeError("BUNDLE_ID_REQUIRED")
        }
        guard let windowInfo = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else {
            throw BridgeError("WINDOW_LIST_UNAVAILABLE")
        }

        return windowInfo.compactMap { info in
            descriptor(from: info, requiredBundleID: bundleID)
        }
    }

    static func capture(windowID: UInt32, outputURL: URL) throws {
        guard CGPreflightScreenCaptureAccess() else {
            throw BridgeError("SCREEN_RECORDING_PERMISSION_REQUIRED")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = WindowCaptureCommand.arguments(
            windowID: windowID,
            outputURL: outputURL
        )
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              FileManager.default.fileExists(atPath: outputURL.path) else {
            throw BridgeError("WINDOW_CAPTURE_FAILED")
        }
    }

    static func focus(windowID: UInt32) throws {
        guard let descriptor = try descriptor(windowID: windowID),
              let application = NSRunningApplication(processIdentifier: descriptor.processID) else {
            throw BridgeError("WINDOW_NOT_FOUND")
        }
        guard application.activate(options: [.activateIgnoringOtherApps]) else {
            throw BridgeError("WINDOW_FOCUS_FAILED")
        }
    }

    static func captureWechatIdentitySamples(
        windowID: UInt32,
        expectedBundleID: String,
        expectedTitle: String,
        expectedConversationTitle: String,
        expectedPreviewHash: String,
        expectedWindowRevision: String,
        sampleCount: Int,
        windowListProvider: (String) throws -> [WindowDescriptor] = { try listWindows(bundleID: $0) },
        descriptorProvider: (UInt32) throws -> WindowDescriptor? = { try descriptor(windowID: $0) },
        frameProvider: (UInt32) throws -> (CGImage, [OCRLine]) = { try identityCaptureFrame(windowID: $0) },
        distanceCalculator: (VNFeaturePrintObservation, VNFeaturePrintObservation) throws -> Float = {
            left, right in
            var distance: Float = 0
            try left.computeDistance(&distance, to: right)
            return distance
        }
    ) throws -> WechatIdentityCaptureReceipt {
        let canonicalTitle = expectedConversationTitle.precomposedStringWithCanonicalMapping
        guard expectedBundleID == "com.tencent.xinWeChat", expectedTitle == "微信",
              expectedConversationTitle == canonicalTitle,
              expectedConversationTitle == expectedConversationTitle.trimmingCharacters(in: .whitespacesAndNewlines),
              !expectedConversationTitle.isEmpty, expectedConversationTitle.count <= 64,
              isLowerHexHash(expectedPreviewHash), isLowerHexHash(expectedWindowRevision),
              (3...5).contains(sampleCount) else {
            throw BridgeError("WECHAT_IDENTITY_CAPTURE_REQUEST_INVALID")
        }
        guard let initialCatalogWindow = uniqueRequestedWindow(
                try windowListProvider(expectedBundleID),
                windowID: windowID,
                bundleID: expectedBundleID,
                title: expectedTitle
              ),
              let initialWindow = try descriptorProvider(windowID),
              initialCatalogWindow == initialWindow,
              WriteCapabilityAuthorization.windowRevision(initialCatalogWindow) == expectedWindowRevision,
              WriteCapabilityAuthorization.windowRevision(initialWindow) == expectedWindowRevision else {
            throw BridgeError("WECHAT_IDENTITY_WINDOW_MISMATCH")
        }

        var observations: [VNFeaturePrintObservation] = []
        var finalLeft: OCRLine?
        var finalHeader: OCRLine?
        for _ in 0..<sampleCount {
            guard requestedWindowMatches(
                    try windowListProvider(expectedBundleID),
                    expectedDescriptor: initialWindow,
                    expectedRevision: expectedWindowRevision
                  ),
                  let beforeFrameWindow = try descriptorProvider(windowID),
                  beforeFrameWindow == initialWindow,
                  WriteCapabilityAuthorization.windowRevision(beforeFrameWindow) == expectedWindowRevision else {
                throw BridgeError("WECHAT_IDENTITY_WINDOW_REVISION_CHANGED")
            }
            let (image, lines) = try frameProvider(windowID)
            let evidence = try enrollmentEvidence(
                lines: lines,
                conversationTitle: canonicalTitle,
                expectedPreviewHash: expectedPreviewHash
            )
            finalLeft = evidence.left
            finalHeader = evidence.header
            observations.append(try featurePrint(image: image, row: evidence.left))
            guard requestedWindowMatches(
                    try windowListProvider(expectedBundleID),
                    expectedDescriptor: initialWindow,
                    expectedRevision: expectedWindowRevision
                  ),
                  let afterFrameWindow = try descriptorProvider(windowID),
                  afterFrameWindow == initialWindow,
                  WriteCapabilityAuthorization.windowRevision(afterFrameWindow) == expectedWindowRevision else {
                throw BridgeError("WECHAT_IDENTITY_WINDOW_REVISION_CHANGED")
            }
        }
        guard let left = finalLeft, let header = finalHeader,
              requestedWindowMatches(
                try windowListProvider(expectedBundleID),
                expectedDescriptor: initialWindow,
                expectedRevision: expectedWindowRevision
              ),
              let finalWindow = try descriptorProvider(windowID),
              finalWindow == initialWindow,
              WriteCapabilityAuthorization.windowRevision(finalWindow) == expectedWindowRevision else {
            throw BridgeError("WECHAT_IDENTITY_WINDOW_REVISION_CHANGED")
        }

        var maximumDistance: Float = 0
        if observations.count > 1 {
            for leftIndex in 0..<(observations.count - 1) {
                for rightIndex in (leftIndex + 1)..<observations.count {
                    let distance = try distanceCalculator(observations[leftIndex], observations[rightIndex])
                    guard distance.isFinite else { throw BridgeError("WECHAT_IDENTITY_SAMPLES_UNSTABLE") }
                    maximumDistance = max(maximumDistance, distance)
                }
            }
        }
        guard maximumDistance <= 0.18 else { throw BridgeError("WECHAT_IDENTITY_SAMPLES_UNSTABLE") }
        let archives = try observations.map {
            try NSKeyedArchiver.archivedData(withRootObject: $0, requiringSecureCoding: true)
        }
        guard archives.allSatisfy({ $0.count >= 32 && $0.count <= 24_576 }),
              Set(archives.map(\.count)).count == 1 else {
            throw BridgeError("WECHAT_IDENTITY_ENROLLMENT_SAMPLE_INVALID")
        }
        return WechatIdentityCaptureReceipt(
            fingerprintVersion: "vision-featureprint-v1",
            windowRevision: expectedWindowRevision,
            leftPaneProofHash: evidenceProof("wechat-candidate-left-v2", line: left, revision: expectedWindowRevision),
            headerProofHash: evidenceProof("wechat-candidate-header-v2", line: header, revision: expectedWindowRevision),
            referenceSamples: archives.map { $0.base64EncodedString() },
            observedFingerprints: archives.map { sha256Data($0) },
            maximumPairwiseDistance: maximumDistance
        )
    }

    private static func uniqueRequestedWindow(
        _ windows: [WindowDescriptor],
        windowID: UInt32,
        bundleID: String,
        title: String
    ) -> WindowDescriptor? {
        let matches = windows.filter { window in
            window.bundleID == bundleID && window.title == title
        }
        guard matches.count == 1, matches[0].windowID == windowID else { return nil }
        return matches[0]
    }

    private static func requestedWindowMatches(
        _ windows: [WindowDescriptor],
        expectedDescriptor: WindowDescriptor,
        expectedRevision: String
    ) -> Bool {
        guard let catalogWindow = uniqueRequestedWindow(
            windows,
            windowID: expectedDescriptor.windowID,
            bundleID: expectedDescriptor.bundleID,
            title: expectedDescriptor.title
        ) else { return false }
        return catalogWindow == expectedDescriptor &&
            WriteCapabilityAuthorization.windowRevision(catalogWindow) == expectedRevision
    }

    private static func identityCaptureFrame(windowID: UInt32) throws -> (CGImage, [OCRLine]) {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("wechat-enrollment-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: url) }
        try capture(windowID: windowID, outputURL: url)
        guard let image = NSImage(contentsOf: url),
              let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            throw BridgeError("WECHAT_IDENTITY_CAPTURE_INVALID")
        }
        return (cgImage, try VisionOCR.recognize(fileURL: url))
    }

    private static func enrollmentEvidence(
        lines: [OCRLine],
        conversationTitle: String,
        expectedPreviewHash: String
    ) throws -> (left: OCRLine, header: OCRLine) {
        let left = lines.filter {
            $0.confidence >= 0.95 && $0.bounds.x < 0.31 &&
                $0.text.precomposedStringWithCanonicalMapping
                    .trimmingCharacters(in: .whitespacesAndNewlines) == conversationTitle
        }
        let headers = lines.filter {
            $0.confidence >= 0.95 && $0.bounds.x >= 0.32 && $0.bounds.y >= 0.86 &&
                $0.text.precomposedStringWithCanonicalMapping
                    .trimmingCharacters(in: .whitespacesAndNewlines) == conversationTitle
        }
        guard left.count == 1, headers.count == 1,
              let title = left.first, let header = headers.first else {
            throw BridgeError("WECHAT_IDENTITY_EVIDENCE_AMBIGUOUS")
        }
        let titleCenter = title.bounds.y + title.bounds.height / 2
        let previews = lines.filter { line in
            guard line != title, line.bounds.x < 0.31, line.confidence >= 0.5 else { return false }
            let offset = titleCenter - (line.bounds.y + line.bounds.height / 2)
            return offset >= 0.015 && offset <= 0.08 &&
                line.text.range(of: "[\\p{L}\\p{N}]", options: .regularExpression) != nil
        }
        guard previews.count == 1, let preview = previews.first,
              previewDigest(preview.text) == expectedPreviewHash else {
            throw BridgeError("WECHAT_IDENTITY_PREVIEW_MISMATCH")
        }
        return (title, header)
    }

    private static func previewDigest(_ text: String) -> String {
        let normalized = text.precomposedStringWithCanonicalMapping
            .replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return sha256Data(Data(["wechat-conversation-preview-v1", normalized].joined(separator: "\0").utf8))
    }

    private static func evidenceProof(_ prefix: String, line: OCRLine, revision: String) -> String {
        sha256Data(Data([
            prefix,
            line.text.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines),
            String(line.confidence), String(line.bounds.x), String(line.bounds.y),
            String(line.bounds.width), String(line.bounds.height), revision,
        ].joined(separator: "\0").utf8))
    }

    private static func sha256Data(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func isLowerHexHash(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }

    static func matchWechatIdentityRows(
        windowID: UInt32,
        expectedBundleID: String,
        expectedTitle: String,
        expectedConversationTitle: String,
        proofPhase: String,
        enrollment: WechatIdentityEnrollmentPayload,
        windowListProvider: (String) throws -> [WindowDescriptor] = { try listWindows(bundleID: $0) },
        descriptorProvider: (UInt32) throws -> WindowDescriptor? = { try descriptor(windowID: $0) },
        frameProvider: (UInt32) throws -> (CGImage, [OCRLine]) = { try identityCaptureFrame(windowID: $0) },
        selectedRowProvider: (WindowDescriptor, String) throws -> [WechatSelectedRowAttestation] = {
            window, title in try selectedConversationRows(window: window, expectedTitle: title)
        }
    ) throws -> [WechatIdentityMatchResult] {
        guard expectedBundleID == "com.tencent.xinWeChat", expectedTitle == "微信",
              proofPhase == "pre-click" || proofPhase == "selected" else {
            throw BridgeError("WECHAT_IDENTITY_TARGET_NOT_ALLOWED")
        }
        let enrollmentTitle = enrollment.visibleName ?? enrollment.displayName
        let validEnrollmentID = enrollment.version == 1
            ? enrollment.conversationId != nil
            : enrollment.contactId?.range(
                of: "^(?:example-contact|contact-[a-f0-9]{32})$",
                options: .regularExpression
            ) != nil
        guard (enrollment.version == 1 || enrollment.version == 2),
              enrollment.fingerprintVersion == "vision-featureprint-v1",
              enrollmentTitle == expectedConversationTitle,
              validEnrollmentID,
              enrollment.referenceSamples.count >= 3,
              enrollment.referenceSamples.count <= 5 else {
            throw BridgeError("WECHAT_IDENTITY_ENROLLMENT_INVALID")
        }
        guard let initialCatalogWindow = uniqueRequestedWindow(
                try windowListProvider(expectedBundleID),
                windowID: windowID,
                bundleID: expectedBundleID,
                title: expectedTitle
              ),
              let initialDescriptor = try descriptorProvider(windowID),
              initialCatalogWindow == initialDescriptor else {
            throw BridgeError("WECHAT_IDENTITY_WINDOW_MISMATCH")
        }
        let windowRevision = WriteCapabilityAuthorization.windowRevision(initialDescriptor)
        guard WriteCapabilityAuthorization.windowRevision(initialCatalogWindow) == windowRevision else {
            throw BridgeError("WECHAT_IDENTITY_WINDOW_MISMATCH")
        }
        let initialSelectedRow = proofPhase == "selected" ? try uniqueSelectedRow(
            selectedRowProvider(initialDescriptor, expectedConversationTitle),
            expectedTitle: expectedConversationTitle
        ) : nil
        let references = try enrollment.referenceSamples.map { encoded -> VNFeaturePrintObservation in
            guard let data = Data(base64Encoded: encoded),
                  let observation = try NSKeyedUnarchiver.unarchivedObject(
                    ofClass: VNFeaturePrintObservation.self,
                    from: data
                  ) else {
                throw BridgeError("WECHAT_IDENTITY_ENROLLMENT_SAMPLE_INVALID")
            }
            return observation
        }
        var captures: [(CGImage, [OCRLine])] = []
        for _ in 0..<3 {
            guard requestedWindowMatches(
                    try windowListProvider(expectedBundleID),
                    expectedDescriptor: initialDescriptor,
                    expectedRevision: windowRevision
                  ),
                  let beforeFrameDescriptor = try descriptorProvider(windowID),
                  beforeFrameDescriptor == initialDescriptor,
                  WriteCapabilityAuthorization.windowRevision(beforeFrameDescriptor) == windowRevision else {
                throw BridgeError("WECHAT_IDENTITY_SELECTION_CHANGED")
            }
            if proofPhase == "selected" {
                guard try uniqueSelectedRow(
                    selectedRowProvider(beforeFrameDescriptor, expectedConversationTitle),
                    expectedTitle: expectedConversationTitle
                ) == initialSelectedRow else {
                    throw BridgeError("WECHAT_IDENTITY_SELECTION_CHANGED")
                }
            }
            captures.append(try frameProvider(windowID))
            guard requestedWindowMatches(
                    try windowListProvider(expectedBundleID),
                    expectedDescriptor: initialDescriptor,
                    expectedRevision: windowRevision
                  ),
                  let afterFrameDescriptor = try descriptorProvider(windowID),
                  afterFrameDescriptor == initialDescriptor,
                  WriteCapabilityAuthorization.windowRevision(afterFrameDescriptor) == windowRevision else {
                throw BridgeError("WECHAT_IDENTITY_SELECTION_CHANGED")
            }
            if proofPhase == "selected" {
                guard try uniqueSelectedRow(
                    selectedRowProvider(afterFrameDescriptor, expectedConversationTitle),
                    expectedTitle: expectedConversationTitle
                ) == initialSelectedRow else {
                    throw BridgeError("WECHAT_IDENTITY_SELECTION_CHANGED")
                }
            }
            Thread.sleep(forTimeInterval: 0.06)
        }
        guard let firstLines = captures.first?.1 else {
            throw BridgeError("WECHAT_IDENTITY_CAPTURE_INVALID")
        }
        guard requestedWindowMatches(
                try windowListProvider(expectedBundleID),
                expectedDescriptor: initialDescriptor,
                expectedRevision: windowRevision
              ),
              let finalDescriptor = try descriptorProvider(windowID),
              finalDescriptor == initialDescriptor,
              WriteCapabilityAuthorization.windowRevision(finalDescriptor) == windowRevision else {
            throw BridgeError("WECHAT_IDENTITY_WINDOW_MISMATCH")
        }
        let finalSelectedRow = proofPhase == "selected" ? try uniqueSelectedRow(
            selectedRowProvider(finalDescriptor, expectedConversationTitle),
            expectedTitle: expectedConversationTitle
        ) : nil
        guard proofPhase == "pre-click" || initialSelectedRow == finalSelectedRow else {
            throw BridgeError("WECHAT_IDENTITY_SELECTION_CHANGED")
        }
        let selectionTitle = finalSelectedRow?.title
        let selectionY = finalSelectedRow?.normalizedY
        let selectionProofHash = finalSelectedRow.map {
            selectedRowProofHash(
                title: $0.title,
                normalizedY: $0.normalizedY,
                windowRevision: windowRevision
            )
        }
        let rows = firstLines.filter { line in
            line.text == expectedConversationTitle &&
                line.confidence >= 0.90 &&
                line.bounds.x < 0.36
        }
        return try rows.compactMap { row in
            let observations = try captures.map { image, _ in
                try featurePrint(image: image, row: row)
            }
            var distances: [Float] = []
            for observation in observations {
                var best = Float.greatestFiniteMagnitude
                for reference in references {
                    var distance: Float = 0
                    try observation.computeDistance(&distance, to: reference)
                    best = min(best, distance)
                }
                distances.append(best)
            }
            let archived = try observations.map {
                try NSKeyedArchiver.archivedData(withRootObject: $0, requiringSecureCoding: true)
            }
            var digestInput = Data()
            for sample in archived { digestInput.append(sample) }
            let fingerprint = SHA256.hash(data: digestInput)
                .map { String(format: "%02x", $0) }.joined()
            return WechatIdentityMatchResult(
                normalizedY: row.bounds.y + row.bounds.height / 2,
                distance: worstIdentityMatchDistance(distances),
                observedFingerprint: fingerprint,
                fingerprintVersion: "vision-featureprint-v1",
                proofPhase: proofPhase,
                selected: proofPhase == "selected" && selectionTitle == expectedConversationTitle &&
                    selectionY.map { abs($0 - (row.bounds.y + row.bounds.height / 2)) <= 0.04 } == true,
                selectedRowTitle: selectionTitle,
                selectedRowNormalizedY: selectionY,
                selectionProofHash: selectionProofHash
            )
        }
    }

    static func selectedRowProofHash(
        title: String,
        normalizedY: Double,
        windowRevision: String
    ) -> String {
        let stableY = String(
            format: "%.6f",
            locale: Locale(identifier: "en_US_POSIX"),
            normalizedY
        )
        return sha256Data(Data([
            "wechat-selected-conversation-row-v1",
            title.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines),
            stableY,
            windowRevision,
        ].joined(separator: "\0").utf8))
    }

    static func uniqueSelectedRow(
        _ rows: [WechatSelectedRowAttestation],
        expectedTitle: String
    ) throws -> WechatSelectedRowAttestation {
        guard rows.count == 1, let row = rows.first,
              row.title.precomposedStringWithCanonicalMapping
                .trimmingCharacters(in: .whitespacesAndNewlines) == expectedTitle else {
            throw BridgeError("WECHAT_IDENTITY_SELECTION_AMBIGUOUS")
        }
        return row
    }

    static func worstIdentityMatchDistance(_ distances: [Float]) -> Float {
        distances.max() ?? Float.greatestFiniteMagnitude
    }

    private static func selectedConversationRows(
        window: WindowDescriptor,
        expectedTitle: String
    ) throws -> [WechatSelectedRowAttestation] {
        guard AXIsProcessTrusted() else { return [] }
        let application = AXUIElementCreateApplication(window.processID)
        let matchingWindows = axElements(application, kAXWindowsAttribute).filter { element in
            guard let frame = axFrame(element) else { return false }
            return approximatelyEqual(frame, window.bounds)
        }
        guard matchingWindows.count == 1, let root = matchingWindows.first else {
            throw BridgeError("WECHAT_IDENTITY_AX_WINDOW_AMBIGUOUS")
        }
        guard !axSearchIsActive(root) else {
            throw BridgeError("WECHAT_IDENTITY_SEARCH_RESULTS_ACTIVE")
        }
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        var visited = 0
        var matches: [WechatSelectedRowAttestation] = []
        while !queue.isEmpty && visited < 4_096 {
            let (element, depth) = queue.removeFirst()
            visited += 1
            if axBoolean(element, kAXSelectedAttribute),
               axSubtreeContainsTitle(element, expectedTitle, maximumDepth: 4),
               let frame = axFrame(element), window.bounds.height > 0 {
                let centerFromTop = frame.midY - window.bounds.y
                let normalizedY = 1 - centerFromTop / window.bounds.height
                if normalizedY.isFinite && (0...1).contains(normalizedY) {
                    matches.append(WechatSelectedRowAttestation(
                        title: expectedTitle,
                        normalizedY: normalizedY
                    ))
                }
            }
            if depth < 12 {
                for child in axChildren(element) { queue.append((child, depth + 1)) }
            }
        }
        return matches
    }

    private static func axSearchIsActive(_ root: AXUIElement) -> Bool {
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        var visited = 0
        while !queue.isEmpty && visited < 4_096 {
            let (element, depth) = queue.removeFirst()
            visited += 1
            let role = axString(element, kAXRoleAttribute) ?? ""
            let subrole = axString(element, kAXSubroleAttribute) ?? ""
            let isSearchField = role == "AXTextField" ||
                subrole.localizedCaseInsensitiveContains("search")
            if isSearchField {
                let value = (axString(element, kAXValueAttribute) ?? "")
                    .precomposedStringWithCanonicalMapping
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                if axBoolean(element, kAXFocusedAttribute) ||
                    (!value.isEmpty && value != "搜索" && value.lowercased() != "search") {
                    return true
                }
            }
            if depth < 12 {
                for child in axChildren(element) { queue.append((child, depth + 1)) }
            }
        }
        return false
    }

    private static func approximatelyEqual(_ left: CGRect, _ right: OCRBounds) -> Bool {
        abs(left.origin.x - right.x) <= 1 && abs(left.origin.y - right.y) <= 1 &&
            abs(left.width - right.width) <= 1 && abs(left.height - right.height) <= 1
    }

    private static func axSubtreeContainsTitle(
        _ root: AXUIElement,
        _ expectedTitle: String,
        maximumDepth: Int
    ) -> Bool {
        var queue: [(AXUIElement, Int)] = [(root, 0)]
        while !queue.isEmpty {
            let (element, depth) = queue.removeFirst()
            let values = [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute].compactMap {
                axString(element, $0)
            }
            if values.contains(where: {
                $0.precomposedStringWithCanonicalMapping.trimmingCharacters(in: .whitespacesAndNewlines) ==
                    expectedTitle
            }) { return true }
            if depth < maximumDepth {
                for child in axChildren(element) { queue.append((child, depth + 1)) }
            }
        }
        return false
    }

    private static func axChildren(_ element: AXUIElement) -> [AXUIElement] {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, kAXChildrenAttribute as CFString, &raw
        ) == .success, let children = raw as? [AXUIElement] else { return [] }
        return children
    }

    private static func axElements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, attribute as CFString, &raw
        ) == .success, let elements = raw as? [AXUIElement] else { return [] }
        return elements
    }

    private static func axString(_ element: AXUIElement, _ attribute: String) -> String? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, attribute as CFString, &raw
        ) == .success else { return nil }
        return raw as? String
    }

    private static func axBoolean(_ element: AXUIElement, _ attribute: String) -> Bool {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, attribute as CFString, &raw
        ) == .success else { return false }
        return (raw as? NSNumber)?.boolValue == true
    }

    private static func axFrame(_ element: AXUIElement) -> CGRect? {
        var rawPosition: CFTypeRef?
        var rawSize: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element, kAXPositionAttribute as CFString, &rawPosition
        ) == .success, AXUIElementCopyAttributeValue(
            element, kAXSizeAttribute as CFString, &rawSize
        ) == .success, let positionValue = rawPosition, let sizeValue = rawSize,
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(
            unsafeBitCast(positionValue, to: AXValue.self), .cgPoint, &position
        ), AXValueGetValue(
            unsafeBitCast(sizeValue, to: AXValue.self), .cgSize, &size
        ) else {
            return nil
        }
        return CGRect(origin: position, size: size)
    }

    private static func featurePrint(image: CGImage, row: OCRLine) throws -> VNFeaturePrintObservation {
        let width = Double(image.width)
        let height = Double(image.height)
        let centerY = row.bounds.y + row.bounds.height / 2
        let normalizedX = max(0.015, row.bounds.x - 0.12)
        let normalizedY = max(0.0, centerY - 0.05)
        let normalizedWidth = min(0.10, 1 - normalizedX)
        let normalizedHeight = min(0.10, 1 - normalizedY)
        let cropRect = CGRect(
            x: normalizedX * width,
            y: (1 - normalizedY - normalizedHeight) * height,
            width: normalizedWidth * width,
            height: normalizedHeight * height
        ).integral
        guard let crop = image.cropping(to: cropRect) else {
            throw BridgeError("WECHAT_IDENTITY_CROP_INVALID")
        }
        let request = VNGenerateImageFeaturePrintRequest()
        try VNImageRequestHandler(cgImage: crop).perform([request])
        guard let observation = request.results?.first as? VNFeaturePrintObservation else {
            throw BridgeError("WECHAT_IDENTITY_FEATURE_UNAVAILABLE")
        }
        return observation
    }

    static func typeText(
        _ text: String,
        windowID: UInt32,
        expectedBundleID: String,
        expectedTitle: String,
        expectedConversationTitle: String,
        writeToken: String,
        slotKey: String,
        capability: TextMutationCapabilityPayload
    ) throws -> ComposerMutationReceipt {
        if case let .dynamic(dynamicCapability) = capability,
           writeToken != dynamicCapability.capabilityId {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        guard AXIsProcessTrusted() else {
            throw BridgeError("ACCESSIBILITY_PERMISSION_REQUIRED")
        }
        guard let window = try descriptor(windowID: windowID),
              window.bundleID == expectedBundleID,
              window.title == expectedTitle else {
            throw BridgeError("WECHAT_WRITE_IDENTITY_MISMATCH")
        }
        let allowsDynamicTitle: Bool
        if case let .dynamic(dynamicCapability) = capability {
            allowsDynamicTitle = true
            try DynamicTextTargetAuthorization.validateAndConsume(
                dynamicCapability,
                key: try DynamicTextTargetAuthorization.defaultKey(),
                expectedAction: text.isEmpty ? "clear-draft" : "replace-draft",
                conversationTitle: expectedConversationTitle,
                slotKey: slotKey,
                text: text,
                window: window
            )
        } else {
            allowsDynamicTitle = false
        }
        try focus(windowID: windowID)
        Thread.sleep(forTimeInterval: 0.2)
        try assertUniqueConversationHeader(
            windowID: windowID,
            expectedConversationTitle: expectedConversationTitle,
            prefix: "wechat-write",
            allowsDynamicTitle: allowsDynamicTitle
        )
        if case let .v1(v1Capability) = capability {
            try MutationCapabilityAuthorization.validate(
                v1Capability,
                token: writeToken,
                expectedAction: text.isEmpty ? "clear-draft" : "replace-draft",
                slotKey: slotKey,
                text: text,
                conversationTitle: expectedConversationTitle,
                window: window
            )
        }
        let port = SystemComposerClipboardPort(windowID: windowID)
        return text.isEmpty
            ? try ComposerClipboardTransaction.clear(using: port)
            : try ComposerClipboardTransaction.replace(text, using: port)
    }

    static func prepareWechatImageAttachment(
        windowID: UInt32,
        expectedBundleID: String,
        expectedTitle: String,
        expectedConversationTitle: String,
        writeToken: String,
        slotKey: String,
        imagePath: String,
        imageSha256: String,
        width: UInt32,
        height: UInt32,
        capability: MutationCapabilityPayload
    ) throws -> ImageAttachmentReceipt {
        guard expectedBundleID == "com.tencent.xinWeChat", expectedTitle == "微信",
              expectedConversationTitle == "文件传输助手" else {
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_TARGET_NOT_ALLOWED")
        }
        guard width == 1080, height == 1350 else {
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_CANDIDATE_MISMATCH")
        }
        guard AXIsProcessTrusted() else {
            throw BridgeError("ACCESSIBILITY_PERMISSION_REQUIRED")
        }
        let reviewedImage = try ReviewedImageFile.open(
            path: imagePath,
            expectedSha256: imageSha256,
            expectedWidth: Int(width),
            expectedHeight: Int(height)
        )
        guard let window = try descriptor(windowID: windowID),
              window.bundleID == expectedBundleID,
              window.title == expectedTitle else {
            throw BridgeError("WECHAT_WRITE_IDENTITY_MISMATCH")
        }
        let consumptionStore = FileImageAttachmentCapabilityConsumptionStore()
        try ImageAttachmentAdmission.authorizeThenFocus(
            assertHeader: {
                try assertUniqueConversationHeader(
                    windowID: windowID,
                    expectedConversationTitle: expectedConversationTitle,
                    prefix: "wechat-attach-pre"
                )
            },
            consumeCapability: {
                try ImageAttachmentCapabilityAuthorization.validateAndConsume(
                    capability,
                    token: writeToken,
                    slotKey: slotKey,
                    imageSha256: imageSha256,
                    conversationTitle: expectedConversationTitle,
                    window: window,
                    consumptionStore: consumptionStore
                )
            },
            focus: {
                try focus(windowID: windowID)
                Thread.sleep(forTimeInterval: 0.2)
            },
            reassertHeader: {
                try assertUniqueConversationHeader(
                    windowID: windowID,
                    expectedConversationTitle: expectedConversationTitle,
                    prefix: "wechat-attach-post"
                )
            }
        )
        return try ImageAttachmentAttempt.prepare(
            ImageAttachmentExpectation(
                receipt: reviewedImage.receipt,
                pixelSha256: reviewedImage.pixelSha256
            ),
            using: SystemComposerImageAttachmentPort(
                windowID: windowID,
                reviewedImage: reviewedImage
            ),
            consumptionStore: consumptionStore
        )
    }

    static func sendWechatImage(
        windowID: UInt32,
        expectedBundleID: String,
        expectedTitle: String,
        expectedConversationTitle: String,
        writeToken: String,
        slotKey: String,
        imagePath: String,
        imageSha256: String,
        width: UInt32,
        height: UInt32,
        capability: MutationCapabilityPayload
    ) throws -> WechatImageSendReceipt {
        guard expectedBundleID == "com.tencent.xinWeChat", expectedTitle == "微信",
              expectedConversationTitle == "示例联系人" else {
            throw BridgeError("WECHAT_IMAGE_SEND_TARGET_NOT_ALLOWED")
        }
        guard width == 1080, height == 1350 else {
            throw BridgeError("WECHAT_IMAGE_SEND_CANDIDATE_MISMATCH")
        }
        guard AXIsProcessTrusted() else {
            throw BridgeError("ACCESSIBILITY_PERMISSION_REQUIRED")
        }
        let reviewedImage = try ReviewedImageFile.open(
            path: imagePath,
            expectedSha256: imageSha256,
            expectedWidth: Int(width),
            expectedHeight: Int(height)
        )
        guard let window = try descriptor(windowID: windowID),
              window.bundleID == expectedBundleID,
              window.title == expectedTitle else {
            throw BridgeError("WECHAT_WRITE_IDENTITY_MISMATCH")
        }
        let consumptionStore = FileImageAttachmentCapabilityConsumptionStore()
        try ImageAttachmentAdmission.authorizeThenFocus(
            assertHeader: {
                try assertUniqueConversationHeader(
                    windowID: windowID,
                    expectedConversationTitle: expectedConversationTitle,
                    prefix: "wechat-image-send-pre"
                )
            },
            consumeCapability: {
                try ImageSendCapabilityAuthorization.validateAndConsume(
                    capability,
                    token: writeToken,
                    slotKey: slotKey,
                    imageSha256: imageSha256,
                    conversationTitle: expectedConversationTitle,
                    window: window,
                    consumptionStore: consumptionStore
                )
            },
            focus: {
                try focus(windowID: windowID)
                Thread.sleep(forTimeInterval: 0.2)
            },
            reassertHeader: {
                try assertUniqueConversationHeader(
                    windowID: windowID,
                    expectedConversationTitle: expectedConversationTitle,
                    prefix: "wechat-image-send-post"
                )
            }
        )
        let attachmentPort = SystemComposerImageAttachmentPort(
            windowID: windowID,
            reviewedImage: reviewedImage
        )
        return try WechatImageSendTransaction.send(
            ImageAttachmentExpectation(
                receipt: reviewedImage.receipt,
                pixelSha256: reviewedImage.pixelSha256
            ),
            reviewedImage: reviewedImage,
            attachmentPort: attachmentPort,
            submitPort: SystemWechatPreparedImageSubmitPort(
                windowID: windowID,
                attachmentPort: attachmentPort,
                expectedPixelSha256: reviewedImage.pixelSha256
            ),
            consumptionStore: consumptionStore
        )
    }

    static func recoverWechatImageQuarantine(
        windowID: UInt32,
        expectedBundleID: String,
        expectedTitle: String,
        expectedConversationTitle: String
    ) throws -> ImageAttachmentQuarantineRecoveryReceipt {
        guard expectedBundleID == "com.tencent.xinWeChat", expectedTitle == "微信",
              expectedConversationTitle == "示例联系人" else {
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_RECOVERY_TARGET_NOT_ALLOWED")
        }
        guard AXIsProcessTrusted() else {
            throw BridgeError("ACCESSIBILITY_PERMISSION_REQUIRED")
        }
        guard let window = try descriptor(windowID: windowID),
              window.bundleID == expectedBundleID,
              window.title == expectedTitle else {
            throw BridgeError("WECHAT_WRITE_IDENTITY_MISMATCH")
        }
        let store = FileImageAttachmentCapabilityConsumptionStore()
        do {
            try store.assertClean()
            return ImageAttachmentQuarantineRecoveryReceipt(
                status: "already-clean",
                archiveName: "",
                composerEmpty: true
            )
        } catch {
            guard (error as? BridgeError)?.code == "WECHAT_IMAGE_ATTACHMENT_DIRTY" else {
                throw error
            }
        }
        try assertUniqueConversationHeader(
            windowID: windowID,
            expectedConversationTitle: expectedConversationTitle,
            prefix: "wechat-image-recovery-pre"
        )
        try focus(windowID: windowID)
        Thread.sleep(forTimeInterval: 0.2)
        try assertUniqueConversationHeader(
            windowID: windowID,
            expectedConversationTitle: expectedConversationTitle,
            prefix: "wechat-image-recovery-focused"
        )
        return try ImageAttachmentQuarantineRecovery.recover(
            using: SystemComposerImageAttachmentPort(windowID: windowID),
            consumptionStore: store,
            reassertTarget: {
                try assertUniqueConversationHeader(
                    windowID: windowID,
                    expectedConversationTitle: expectedConversationTitle,
                    prefix: "wechat-image-recovery-final"
                )
            }
        )
    }

    static func readFocusedText() throws -> String {
        guard AXIsProcessTrusted() else { throw BridgeError("ACCESSIBILITY_PERMISSION_REQUIRED") }
        let systemWide = AXUIElementCreateSystemWide()
        var rawElement: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            systemWide,
            kAXFocusedUIElementAttribute as CFString,
            &rawElement
        ) == .success, let rawElement else {
            throw BridgeError("FOCUSED_ELEMENT_UNAVAILABLE")
        }
        let element = unsafeBitCast(rawElement, to: AXUIElement.self)
        var rawValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXValueAttribute as CFString,
            &rawValue
        ) == .success else {
            throw BridgeError("FOCUSED_TEXT_UNAVAILABLE")
        }
        return rawValue as? String ?? ""
    }

    static func pressEnter(writeToken: String?) throws {
        try WriteAuthorization.validate(token: writeToken)
        guard AXIsProcessTrusted() else {
            throw BridgeError("ACCESSIBILITY_PERMISSION_REQUIRED")
        }
        guard
            let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: true),
            let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: false)
        else {
            throw BridgeError("KEY_EVENT_CREATION_FAILED")
        }
        keyDown.post(tap: .cghidEventTap)
        keyUp.post(tap: .cghidEventTap)
    }

    static func submitWechatDraft(
        windowID: UInt32,
        expectedBundleID: String,
        expectedTitle: String,
        expectedConversationTitle: String,
        writeToken: String,
        slotKey: String,
        expectedDraftText: String,
        conversationProof: SubmitConversationProofPayload?,
        capability: TextSubmitCapabilityPayload
    ) throws {
        if case let .dynamic(dynamicCapability) = capability,
           writeToken != dynamicCapability.capabilityId {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        guard expectedBundleID == "com.tencent.xinWeChat", expectedTitle == "微信" else {
            throw BridgeError("WECHAT_SUBMIT_TARGET_NOT_ALLOWED")
        }
        let allowsDynamicTitle: Bool
        if case .dynamic = capability {
            allowsDynamicTitle = true
        } else {
            allowsDynamicTitle = false
        }
        guard ["文件传输助手", "示例联系人"].contains(expectedConversationTitle) || allowsDynamicTitle else {
            throw BridgeError("WECHAT_CONVERSATION_TARGET_NOT_ALLOWED")
        }
        guard AXIsProcessTrusted() else { throw BridgeError("ACCESSIBILITY_PERMISSION_REQUIRED") }
        guard let window = try descriptor(windowID: windowID),
              window.bundleID == expectedBundleID,
              window.title == expectedTitle else {
            throw BridgeError("WECHAT_SUBMIT_IDENTITY_MISMATCH")
        }
        if case let .dynamic(dynamicCapability) = capability {
            guard let conversationProof else {
                throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
            }
            let key = try DynamicTextTargetAuthorization.defaultKey()
            try DynamicTextTargetAuthorization.validateRequestBinding(
                dynamicCapability,
                proof: conversationProof,
                key: key,
                windowID: windowID,
                bundleID: expectedBundleID,
                title: expectedTitle,
                conversationTitle: expectedConversationTitle,
                token: writeToken,
                slotKey: slotKey,
                draftText: expectedDraftText
            )
            try DynamicTextTargetAuthorization.validateAndConsume(
                dynamicCapability,
                key: key,
                expectedAction: "submit-draft",
                conversationTitle: expectedConversationTitle,
                slotKey: slotKey,
                text: expectedDraftText,
                window: window
            )
        }
        try focus(windowID: windowID)
        Thread.sleep(forTimeInterval: 0.2)

        let captureURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("wechat-submit-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: captureURL) }
        try capture(windowID: windowID, outputURL: captureURL)
        let lines = try VisionOCR.recognize(fileURL: captureURL)
        guard SubmitConversationGuard.hasUniqueHeader(
            lines: lines,
            expected: expectedConversationTitle,
            allowsDynamicTitle: allowsDynamicTitle
        ) else {
            throw BridgeError("WECHAT_CONVERSATION_HEADER_MISMATCH")
        }
        guard let verifiedWindow = try descriptor(windowID: windowID),
              verifiedWindow.windowID == window.windowID,
              verifiedWindow.processID == window.processID,
              verifiedWindow.bundleID == window.bundleID,
              verifiedWindow.title == window.title else {
            throw BridgeError("WECHAT_SUBMIT_IDENTITY_MISMATCH")
        }
        let composerPort = SystemComposerClipboardPort(windowID: windowID)
        let focused = try ComposerClipboardTransaction.read(using: composerPort)
        let expected = expectedDraftText.precomposedStringWithCanonicalMapping
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        guard focused == expected else { throw BridgeError("WECHAT_SUBMIT_DRAFT_MISMATCH") }
        if case let .v1(v1Capability) = capability {
            try WriteCapabilityAuthorization.validateAndConsume(
                v1Capability,
                token: writeToken,
                slotKey: slotKey,
                draftText: expectedDraftText,
                conversationTitle: expectedConversationTitle,
                window: verifiedWindow
            )
        }
        if case let .dynamic(dynamicCapability) = capability {
            guard let conversationProof else {
                throw BridgeError("SENSITIVE_REQUEST_MALFORMED")
            }
            let finalCaptureURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("wechat-submit-final-\(UUID().uuidString).png")
            defer { try? FileManager.default.removeItem(at: finalCaptureURL) }
            try capture(windowID: windowID, outputURL: finalCaptureURL)
            let finalLines = try VisionOCR.recognize(fileURL: finalCaptureURL)
            guard SubmitConversationGuard.matchesFinalState(
                lines: finalLines,
                contactId: dynamicCapability.contactId,
                proof: conversationProof
            ) else {
                throw BridgeError("WECHAT_SUBMIT_CONVERSATION_CHANGED")
            }
        }
        try WechatSubmitShortcutTransaction.submit(
            expectedDraftText,
            using: SystemWechatSubmitShortcutPort(composerPort: composerPort)
        )
    }

    static func clickWechatPoint(
        windowID: UInt32,
        expectedBundleID: String,
        expectedTitle: String,
        region: String,
        normalizedX: Double,
        normalizedY: Double,
        writeToken: String,
        expectedConversationTitle: String,
        slotKey: String,
        capability: TextMutationCapabilityPayload
    ) throws {
        if case let .dynamic(dynamicCapability) = capability,
           writeToken != dynamicCapability.capabilityId {
            throw BridgeError("WECHAT_CONTACT_CAPABILITY_INVALID")
        }
        try WechatClickAuthorization.validate(
            bundleID: expectedBundleID,
            title: expectedTitle,
            region: region,
            x: normalizedX,
            y: normalizedY
        )
        guard AXIsProcessTrusted() else { throw BridgeError("ACCESSIBILITY_PERMISSION_REQUIRED") }
        guard let window = try descriptor(windowID: windowID),
              window.bundleID == expectedBundleID,
              window.title == expectedTitle else {
            throw BridgeError("WECHAT_CLICK_IDENTITY_MISMATCH")
        }
        let allowsDynamicTitle: Bool
        switch capability {
        case let .v1(v1Capability):
            allowsDynamicTitle = false
            try MutationCapabilityAuthorization.validate(
                v1Capability,
                token: writeToken,
                expectedAction: region == "conversation-list" ? "select-conversation" : "focus-composer",
                slotKey: slotKey,
                text: nil,
                conversationTitle: expectedConversationTitle,
                window: window
            )
        case let .dynamic(dynamicCapability):
            allowsDynamicTitle = true
            try DynamicTextTargetAuthorization.validateAndConsume(
                dynamicCapability,
                key: try DynamicTextTargetAuthorization.defaultKey(),
                expectedAction: region == "conversation-list" ? "select-conversation" : "focus-composer",
                conversationTitle: expectedConversationTitle,
                slotKey: slotKey,
                text: "",
                window: window
            )
        }
        try focus(windowID: windowID)
        Thread.sleep(forTimeInterval: 0.25)
        if region == "conversation-list" {
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("wechat-select-\(UUID().uuidString).png")
            defer { try? FileManager.default.removeItem(at: url) }
            try capture(windowID: windowID, outputURL: url)
            let lines = try VisionOCR.recognize(fileURL: url)
            guard ConversationListSelectionGuard.hasUniqueMatch(
                lines: lines,
                expected: expectedConversationTitle,
                normalizedY: normalizedY,
                allowsDynamicTitle: allowsDynamicTitle
            ) else {
                throw BridgeError("WECHAT_CONVERSATION_LABEL_NOT_UNIQUE")
            }
        } else {
            try assertUniqueConversationHeader(
                windowID: windowID,
                expectedConversationTitle: expectedConversationTitle,
                prefix: "wechat-focus",
                allowsDynamicTitle: allowsDynamicTitle
            )
        }
        let point = CGPoint(
            x: window.bounds.x + window.bounds.width * normalizedX,
            y: window.bounds.y + window.bounds.height * normalizedY
        )
        guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
              let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
              let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
            throw BridgeError("WECHAT_CLICK_EVENT_CREATION_FAILED")
        }
        move.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.05)
        down.setIntegerValueField(.mouseEventClickState, value: 1)
        up.setIntegerValueField(.mouseEventClickState, value: 1)
        down.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.05)
        up.post(tap: .cghidEventTap)
    }

    private static func assertUniqueConversationHeader(
        windowID: UInt32,
        expectedConversationTitle: String,
        prefix: String,
        allowsDynamicTitle: Bool = false
    ) throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: url) }
        try capture(windowID: windowID, outputURL: url)
        let lines = try VisionOCR.recognize(fileURL: url)
        guard SubmitConversationGuard.hasUniqueHeader(
            lines: lines,
            expected: expectedConversationTitle,
            allowsDynamicTitle: allowsDynamicTitle
        ) else {
            throw BridgeError("WECHAT_CONVERSATION_HEADER_MISMATCH")
        }
    }

    static func scrollReadOnly(
        windowID: UInt32,
        expectedBundleID: String,
        expectedTitle: String,
        deltaY: Int32
    ) throws {
        try ReadOnlyScrollAuthorization.validate(
            bundleID: expectedBundleID,
            title: expectedTitle,
            deltaY: deltaY
        )
        guard AXIsProcessTrusted() else {
            throw BridgeError("ACCESSIBILITY_PERMISSION_REQUIRED")
        }
        guard let window = try descriptor(windowID: windowID) else {
            throw BridgeError("WINDOW_NOT_FOUND")
        }
        guard window.bundleID == expectedBundleID, window.title == expectedTitle else {
            throw BridgeError("READ_ONLY_SCROLL_IDENTITY_MISMATCH")
        }
        try focus(windowID: windowID)

        let center = CGPoint(
            x: window.bounds.x + window.bounds.width / 2,
            y: window.bounds.y + window.bounds.height / 2
        )
        guard let move = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: center,
            mouseButton: .left
        ), let scroll = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 1,
            wheel1: deltaY,
            wheel2: 0,
            wheel3: 0
        ) else {
            throw BridgeError("SCROLL_EVENT_CREATION_FAILED")
        }
        move.post(tap: .cghidEventTap)
        scroll.post(tap: .cghidEventTap)
    }

    static func dragScrollbarReadOnly(
        windowID: UInt32,
        expectedBundleID: String,
        expectedTitle: String,
        fromY: Int32,
        toY: Int32
    ) throws {
        try ReadOnlyScrollbarDragAuthorization.validate(
            bundleID: expectedBundleID,
            title: expectedTitle,
            fromY: fromY,
            toY: toY
        )
        guard AXIsProcessTrusted() else {
            throw BridgeError("ACCESSIBILITY_PERMISSION_REQUIRED")
        }
        guard let window = try descriptor(windowID: windowID) else {
            throw BridgeError("WINDOW_NOT_FOUND")
        }
        guard window.bundleID == expectedBundleID, window.title == expectedTitle else {
            throw BridgeError("READ_ONLY_SCROLLBAR_DRAG_IDENTITY_MISMATCH")
        }
        guard Double(toY) <= window.bounds.height - 10 else {
            throw BridgeError("READ_ONLY_SCROLLBAR_DRAG_OUTSIDE_WINDOW")
        }
        try focus(windowID: windowID)

        let x = window.bounds.x + window.bounds.width - 6
        let start = CGPoint(x: x, y: window.bounds.y + Double(fromY))
        let end = CGPoint(x: x, y: window.bounds.y + Double(toY))
        guard
            let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: start, mouseButton: .left),
            let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left),
            let drag = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: end, mouseButton: .left),
            let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left)
        else {
            throw BridgeError("SCROLLBAR_DRAG_EVENT_CREATION_FAILED")
        }
        move.post(tap: .cghidEventTap)
        down.post(tap: .cghidEventTap)
        drag.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }

    static func diagnosePermissions() -> PermissionReport {
        PermissionReport(
            accessibility: AXIsProcessTrusted(),
            screenRecording: CGPreflightScreenCaptureAccess()
        )
    }

    private static func descriptor(windowID: UInt32) throws -> WindowDescriptor? {
        guard let windowInfo = CGWindowListCopyWindowInfo(
            [.optionIncludingWindow],
            CGWindowID(windowID)
        ) as? [[String: Any]],
        let info = windowInfo.first else {
            return nil
        }
        return descriptor(from: info, requiredBundleID: nil)
    }

    private static func descriptor(
        from info: [String: Any],
        requiredBundleID: String?
    ) -> WindowDescriptor? {
        guard
            let windowNumber = info[kCGWindowNumber as String] as? NSNumber,
            let processNumber = info[kCGWindowOwnerPID as String] as? NSNumber,
            let ownerName = info[kCGWindowOwnerName as String] as? String,
            let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
            (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
        else {
            return nil
        }
        let processID = pid_t(processNumber.int32Value)
        guard let bundleID = NSRunningApplication(processIdentifier: processID)?.bundleIdentifier else {
            return nil
        }
        if let requiredBundleID, requiredBundleID != bundleID {
            return nil
        }
        return WindowDescriptor(
            windowID: windowNumber.uint32Value,
            processID: processNumber.int32Value,
            bundleID: bundleID,
            title: info[kCGWindowName as String] as? String ?? "",
            ownerName: ownerName,
            bounds: OCRBounds(
                x: bounds.origin.x,
                y: bounds.origin.y,
                width: bounds.width,
                height: bounds.height
            )
        )
    }
}
