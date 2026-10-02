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
    /// One rule per scheme: the content-blocker pattern language has no alternation.
    static let offlineRules = #"""
    [{"trigger":{"url-filter":"^https?:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^wss?:"},"action":{"type":"block"}},
     {"trigger":{"url-filter":"^ftp:"},"action":{"type":"block"}}]
    """#
    static let offlineRulesIdentifier = "shannon-live2d-offline-v2"

    /// The compiled block list. The page is not loaded without it.
    static func offlineRuleList() async throws -> WKContentRuleList {
        guard let rules = try await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: offlineRulesIdentifier, encodedContentRuleList: offlineRules) else {
            throw CocoaError(.featureUnsupported)
        }
        return rules
    }

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
        guard !Self.isCancellation(error) else { return }
        stage?.recover(generation: generation)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard !Self.isCancellation(error) else { return }
        stage?.recover(generation: generation)
    }

    /// A navigation this delegate refused, or one that was cancelled, is not a broken page.
    static func isCancellation(_ error: Error) -> Bool {
        let error = error as NSError
        return (error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled)
            || (error.domain == "WebKitErrorDomain" && error.code == 102)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        stage?.recover(generation: generation)
    }
}
