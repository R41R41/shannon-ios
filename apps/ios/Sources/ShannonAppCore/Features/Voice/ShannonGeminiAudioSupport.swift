#if os(iOS)
import Foundation

enum ShannonGeminiWAV {
    struct Payload {
        let pcm: Data
        let sampleRate: Int
        let channels: Int
        let bitsPerSample: Int
    }

    static func parse(_ data: Data) throws -> Payload {
        guard data.count >= 44,
              String(data: data[0..<4], encoding: .ascii) == "RIFF",
              String(data: data[8..<12], encoding: .ascii) == "WAVE" else {
            throw URLError(.cannotDecodeRawData)
        }
        var offset = 12
        var format: (sampleRate: Int, channels: Int, bits: Int)?
        var pcm: Data?
        while offset + 8 <= data.count {
            let id = String(data: data[offset..<(offset + 4)], encoding: .ascii) ?? ""
            let size = Int(littleEndianUInt32(data, offset + 4))
            let start = offset + 8
            guard size >= 0, start + size <= data.count else { break }
            if id == "fmt ", size >= 16 {
                format = (
                    Int(littleEndianUInt32(data, start + 4)),
                    Int(littleEndianUInt16(data, start + 2)),
                    Int(littleEndianUInt16(data, start + 14))
                )
            } else if id == "data" {
                pcm = Data(data[start..<(start + size)])
            }
            offset = start + size + (size % 2)
        }
        guard let format, let pcm, !pcm.isEmpty else { throw URLError(.cannotDecodeRawData) }
        return Payload(
            pcm: pcm,
            sampleRate: format.sampleRate,
            channels: format.channels,
            bitsPerSample: format.bits
        )
    }

    private static func littleEndianUInt16(_ data: Data, _ offset: Int) -> UInt16 {
        UInt16(data[offset]) | UInt16(data[offset + 1]) << 8
    }

    private static func littleEndianUInt32(_ data: Data, _ offset: Int) -> UInt32 {
        UInt32(data[offset])
            | UInt32(data[offset + 1]) << 8
            | UInt32(data[offset + 2]) << 16
            | UInt32(data[offset + 3]) << 24
    }
}

final class ShannonGeminiLiveOutputRenderProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var didRecordStart = false

    func markStarted() {
        lock.lock()
        let shouldRecord = !didRecordStart
        didRecordStart = true
        lock.unlock()
        guard shouldRecord else { return }
        Task.detached(priority: .utility) {
            ShannonVoiceDiagnostics.shared.record("gemini.audio.output.render.started")
        }
    }
}

final class ShannonGeminiLiveVADState: @unchecked Sendable {
    struct Transition: Sendable {
        var speechStarted = false
        var speechEnded = false
    }

    private let lock = NSLock()
    private var consecutiveVoiceFrames = 0
    private var speaking = false
    private var lastVoiceAt: TimeInterval = 0
    private var endedForCurrentSpeech = false

    func consume(rms: Float, now: TimeInterval) -> Transition {
        lock.lock()
        defer { lock.unlock() }
        var transition = Transition()
        if rms >= 0.018 {
            consecutiveVoiceFrames += 1
            lastVoiceAt = now
            if !speaking, consecutiveVoiceFrames >= 3 {
                speaking = true
                endedForCurrentSpeech = false
                transition.speechStarted = true
            }
        } else {
            consecutiveVoiceFrames = 0
            if speaking, !endedForCurrentSpeech, now - lastVoiceAt >= 0.60 {
                endedForCurrentSpeech = true
                speaking = false
                transition.speechEnded = true
            }
        }
        return transition
    }
}
#endif
