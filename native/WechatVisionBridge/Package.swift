// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "WechatVisionBridge",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "WechatVisionBridge", targets: ["WechatVisionBridge"]),
    ],
    targets: [
        .executableTarget(name: "WechatVisionBridge", path: "Sources"),
        .testTarget(
            name: "WechatVisionBridgeTests",
            dependencies: ["WechatVisionBridge"],
            path: "Tests"
        ),
    ]
)
