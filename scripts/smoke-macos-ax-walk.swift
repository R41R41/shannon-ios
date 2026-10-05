// An accessibility client for scripts/smoke-macos-navigation.sh: it reads the whole accessibility tree of
// one process again and again, as VoiceOver or Accessibility Inspector does, and reports when the process
// stops answering. It only reads; it never presses anything.
// usage: smoke-macos-ax-walk <pid> <seconds>
import ApplicationServices
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 3, let pid = pid_t(arguments[1]), let seconds = Double(arguments[2]) else {
    FileHandle.standardError.write(Data("usage: smoke-macos-ax-walk <pid> <seconds>\n".utf8))
    exit(2)
}
guard AXIsProcessTrusted() else {
    FileHandle.standardError.write(Data("This terminal is not allowed to use accessibility (System Settings › Privacy & Security › Accessibility).\n".utf8))
    exit(3)
}

let app = AXUIElementCreateApplication(pid)
AXUIElementSetMessagingTimeout(app, 2)
var stalls = 0
var worstStreak = 0
var streak = 0
var walks = 0
var maxElements = 0

func children(of element: AXUIElement) -> [AXUIElement]? {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
    if error == .cannotComplete { return nil }
    return value as? [AXUIElement] ?? []
}

let deadline = Date().addingTimeInterval(seconds)
while Date() < deadline {
    var queue: [(AXUIElement, Int)] = [(app, 0)]
    var count = 0
    var stalled = false
    while let (element, depth) = queue.popLast(), count < 4_000 {
        count += 1
        // Reading a label is what makes AppKit register each element, as a real client does.
        var title: CFTypeRef?
        _ = AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &title)
        guard depth < 40 else { continue }
        guard let next = children(of: element) else { stalled = true; break }
        queue.append(contentsOf: next.map { ($0, depth + 1) })
    }
    walks += 1
    maxElements = max(maxElements, count)
    if stalled { stalls += 1; streak += 1; worstStreak = max(worstStreak, streak) } else { streak = 0 }
    usleep(150_000)
}
print("ax-walk: walks=\(walks) elements=\(maxElements) stalls=\(stalls) worstStreak=\(worstStreak)")
// Three walks in a row without an answer (6 s or more) is a hang, not a busy moment.
exit(worstStreak >= 3 || maxElements < 10 ? 1 : 0)
