import SwiftUI

@main
struct SplatCaptureCompanionApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .task {
                    guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else {
                        return
                    }
                    await model.start()
                }
                .onOpenURL { url in
                    Task { await model.handleCallback(url) }
                }
        }
    }
}
