// swift-tools-version:5.5
import PackageDescription

let package = Package(
    name: "tauri-plugin-icloud-folder",
    platforms: [
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-icloud-folder",
            type: .static,
            targets: ["tauri-plugin-icloud-folder"]
        ),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
    ],
    targets: [
        .target(
            name: "tauri-plugin-icloud-folder",
            dependencies: [
                .byName(name: "Tauri"),
            ],
            path: "Sources"
        ),
    ]
)
