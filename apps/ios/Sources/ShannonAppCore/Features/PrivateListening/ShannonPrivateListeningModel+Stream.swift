#if os(macOS)
import Foundation

/// While 配信用の出力（OBS） is on, the Mac does not count as heard by the owner alone (roadmap A18 S5, review of
/// 2026-10-06): a stream records the app's sound whatever the output device (ScreenCaptureKit captures app audio), so
/// her messages for him alone are not said through his earphones, the answer to one is not listened for, and the
/// server is told that he is not privately listening. As on the iPhone with a friend in the call (`othersPresent`).
extension ShannonPrivateListeningModel {
    func followStreamOutput(isOn: @escaping @MainActor () -> Bool = { ShannonStreamOutput.shared.othersPresent }) {
        othersPresent = isOn()
        guard streamObserver == nil else { return }
        streamObserver = NotificationCenter.default.addObserver(forName: .shannonStreamOutputChanged, object: nil, queue: .main) { [weak self] note in
            let on = note.userInfo?[ShannonStreamOutput.isOnKey] as? Bool ?? false
            MainActor.assumeIsolated { self?.othersPresent = on }
        }
    }
}
#endif
