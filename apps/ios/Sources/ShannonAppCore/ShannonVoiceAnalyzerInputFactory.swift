#if canImport(AVFoundation) && canImport(Speech)
@preconcurrency import AVFoundation
@preconcurrency import Speech

/// Creates the value that crosses Shannon's asynchronous speech boundary.
/// The converter always writes into a newly allocated PCM buffer, including
/// when the source and destination formats match. AnalyzerInput then retains
/// that independent buffer instead of an AVAudioEngine-owned tap buffer.
@available(iOS 26.0, macOS 26.0, *)
final class ShannonVoiceAnalyzerInputFactory: @unchecked Sendable {
    private let converter: ShannonVoiceBufferConverter

    init(outputFormat: AVAudioFormat) {
        converter = ShannonVoiceBufferConverter(outputFormat: outputFormat)
    }

    func make(from buffer: AVAudioPCMBuffer) throws -> AnalyzerInput {
        AnalyzerInput(buffer: try converter.convert(buffer))
    }
}

@available(iOS 26.0, macOS 26.0, *)
private final class ShannonVoiceBufferConverter: @unchecked Sendable {
    private let outputFormat: AVAudioFormat
    private var converter: AVAudioConverter?

    init(outputFormat: AVAudioFormat) {
        self.outputFormat = outputFormat
    }

    func convert(_ buffer: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        let inputFormat = buffer.format
        if converter == nil || converter?.inputFormat != inputFormat || converter?.outputFormat != outputFormat {
            converter = AVAudioConverter(from: inputFormat, to: outputFormat)
            converter?.primeMethod = .none
        }
        guard let converter else { throw ConversionError.converterUnavailable }
        let ratio = converter.outputFormat.sampleRate / converter.inputFormat.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up))
        guard let converted = AVAudioPCMBuffer(
            pcmFormat: converter.outputFormat,
            frameCapacity: max(capacity, 1)
        ) else {
            throw ConversionError.bufferUnavailable
        }
        var conversionError: NSError?
        let inputState = ShannonVoiceConversionInputState()
        let status = converter.convert(to: converted, error: &conversionError) { _, inputStatus in
            defer { inputState.wasUsed = true }
            inputStatus.pointee = inputState.wasUsed ? .noDataNow : .haveData
            return inputState.wasUsed ? nil : buffer
        }
        guard status != .error else {
            throw conversionError ?? ConversionError.conversionFailed
        }
        return converted
    }

    private enum ConversionError: Error {
        case converterUnavailable
        case bufferUnavailable
        case conversionFailed
    }
}

@available(iOS 26.0, macOS 26.0, *)
private final class ShannonVoiceConversionInputState: @unchecked Sendable {
    var wasUsed = false
}
#endif
