import CryptoKit
import Darwin
import Foundation

struct ImageAttachmentCapabilityBinding: Equatable {
    let capabilityId: String
    let action: String
    let target: String
    let slotHash: String
    let imageSha256: String
    let windowRevision: String
    let identityFingerprint: String
    let expiresAt: String

    fileprivate var canonicalDigest: String {
        sha256([
            "image-attachment-capability-v1",
            capabilityId,
            action,
            target,
            slotHash,
            imageSha256,
            windowRevision,
            identityFingerprint,
            expiresAt,
        ].joined(separator: "\0"))
    }

    fileprivate var receiptName: String {
        "capability-\(sha256("image-attachment-capability-id-v1\0\(capabilityId)"))"
    }
}

protocol ImageAttachmentCapabilityConsumptionStore {
    func assertClean() throws
    func consume(_ binding: ImageAttachmentCapabilityBinding) throws
    func markDirty() throws
}

struct FileImageAttachmentCapabilityConsumptionStore: ImageAttachmentCapabilityConsumptionStore {
    private static let processLock = NSLock()
    let rootURL: URL

    init(rootURL: URL = FileManager.default.temporaryDirectory
        .appendingPathComponent("wechat-ai-assistant-public-image-capabilities-v1", isDirectory: true)) {
        self.rootURL = rootURL
    }

    func assertClean() throws {
        try withLockedDirectory { directoryFD in
            try assertClean(directoryFD: directoryFD)
        }
    }

    func consume(_ binding: ImageAttachmentCapabilityBinding) throws {
        try withLockedDirectory { directoryFD in
            try assertClean(directoryFD: directoryFD)
            let receiptFD = Darwin.openat(
                directoryFD,
                binding.receiptName,
                O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                mode_t(S_IRUSR | S_IWUSR)
            )
            guard receiptFD >= 0 else {
                if errno == EEXIST { throw BridgeError("WRITE_CAPABILITY_ALREADY_USED") }
                throw BridgeError("WRITE_CAPABILITY_STORE_INVALID")
            }
            defer { _ = Darwin.close(receiptFD) }
            let receipt = Data("\(binding.canonicalDigest)\n".utf8)
            do {
                try writeAll(receipt, to: receiptFD)
                guard Darwin.fsync(receiptFD) == 0, Darwin.fsync(directoryFD) == 0 else {
                    throw BridgeError("WRITE_CAPABILITY_STORE_INVALID")
                }
            } catch {
                throw error
            }
        }
    }

    func markDirty() throws {
        try withLockedDirectory { directoryFD in
            let dirtyFD = Darwin.openat(
                directoryFD,
                ".dirty",
                O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                mode_t(S_IRUSR | S_IWUSR)
            )
            if dirtyFD < 0 {
                if errno == EEXIST { return }
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_QUARANTINE_FAILED")
            }
            defer { _ = Darwin.close(dirtyFD) }
            do {
                try writeAll(Data("dirty\n".utf8), to: dirtyFD)
                guard Darwin.fsync(dirtyFD) == 0, Darwin.fsync(directoryFD) == 0 else {
                    throw BridgeError("WECHAT_IMAGE_ATTACHMENT_QUARANTINE_FAILED")
                }
            } catch {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_QUARANTINE_FAILED")
            }
        }
    }

    func archiveDirtyMarker() throws -> ImageAttachmentQuarantineRecoveryReceipt {
        try withLockedDirectory { directoryFD in
            let dirtyFD = Darwin.openat(directoryFD, ".dirty", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
            if dirtyFD < 0 {
                guard errno == ENOENT else {
                    throw BridgeError("WECHAT_IMAGE_ATTACHMENT_RECOVERY_INVALID")
                }
                return ImageAttachmentQuarantineRecoveryReceipt(
                    status: "already-clean",
                    archiveName: "",
                    composerEmpty: true
                )
            }
            defer { _ = Darwin.close(dirtyFD) }
            var dirtyStat = stat()
            guard Darwin.fstat(dirtyFD, &dirtyStat) == 0,
                  (dirtyStat.st_mode & S_IFMT) == S_IFREG,
                  dirtyStat.st_nlink == 1,
                  dirtyStat.st_uid == getuid(),
                  (dirtyStat.st_mode & mode_t(0o777)) == mode_t(S_IRUSR | S_IWUSR),
                  dirtyStat.st_size == 6 else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_RECOVERY_INVALID")
            }
            var bytes = [UInt8](repeating: 0, count: 7)
            let count = Darwin.read(dirtyFD, &bytes, bytes.count)
            guard count == 6, Data(bytes.prefix(6)) == Data("dirty\n".utf8) else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_RECOVERY_INVALID")
            }
            let archiveDigestInput = [
                "image-attachment-dirty-archive-v1",
                String(dirtyStat.st_dev),
                String(dirtyStat.st_ino),
                String(dirtyStat.st_uid),
                String(dirtyStat.st_mode),
                String(dirtyStat.st_size),
                "dirty",
            ].joined(separator: "\0")
            let archiveName = "dirty-archive-" + sha256(archiveDigestInput)
            let existingFD = Darwin.openat(
                directoryFD,
                archiveName,
                O_RDONLY | O_NOFOLLOW | O_CLOEXEC
            )
            if existingFD >= 0 {
                _ = Darwin.close(existingFD)
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_RECOVERY_INVALID")
            }
            guard errno == ENOENT,
                  Darwin.renameat(directoryFD, ".dirty", directoryFD, archiveName) == 0,
                  Darwin.fsync(directoryFD) == 0 else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_RECOVERY_FAILED")
            }
            let archiveFD = Darwin.openat(
                directoryFD,
                archiveName,
                O_RDONLY | O_NOFOLLOW | O_CLOEXEC
            )
            guard archiveFD >= 0 else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_RECOVERY_FAILED")
            }
            defer { _ = Darwin.close(archiveFD) }
            var archiveStat = stat()
            guard Darwin.fstat(archiveFD, &archiveStat) == 0,
                  archiveStat.st_dev == dirtyStat.st_dev,
                  archiveStat.st_ino == dirtyStat.st_ino,
                  archiveStat.st_uid == dirtyStat.st_uid,
                  archiveStat.st_mode == dirtyStat.st_mode,
                  archiveStat.st_nlink == dirtyStat.st_nlink,
                  archiveStat.st_size == dirtyStat.st_size else {
                throw BridgeError("WECHAT_IMAGE_ATTACHMENT_RECOVERY_FAILED")
            }
            return ImageAttachmentQuarantineRecoveryReceipt(
                status: "recovered",
                archiveName: archiveName,
                composerEmpty: true
            )
        }
    }

    private func withLockedDirectory<T>(_ operation: (Int32) throws -> T) throws -> T {
        Self.processLock.lock()
        defer { Self.processLock.unlock() }
        let path = rootURL.path
        guard path.hasPrefix("/"), !path.contains("\0") else {
            throw BridgeError("WRITE_CAPABILITY_STORE_INVALID")
        }
        if Darwin.mkdir(path, mode_t(S_IRWXU)) != 0 && errno != EEXIST {
            throw BridgeError("WRITE_CAPABILITY_STORE_INVALID")
        }
        let directoryFD = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directoryFD >= 0 else { throw BridgeError("WRITE_CAPABILITY_STORE_INVALID") }
        defer { _ = Darwin.close(directoryFD) }
        var directoryStat = stat()
        guard Darwin.fstat(directoryFD, &directoryStat) == 0,
              (directoryStat.st_mode & S_IFMT) == S_IFDIR,
              directoryStat.st_uid == getuid(),
              (directoryStat.st_mode & mode_t(S_IRWXG | S_IRWXO)) == 0 else {
            throw BridgeError("WRITE_CAPABILITY_STORE_INVALID")
        }
        let lockFD = Darwin.openat(
            directoryFD,
            ".lock",
            O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC,
            mode_t(S_IRUSR | S_IWUSR)
        )
        guard lockFD >= 0 else { throw BridgeError("WRITE_CAPABILITY_STORE_INVALID") }
        defer { _ = Darwin.close(lockFD) }
        var lockStat = stat()
        guard Darwin.fstat(lockFD, &lockStat) == 0,
              (lockStat.st_mode & S_IFMT) == S_IFREG,
              lockStat.st_nlink == 1,
              lockStat.st_uid == getuid(),
              (lockStat.st_mode & mode_t(S_IRWXG | S_IRWXO)) == 0,
              Darwin.lockf(lockFD, F_LOCK, 0) == 0 else {
            throw BridgeError("WRITE_CAPABILITY_STORE_INVALID")
        }
        defer { _ = Darwin.lockf(lockFD, F_ULOCK, 0) }
        return try operation(directoryFD)
    }

    private func assertClean(directoryFD: Int32) throws {
        let dirtyFD = Darwin.openat(directoryFD, ".dirty", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if dirtyFD >= 0 {
            _ = Darwin.close(dirtyFD)
            throw BridgeError("WECHAT_IMAGE_ATTACHMENT_DIRTY")
        }
        guard errno == ENOENT else { throw BridgeError("WRITE_CAPABILITY_STORE_INVALID") }
    }

    private func writeAll(_ data: Data, to descriptor: Int32) throws {
        try data.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else { return }
            var written = 0
            while written < rawBuffer.count {
                let result = Darwin.write(
                    descriptor,
                    baseAddress.advanced(by: written),
                    rawBuffer.count - written
                )
                guard result > 0 else { throw BridgeError("WRITE_CAPABILITY_STORE_INVALID") }
                written += result
            }
        }
    }
}

enum ImageAttachmentAdmission {
    static func authorizeThenFocus(
        assertHeader: () throws -> Void,
        consumeCapability: () throws -> Void,
        focus: () throws -> Void,
        reassertHeader: () throws -> Void
    ) throws {
        try assertHeader()
        try consumeCapability()
        try focus()
        try reassertHeader()
    }
}

enum ImageAttachmentAttempt {
    static func prepare(
        _ expected: ImageAttachmentExpectation,
        using port: ComposerImageAttachmentPort,
        consumptionStore: any ImageAttachmentCapabilityConsumptionStore
    ) throws -> ImageAttachmentReceipt {
        do {
            return try ImageAttachmentClipboardTransaction.prepare(expected, using: port)
        } catch {
            let code = (error as? BridgeError)?.code
            if code == "WECHAT_IMAGE_ATTACHMENT_CLEAR_FAILED" || code == "PASTEBOARD_RESTORE_FAILED" {
                do {
                    try consumptionStore.markDirty()
                } catch {
                    throw BridgeError("WECHAT_IMAGE_ATTACHMENT_QUARANTINE_FAILED")
                }
            }
            throw error
        }
    }
}

private func sha256(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}
