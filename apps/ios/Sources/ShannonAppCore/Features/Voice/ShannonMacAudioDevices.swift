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
            guard hasInput(id), !isHidden(id), !isAggregateOfVoiceProcessing(id),
                  let uid = string(id, kAudioDevicePropertyDeviceUID) else { return nil }
            let name = string(id, kAudioObjectPropertyName) ?? uid
            return ShannonVoiceInputDevice(id: uid, name: name, isBuiltIn: transport(id) == kAudioDeviceTransportTypeBuiltIn)
        }
    }

    /// The microphone a device stands for. Voice processing's own aggregate stands for one of its active input
    /// sub-devices: the one that was set (`applied`, a unique id) if it is among them, else the system's input,
    /// else the first with input streams. Any other device stands for itself, an aggregate the owner made too.
    /// Nil when that cannot be told.
    static func inputBehind(_ id: AudioDeviceID, preferring applied: String? = nil) -> (uid: String, name: String)? {
        guard isAggregateOfVoiceProcessing(id) else { return hasInput(id) ? identity(id) : nil }
        let inputs = objectList(id, kAudioAggregateDevicePropertyActiveSubDeviceList)
            .filter { hasInput($0) && !isAggregateOfVoiceProcessing($0) }
            .compactMap(identity)
        if let applied, let chosen = inputs.first(where: { $0.uid == applied }) { return chosen }
        if let system = defaultInputID().flatMap(identity), let match = inputs.first(where: { $0.uid == system.uid }) {
            return match
        }
        return inputs.first
    }

    static func uid(of id: AudioDeviceID) -> String? { string(id, kAudioDevicePropertyDeviceUID) }

    private static func identity(_ id: AudioDeviceID) -> (uid: String, name: String)? {
        guard let uid = string(id, kAudioDevicePropertyDeviceUID) else { return nil }
        return (uid, string(id, kAudioObjectPropertyName) ?? uid)
    }

    /// Voice processing's own aggregate: its unique id says so, or it is a private aggregate that the system's
    /// list of devices does not show. An aggregate the owner made in Audio MIDI Setup is listed, so it is not one.
    static func isAggregateOfVoiceProcessing(_ id: AudioDeviceID) -> Bool {
        if string(id, kAudioDevicePropertyDeviceUID)?.hasPrefix("VPAUAggregateAudioDevice") == true { return true }
        return transport(id) == kAudioDeviceTransportTypeAggregate && !deviceIDs().contains(id)
    }

    private static func defaultInputID() -> AudioDeviceID? {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id) == noErr,
              id != 0 else { return nil }
        return id
    }

    /// The system's input device now (System Settings › Sound › Input), unless it is a hidden device.
    static func defaultInputName() -> String? {
        guard let id = defaultInputID(), !isHidden(id), !isAggregateOfVoiceProcessing(id) else { return nil }
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
        objectList(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDevices)
    }

    private static func objectList(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
        var address = AudioObjectPropertyAddress(
            mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr, size > 0 else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &ids) == noErr else { return [] }
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
