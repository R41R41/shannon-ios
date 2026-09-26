import Foundation

public struct ShannonVoiceLabRVCConfiguration: Equatable, Sendable {
    public var endpoint: String
    public var modelID: String
    public var f0Method: String
    public var pitchShiftSemitones: Float
    public var indexRate: Float
    public var chunkPolicy: ShannonVoiceLabChunkPolicy

    public init(
        endpoint: String = "http://127.0.0.1:8765/v1/convert",
        modelID: String = "shannon-consented-v1",
        f0Method: String = "rmvpe",
        pitchShiftSemitones: Float = 0,
        indexRate: Float = 0.5,
        chunkPolicy: ShannonVoiceLabChunkPolicy = .init()
    ) {
        self.endpoint = endpoint
        self.modelID = modelID
        self.f0Method = f0Method
        self.pitchShiftSemitones = pitchShiftSemitones
        self.indexRate = indexRate
        self.chunkPolicy = chunkPolicy
    }
}

struct ShannonVoiceLabRVCClient: Sendable {
    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func convert(
        wavData: Data,
        configuration: ShannonVoiceLabRVCConfiguration
    ) async throws -> Data {
        guard let url = URL(string: configuration.endpoint),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            throw ShannonVoiceLabError.invalidEndpoint
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        request.setValue("audio/wav", forHTTPHeaderField: "Accept")
        request.setValue(configuration.modelID, forHTTPHeaderField: "X-Shannon-RVC-Model")
        request.setValue(configuration.f0Method, forHTTPHeaderField: "X-Shannon-RVC-F0")
        request.setValue(
            String(configuration.pitchShiftSemitones),
            forHTTPHeaderField: "X-Shannon-RVC-Pitch"
        )
        request.setValue(
            String(configuration.indexRate),
            forHTTPHeaderField: "X-Shannon-RVC-Index-Rate"
        )
        request.setValue(
            String(configuration.chunkPolicy.chunkMilliseconds),
            forHTTPHeaderField: "X-Shannon-RVC-Chunk-Ms"
        )
        request.setValue(
            String(configuration.chunkPolicy.lookAheadMilliseconds),
            forHTTPHeaderField: "X-Shannon-RVC-Lookahead-Ms"
        )

        let (data, response) = try await session.upload(for: request, from: wavData)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              !data.isEmpty else {
            throw ShannonVoiceLabError.invalidRVCResponse
        }
        return data
    }
}
