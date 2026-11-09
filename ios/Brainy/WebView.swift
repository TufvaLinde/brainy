import SwiftUI
import WebKit

/// The deployed web app in a web view. Its one domain is "app-bound", which is what lets
/// a web view keep a service worker and IndexedDB, so Brainy opens and works in airplane mode.
struct BrainyWebView: UIViewRepresentable {
    func makeCoordinator() -> Bridge { Bridge() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.limitsNavigationsToAppBoundDomains = true
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let content = config.userContentController
        // The page finds the app's abilities here, before any of its own code runs.
        content.addUserScript(WKUserScript(source: Bridge.pageScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: "brainy")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(Color.wall)
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.allowsBackForwardNavigationGestures = true
        #if DEBUG
        // Lets Safari on the Mac inspect the page: Develop menu → your iPhone → Brainy.
        webView.isInspectable = true
        #endif
        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator

        let host = Bundle.main.object(forInfoDictionaryKey: "BrainyHost") as? String ?? "brainy.vercel.app"
        webView.load(URLRequest(url: URL(string: "https://\(host)/")!))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
