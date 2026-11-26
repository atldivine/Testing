// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PiControl",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "PiControl", targets: ["PiControl"]),
    ],
    targets: [
        .target(name: "PiControl"),
    ],
    swiftLanguageModes: [.v5]
)
