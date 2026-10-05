#if DEBUG
import Foundation
import WebKit

/// A debug-only check of the page for a simulator run started with `-ShannonPreviewBodyProbe`:
/// every message of the page is appended to `tmp/shannon-body-probe.log`, and once the page is
/// ready a face is shown and one press on her face is made inside the page, which must come
/// back as a `touch` message. Nothing here exists in a release build.
extension ShannonLive2DStage {
    static var probes: Bool { ProcessInfo.processInfo.arguments.contains("-ShannonPreviewBodyProbe") }

    static var probeLog: URL { FileManager.default.temporaryDirectory.appendingPathComponent("shannon-body-probe.log") }

    func probe(_ message: ShannonLive2DMessage) {
        guard Self.probes else { return }
        let seconds = loadStartedAt.map { Date().timeIntervalSince($0) } ?? 0
        let line = String(format: "%.2f s  ", seconds) + String(describing: message).prefix(220) + "\n"
        if let handle = try? FileHandle(forWritingTo: Self.probeLog) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? Data(line.utf8).write(to: Self.probeLog)
        }
        guard case .ready = message else { return }
        setFrameStats(true)
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            self?.express("joyful", seconds: 20)
            try? await Task.sleep(for: .seconds(3))
            guard let self else { return }
            _ = try? await self.webView?.evaluateJavaScript(Self.pressOnFaceScript(body: self.body))
        }
    }

    /// The page listens to the mouse as well as to fingers; a press on the face is a poke. Her eyes alone stand in the middle.
    private static func pressOnFaceScript(body: ShannonLive2DBody) -> String {
        """
    (function () {
      var stage = document.getElementById('stage').getBoundingClientRect();
      var x = stage.left + stage.width / 2, y = stage.top + stage.height * \(body == .eyes ? "0.5" : "0.17");
      window.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0 }));
      setTimeout(function () { window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, button: 0 })); }, 90);
      return 'pressed';
    })();
    """
    }
}
#endif
