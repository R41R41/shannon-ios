import Foundation
#if os(iOS)
@preconcurrency import AVFoundation
#elseif os(macOS)
import CoreAudio
#endif

/// Where this device's sound comes out now, and a signal each time that changes.
@MainActor
public protocol ShannonAudioRouteMonitoring: AnyObject {
    func currentOutputs() -> [ShannonAudioOutput]
    func changes() -> AsyncStream<Void>
}

#if os(iOS)
/// The route of the app's audio session. iOS reports it whether or not the session is active.
@MainActor
public final class ShannonSystemAudioRouteMonitor: ShannonAudioRouteMonitoring {
    public init() {}

    public func currentOutputs() -> [ShannonAudioOutput] {
        AVAudioSession.sharedInstance().currentRoute.outputs.map { port in
            ShannonAudioOutput(
                id: ShannonAudioOutput.normalizedPortUID(port.uid),
                name: port.portName,
                kind: Self.kind(of: port.portType)
            )
        }
    }

    static func kind(of port: AVAudioSession.Port) -> ShannonAudioOutput.Kind {
        switch port {
        case .headphones: .wiredHeadphones
        case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE: .bluetooth
        case .usbAudio: .usb
        case .builtInSpeaker: .builtInSpeaker
        default: .other
        }
    }

    public func changes() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let task = Task {
                for await _ in NotificationCenter.default.notifications(named: AVAudioSession.routeChangeNotification) {
                    continuation.yield()
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
#elseif os(macOS)
/// The system's default output device, which is where the app's sound goes.
@MainActor
public final class ShannonSystemAudioRouteMonitor: ShannonAudioRouteMonitoring {
    public init() {}

    public func currentOutputs() -> [ShannonAudioOutput] {
        ShannonCoreAudioOutput.current().map { [$0] } ?? []
    }

    public func changes() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let listener = ShannonCoreAudioRouteListener { continuation.yield() }
            continuation.onTermination = { _ in listener.stop() }
        }
    }
}

enum ShannonCoreAudioOutput {
    static let systemObject = AudioObjectID(kAudioObjectSystemObject)
    /// The headphone jack of an Apple silicon Mac is its own device with this UID.
    static let builtInHeadphonesUID = "BuiltInHeadphoneOutputDevice"
    /// The data source of a built-in device whose jack has headphones in it: 'hdpn'.
    static let headphonesDataSource: UInt32 = 0x6864_706E

    static func address(_ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    static func defaultDevice() -> AudioDeviceID? {
        var device = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var property = address(kAudioHardwarePropertyDefaultOutputDevice)
        let status = AudioObjectGetPropertyData(systemObject, &property, 0, nil, &size, &device)
        return status == noErr && device != kAudioObjectUnknown ? device : nil
    }

    static func current() -> ShannonAudioOutput? {
        guard let device = defaultDevice(), let uid = string(device, kAudioDevicePropertyDeviceUID) else { return nil }
        let transport = number(device, kAudioDevicePropertyTransportType)
        let source = number(device, kAudioDevicePropertyDataSource, scope: kAudioObjectPropertyScopeOutput)
        return ShannonAudioOutput(
            id: ShannonAudioOutput.normalizedDeviceUID(uid),
            name: string(device, kAudioObjectPropertyName) ?? "",
            kind: kind(transport: transport, uid: uid, dataSource: source)
        )
    }

    static func kind(transport: UInt32?, uid: String, dataSource: UInt32?) -> ShannonAudioOutput.Kind {
        switch transport {
        case kAudioDeviceTransportTypeBuiltIn:
            uid == builtInHeadphonesUID || dataSource == headphonesDataSource ? .wiredHeadphones : .builtInSpeaker
        case kAudioDeviceTransportTypeBluetooth, kAudioDeviceTransportTypeBluetoothLE: .bluetooth
        case kAudioDeviceTransportTypeUSB: .usb
        // Aggregate and virtual devices, AirPlay, displays: where the sound ends up cannot be known.
        default: .other
        }
    }

    private static func string(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var property = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(device, &property, 0, nil, &size, $0) }
        guard status == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }

    private static func number(_ device: AudioDeviceID, _ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> UInt32? {
        var property = address(selector, scope: scope)
        var value = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(device, &property, 0, nil, &size, &value) == noErr ? value : nil
    }
}

/// Tells when the default output device changes, and when the jack of the current device gains or
/// loses headphones (an Intel Mac keeps one built-in device and changes its data source).
final class ShannonCoreAudioRouteListener: @unchecked Sendable {
    private let queue = DispatchQueue(label: "shannon.audio-route")
    private let onChange: @Sendable () -> Void
    private var block: AudioObjectPropertyListenerBlock?
    private var watchedDevice: AudioDeviceID?

    init(onChange: @escaping @Sendable () -> Void) {
        self.onChange = onChange
        let block: AudioObjectPropertyListenerBlock = { [weak self] _, _ in self?.changed() }
        queue.async { [self] in
            self.block = block
            var property = ShannonCoreAudioOutput.address(kAudioHardwarePropertyDefaultOutputDevice)
            AudioObjectAddPropertyListenerBlock(ShannonCoreAudioOutput.systemObject, &property, queue, block)
            watchCurrentDevice()
        }
    }

    /// Runs on `queue`, where the system delivers every change.
    private func changed() {
        guard block != nil else { return }
        watchCurrentDevice()
        onChange()
    }

    /// Follows the data source of whichever device is the default now.
    private func watchCurrentDevice() {
        guard let block else { return }
        let device = ShannonCoreAudioOutput.defaultDevice()
        guard device != watchedDevice else { return }
        var property = ShannonCoreAudioOutput.address(kAudioDevicePropertyDataSource, scope: kAudioObjectPropertyScopeOutput)
        if let watchedDevice { AudioObjectRemovePropertyListenerBlock(watchedDevice, &property, queue, block) }
        if let device { AudioObjectAddPropertyListenerBlock(device, &property, queue, block) }
        watchedDevice = device
    }

    func stop() {
        queue.async { [self] in
            guard let block else { return }
            self.block = nil
            var property = ShannonCoreAudioOutput.address(kAudioHardwarePropertyDefaultOutputDevice)
            AudioObjectRemovePropertyListenerBlock(ShannonCoreAudioOutput.systemObject, &property, queue, block)
            if let watchedDevice {
                var source = ShannonCoreAudioOutput.address(kAudioDevicePropertyDataSource, scope: kAudioObjectPropertyScopeOutput)
                AudioObjectRemovePropertyListenerBlock(watchedDevice, &source, queue, block)
            }
            watchedDevice = nil
        }
    }
}
#endif
