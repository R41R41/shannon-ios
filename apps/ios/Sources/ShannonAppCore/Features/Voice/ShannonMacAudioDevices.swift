#if os(macOS)
import AudioToolbox
import CoreAudio
import Foundation

/// The Mac's microphones as Core Audio knows them. Read only on demand; nothing here keeps a device open.
enum ShannonMacAudioDevices {
    /// Every input device a person would pick: visible, with at least one input stream. The hidden aggregate
    /// that voice processing builds for a call is left out.
    static func inputs() -> [ShannonVoiceInputDevice] {
        deviceIDs().compactMap { id in
            guard hasInput(id), !isHidden(id), let uid = string(id, kAudioDevicePropertyDeviceUID),
                  !uid.hasPrefix("VPAUAggregateAudioDevice") else { return nil }
            let name = string(id, kAudioObjectPropertyName) ?? uid
            return ShannonVoiceInputDevice(id: uid, name: name, isBuiltIn: transport(id) == kAudioDeviceTransportTypeBuiltIn)
        }
    }

    /// The system's input device now (System Settings › Sound › Input).
    static func defaultInputName() -> String? {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr,
              id != 0 else { return nil }
        return string(id, kAudioObjectPropertyName)
    }

    static func deviceID(forUID uid: String) -> AudioDeviceID? {
        deviceIDs().first { string($0, kAudioDevicePropertyDeviceUID) == uid }
    }

    static func name(of id: AudioDeviceID) -> String? { string(id, kAudioObjectPropertyName) }

    /// Points an I/O unit at one device. Returns false when the unit refuses it.
    static func setCurrentDevice(_ id: AudioDeviceID, on unit: AudioUnit) -> Bool {
        var device = id
        return AudioUnitSetProperty(
            unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0,
            &device, UInt32(MemoryLayout<AudioDeviceID>.size)) == noErr
    }

    /// The device an I/O unit is using now, if it says.
    static func currentDevice(of unit: AudioUnit) -> AudioDeviceID? {
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        guard AudioUnitGetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &device, &size) == noErr,
              device != 0 else { return nil }
        return device
    }

    /// Calls `changed` on the main queue whenever a microphone is connected or removed, or the system's input
    /// changes. Returns what stops listening.
    static func observeChanges(_ changed: @escaping @MainActor () -> Void) -> () -> Void {
        let selectors = [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice]
        let block: AudioObjectPropertyListenerBlock = { _, _ in
            MainActor.assumeIsolated { changed() }
        }
        var added: [AudioObjectPropertyAddress] = []
        for selector in selectors {
            var address = AudioObjectPropertyAddress(
                mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            if AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, block) == noErr {
                added.append(address)
            }
        }
        return {
            for var address in added {
                AudioObjectRemovePropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &address, .main, block)
            }
        }
    }

    private static func deviceIDs() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        let system = AudioObjectID(kAudioObjectSystemObject)
        guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &ids) == noErr else { return [] }
        return ids
    }

    private static func hasInput(_ id: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr && size > 0
    }

    private static func isHidden(_ id: AudioDeviceID) -> Bool {
        uint32(id, kAudioDevicePropertyIsHidden) == 1
    }

    private static func transport(_ id: AudioDeviceID) -> UInt32? {
        uint32(id, kAudioDevicePropertyTransportType)
    }

    private static func uint32(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else { return nil }
        return value
    }

    private static func string(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr,
              let string = value?.takeRetainedValue() else { return nil }
        return string as String
    }
}
#endif
