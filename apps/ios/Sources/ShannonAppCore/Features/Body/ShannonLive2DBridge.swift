import Foundation
import WebKit

/// Receives the page's messages and navigation events. The web view's content controller keeps
/// this object alive; it points back at the stage weakly, so the stage and the web view form no cycle.
@MainActor
final class ShannonLive2DBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    static let handlerName = "shannonBody"
    static let contextLossScript = """
    document.addEventListener('webglcontextlost', function () {
      try { window.webkit.messageHandlers.shannonBody.postMessage({ type: 'error', message: 'webglcontextlost' }); } catch (e) {}
    }, true);
    """
    static let contextProbeScript = """
    (function () {
      var canvas = document.querySelector('#stage canvas');
      if (!canvas) { return 'none'; }
      var context = canvas.getContext('webgl2');
      return context && !context.isContextLost() ? 'ok' : 'lost';
    })();
    """
    static let offlineRules = #"[{"trigger":{"url-filter":"^(https?|wss?|ftp):"},"action":{"type":"block"}}]"#

    private weak var stage: ShannonLive2DStage?
    private let generation: Int
    private let folder: URL

    init(stage: ShannonLive2DStage, generation: Int, folder: URL) {
        self.stage = stage
        self.generation = generation
        self.folder = folder.resolvingSymlinksInPath()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName, let parsed = ShannonLive2DMessage(body: message.body) else { return }
        stage?.receive(parsed, generation: generation)
    }

    /// Only the bundled page: nothing else is ever navigated to.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = navigationAction.request.url, url.isFileURL else { return .cancel }
        return url.resolvingSymlinksInPath().path.hasPrefix(folder.path + "/") ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        stage?.recover(generation: generation)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        stage?.recover(generation: generation)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        stage?.recover(generation: generation)
    }
}
