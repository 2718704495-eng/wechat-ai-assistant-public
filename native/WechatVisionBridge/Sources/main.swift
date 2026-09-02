import Foundation

func versionPayload() throws -> Data {
    try JSONEncoder().encode(["protocolVersion": 1])
}

private func writeJSON<T: Encodable>(_ value: T, to output: FileHandle = .standardOutput) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    output.write(try encoder.encode(value))
    output.write(Data("\n".utf8))
}

private func writeError(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

private func option(_ name: String, in arguments: [String]) -> String? {
    guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else {
        return nil
    }
    return arguments[index + 1]
}

private func requireOption(_ name: String, in arguments: [String]) throws -> String {
    guard let value = option(name, in: arguments), !value.isEmpty else {
        throw BridgeError("MISSING_OPTION_\(name.dropFirst().uppercased().replacingOccurrences(of: "-", with: "_"))")
    }
    return value
}

private struct Success: Encodable {
    let ok = true
}

private struct CaptureResult: Encodable {
    let output: String
}

private struct FocusedTextResult: Encodable {
    let text: String
}

private struct SensitiveFailure: Encodable {
    let error: String
}

private func runSensitiveCommand(_ command: SensitiveWriteCommand) throws -> Bool {
    switch command {
    case let .typeText(windowID, bundleID, title, conversationTitle, token, slotKey, text, capability):
        try writeJSON(
            WindowAccess.typeText(
                text,
                windowID: windowID,
                expectedBundleID: bundleID,
                expectedTitle: title,
                expectedConversationTitle: conversationTitle,
                writeToken: token,
                slotKey: slotKey,
                capability: capability
            ),
            to: FileHandle(fileDescriptor: 3, closeOnDealloc: false)
        )
        return true
    case let .pressEnter(token):
        try WindowAccess.pressEnter(writeToken: token)
        return false
    case let .clickWechatPoint(
        windowID, bundleID, title, region, normalizedX, normalizedY,
        token, conversationTitle, slotKey, capability
    ):
        try WindowAccess.clickWechatPoint(
            windowID: windowID,
            expectedBundleID: bundleID,
            expectedTitle: title,
            region: region,
            normalizedX: normalizedX,
            normalizedY: normalizedY,
            writeToken: token,
            expectedConversationTitle: conversationTitle,
            slotKey: slotKey,
            capability: capability
        )
        return false
    case let .submitWechatDraft(
        windowID,
        bundleID,
        title,
        conversationTitle,
        token,
        slotKey,
        draftText,
        conversationProof,
        capability
    ):
        try WindowAccess.submitWechatDraft(
            windowID: windowID,
            expectedBundleID: bundleID,
            expectedTitle: title,
            expectedConversationTitle: conversationTitle,
            writeToken: token,
            slotKey: slotKey,
            expectedDraftText: draftText,
            conversationProof: conversationProof,
            capability: capability
        )
        return false
    case let .attachWechatImage(
        windowID, bundleID, title, conversationTitle, token, slotKey,
        imagePath, imageSha256, width, height, capability
    ):
        try writeJSON(
            WindowAccess.prepareWechatImageAttachment(
                windowID: windowID,
                expectedBundleID: bundleID,
                expectedTitle: title,
                expectedConversationTitle: conversationTitle,
                writeToken: token,
                slotKey: slotKey,
                imagePath: imagePath,
                imageSha256: imageSha256,
                width: width,
                height: height,
                capability: capability
            ),
            to: FileHandle(fileDescriptor: 3, closeOnDealloc: false)
        )
        return true
    case let .sendWechatImage(
        windowID, bundleID, title, conversationTitle, token, slotKey,
        imagePath, imageSha256, width, height, capability
    ):
        try writeJSON(
            WindowAccess.sendWechatImage(
                windowID: windowID,
                expectedBundleID: bundleID,
                expectedTitle: title,
                expectedConversationTitle: conversationTitle,
                writeToken: token,
                slotKey: slotKey,
                imagePath: imagePath,
                imageSha256: imageSha256,
                width: width,
                height: height,
                capability: capability
            ),
            to: FileHandle(fileDescriptor: 3, closeOnDealloc: false)
        )
        return true
    case let .recoverWechatImageQuarantine(windowID, bundleID, title, conversationTitle):
        try writeJSON(
            WindowAccess.recoverWechatImageQuarantine(
                windowID: windowID,
                expectedBundleID: bundleID,
                expectedTitle: title,
                expectedConversationTitle: conversationTitle
            ),
            to: FileHandle(fileDescriptor: 3, closeOnDealloc: false)
        )
        return true
    case let .matchWechatIdentity(windowID, bundleID, title, conversationTitle, proofPhase, enrollment):
        try writeJSON(
            WindowAccess.matchWechatIdentityRows(
                windowID: windowID,
                expectedBundleID: bundleID,
                expectedTitle: title,
                expectedConversationTitle: conversationTitle,
                proofPhase: proofPhase,
                enrollment: enrollment
            ),
            to: FileHandle(fileDescriptor: 3, closeOnDealloc: false)
        )
        return true
    case let .captureWechatIdentitySamples(
        windowID, bundleID, title, conversationTitle, expectedPreviewHash,
        expectedWindowRevision, sampleCount
    ):
        try writeJSON(
            WindowAccess.captureWechatIdentitySamples(
                windowID: windowID,
                expectedBundleID: bundleID,
                expectedTitle: title,
                expectedConversationTitle: conversationTitle,
                expectedPreviewHash: expectedPreviewHash,
                expectedWindowRevision: expectedWindowRevision,
                sampleCount: Int(sampleCount)
            ),
            to: FileHandle(fileDescriptor: 3, closeOnDealloc: false)
        )
        return true
    }
}

private func run(arguments: [String]) throws {
    guard let command = arguments.first else {
        throw BridgeError("COMMAND_REQUIRED")
    }
    switch command {
    case "version":
        FileHandle.standardOutput.write(try versionPayload())
        FileHandle.standardOutput.write(Data("\n".utf8))
    case "list-windows":
        try writeJSON(WindowAccess.listWindows(bundleID: requireOption("--bundle-id", in: arguments)))
    case "capture":
        guard let windowID = UInt32(try requireOption("--window-id", in: arguments)) else {
            throw BridgeError("INVALID_WINDOW_ID")
        }
        let output = try requireOption("--output", in: arguments)
        try WindowAccess.capture(windowID: windowID, outputURL: URL(fileURLWithPath: output))
        try writeJSON(CaptureResult(output: output))
    case "ocr":
        let input = try requireOption("--input", in: arguments)
        try writeJSON(VisionOCR.recognize(fileURL: URL(fileURLWithPath: input)))
    case "focus":
        guard let windowID = UInt32(try requireOption("--window-id", in: arguments)) else {
            throw BridgeError("INVALID_WINDOW_ID")
        }
        try WindowAccess.focus(windowID: windowID)
        try writeJSON(Success())
    case "write-command":
        guard arguments.count == 1 else { throw BridgeError("SENSITIVE_REQUEST_MALFORMED") }
        let response = FileHandle(fileDescriptor: 3, closeOnDealloc: false)
        let responseWritten = try runSensitiveCommand(
            try SensitiveCommandTransport.readFrame(.standardInput)
        )
        if !responseWritten {
            try writeJSON(Success(), to: response)
        }
    case "read-focused-text":
        try writeJSON(FocusedTextResult(text: try WindowAccess.readFocusedText()))
    case "scroll-read-only":
        guard let windowID = UInt32(try requireOption("--window-id", in: arguments)) else {
            throw BridgeError("INVALID_WINDOW_ID")
        }
        guard let deltaY = Int32(try requireOption("--delta-y", in: arguments)) else {
            throw BridgeError("INVALID_SCROLL_DELTA")
        }
        try WindowAccess.scrollReadOnly(
            windowID: windowID,
            expectedBundleID: try requireOption("--bundle-id", in: arguments),
            expectedTitle: try requireOption("--title", in: arguments),
            deltaY: deltaY
        )
        try writeJSON(Success())
    case "drag-scrollbar-read-only":
        guard let windowID = UInt32(try requireOption("--window-id", in: arguments)) else {
            throw BridgeError("INVALID_WINDOW_ID")
        }
        guard let fromY = Int32(try requireOption("--from-y", in: arguments)),
              let toY = Int32(try requireOption("--to-y", in: arguments)) else {
            throw BridgeError("INVALID_SCROLLBAR_DRAG_COORDINATES")
        }
        try WindowAccess.dragScrollbarReadOnly(
            windowID: windowID,
            expectedBundleID: try requireOption("--bundle-id", in: arguments),
            expectedTitle: try requireOption("--title", in: arguments),
            fromY: fromY,
            toY: toY
        )
        try writeJSON(Success())
    case "diagnose-permissions":
        try writeJSON(WindowAccess.diagnosePermissions())
    default:
        throw BridgeError("UNKNOWN_COMMAND")
    }
}

let bridgeArguments = Array(CommandLine.arguments.dropFirst())
do {
    try run(arguments: bridgeArguments)
} catch {
    let code = (error as? BridgeError)?.code ?? "BRIDGE_FAILURE"
    if bridgeArguments.first == "write-command" {
        let response = FileHandle(fileDescriptor: 3, closeOnDealloc: false)
        try? writeJSON(SensitiveFailure(error: code), to: response)
    } else {
        writeError(code)
    }
    exit(1)
}
