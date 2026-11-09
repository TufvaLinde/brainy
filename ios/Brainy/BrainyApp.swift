import SwiftUI

/// Brainy on the iPhone: the web app, given what only the phone can do natively —
/// Apple's on-device model and on-device speech recognition — through a small bridge.
@main
struct BrainyApp: App {
    var body: some Scene {
        WindowGroup {
            BrainyWebView()
                .ignoresSafeArea(.container, edges: .bottom)
                .background(Color.wall)
        }
    }
}

extension Color {
    /// The gallery wall the web app is set on.
    static let wall = Color(red: 0.957, green: 0.949, blue: 0.929)
}
