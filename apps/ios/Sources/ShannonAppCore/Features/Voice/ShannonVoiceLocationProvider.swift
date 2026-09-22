import Foundation

enum ShannonVoiceLocationIntent {
    static func needsCurrentLocation(_ transcript: String) -> Bool {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        return [
            "現在地", "今いる場所", "ここから", "この辺", "この近く",
            "近くの", "周辺", "最寄り", "ここはどこ", "今どこ",
            "行き方", "道順", "徒歩", "交通", "乗り換え", "乗換",
            "バス", "電車", "タクシー",
        ].contains { text.localizedCaseInsensitiveContains($0) }
    }
}

#if os(iOS)
import CoreLocation

@MainActor
final class ShannonVoiceLocationProvider: NSObject, @preconcurrency CLLocationManagerDelegate {
    static let shared = ShannonVoiceLocationProvider()

    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<ShannonVoiceDeviceLocationDTO?, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var didRequestLocation = false

    private override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    func currentLocation() async -> ShannonVoiceDeviceLocationDTO? {
        guard continuation == nil else { return nil }
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            didRequestLocation = false
            timeoutTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(10))
                self?.finish(nil)
            }
            switch manager.authorizationStatus {
            case .authorizedAlways, .authorizedWhenInUse:
                requestLocation()
            case .notDetermined:
                manager.requestWhenInUseAuthorization()
            case .denied, .restricted:
                finish(nil)
            @unknown default:
                finish(nil)
            }
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard continuation != nil else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            requestLocation()
        case .denied, .restricted:
            finish(nil)
        case .notDetermined:
            break
        @unknown default:
            finish(nil)
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let now = Date()
        let location = locations.reversed().first {
            $0.horizontalAccuracy >= 0
                && $0.horizontalAccuracy <= 1_000
                && abs(now.timeIntervalSince($0.timestamp)) <= 120
        }
        guard let location else {
            finish(nil)
            return
        }
        finish(ShannonVoiceDeviceLocationDTO(
            latitude: (location.coordinate.latitude * 10_000).rounded() / 10_000,
            longitude: (location.coordinate.longitude * 10_000).rounded() / 10_000,
            accuracyMeters: location.horizontalAccuracy.rounded(),
            observedAt: ISO8601DateFormatter().string(from: location.timestamp)
        ))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        finish(nil)
    }

    private func requestLocation() {
        guard !didRequestLocation else { return }
        didRequestLocation = true
        manager.requestLocation()
    }

    private func finish(_ location: ShannonVoiceDeviceLocationDTO?) {
        guard let continuation else { return }
        self.continuation = nil
        timeoutTask?.cancel()
        timeoutTask = nil
        continuation.resume(returning: location)
    }
}
#endif
