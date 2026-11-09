import Foundation
import UIKit
import WebKit

/// What the web app can ask of the phone. Each call is a message whose reply resolves the
/// page's promise; speech, which arrives over time, is pushed to the page as events.
///
///   await window.webkit.messageHandlers.brainy.postMessage({ method: "status" })
///   await window.webkit.messageHandlers.brainy.postMessage({ method: "intent", args: { text, topics } })
///   await window.webkit.messageHandlers.brainy.postMessage({ method: "say", args: { system, prompt } })
///   await window.webkit.messageHandlers.brainy.postMessage({ method: "listen" })   // then "speech" events
///   await window.webkit.messageHandlers.brainy.postMessage({ method: "stopListening" })
@MainActor
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var webView: WKWebView?
    private let model = OnDeviceModel()
    private lazy var listener = Listener { [weak self] event in self?.emit("speech", event) }

    /// Runs first on every page: marks it as inside the app, and gives native code a way to send events.
    static let pageScript = """
    window.brainyNative = {
      app: true,
      handlers: {},
      on(name, fn) { (this.handlers[name] ||= []).push(fn); return () => { this.handlers[name] = this.handlers[name].filter(f => f !== fn) } },
      emit(name, data) { (this.handlers[name] || []).forEach(fn => fn(data)) },
      call(method, args) { return window.webkit.messageHandlers.brainy.postMessage({ method, args: args ?? {} }) },
    };
    """

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let method = body["method"] as? String else {
            return replyHandler(nil, "Send { method, args }")
        }
        let args = body["args"] as? [String: Any] ?? [:]
        Task { @MainActor in
            do {
                replyHandler(try await self.handle(method, args), nil)
            } catch {
                replyHandler(nil, error.localizedDescription)
            }
        }
    }

    private func handle(_ method: String, _ args: [String: Any]) async throws -> Any {
        switch method {
        case "status":
            return ["llm": model.availability, "speech": Listener.availability, "app": "ios"]
        case "intent":
            let text = args["text"] as? String ?? ""
            let topics = args["topics"] as? [String] ?? []
            return try await model.intent(for: text, topics: topics)
        case "say":
            return ["text": try await model.say(system: args["system"] as? String ?? "", prompt: args["prompt"] as? String ?? "")]
        case "listen":
            try await listener.start()
            return ["listening": true]
        case "stopListening":
            listener.stop()
            return ["listening": false]
        default:
            throw BridgeError.unknown(method)
        }
    }

    /// An event for the page, as JSON.
    private func emit(_ name: String, _ data: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: data), let text = String(data: json, encoding: .utf8) else { return }
        webView?.evaluateJavaScript("window.brainyNative && window.brainyNative.emit(\(quoted(name)), \(text))")
    }

    private func quoted(_ s: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: [s])
        return String(data: data ?? Data(), encoding: .utf8).map { String($0.dropFirst().dropLast()) } ?? "\"\""
    }
}

/// Links away from Brainy, to the sites articles came from, open in Safari: the web view keeps to Brainy's own domain.
extension Bridge: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let host = Bundle.main.object(forInfoDictionaryKey: "BrainyHost") as? String
        if let url = action.request.url, let scheme = url.scheme, ["http", "https"].contains(scheme),
           url.host != host, action.targetFrame?.isMainFrame ?? true, action.navigationType == .linkActivated || action.targetFrame == nil {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }
}

enum BridgeError: LocalizedError {
    case unknown(String)
    var errorDescription: String? {
        switch self { case .unknown(let method): "The app can't do \(method)" }
    }
}
