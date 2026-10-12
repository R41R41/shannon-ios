import Foundation
@preconcurrency import MusicKit

/// What is playing because Shannon chose it, for the conversation's now-playing card.
public struct ShannonNowPlaying: Equatable, Sendable {
    public let actionID: String
    public let itemID: String
    public let title: String
    public let artist: String?
    /// Her one line of why she chose it (`reason` of `music.play`).
    public let reason: String
    public var isPaused: Bool

    public init(actionID: String, itemID: String, title: String, artist: String?, reason: String, isPaused: Bool = false) {
        self.actionID = actionID
        self.itemID = itemID
        self.title = title
        self.artist = artist
        self.reason = reason
        self.isPaused = isPaused
    }
}

/// The player as the now-playing card sees it.
struct ShannonMusicPlayerStatus: Equatable, Sendable {
    let isPlaying: Bool
    let isStopped: Bool
}

/// A song, an album or a playlist found for `music.play`.
private enum ShannonPlayable {
    case song(Song)
    case album(Album)
    case playlist(Playlist)

    var id: String {
        switch self {
        case .song(let song): song.id.rawValue
        case .album(let album): album.id.rawValue
        case .playlist(let playlist): playlist.id.rawValue
        }
    }

    var title: String {
        switch self {
        case .song(let song): song.title
        case .album(let album): album.title
        case .playlist(let playlist): playlist.name
        }
    }

    var artist: String? {
        switch self {
        case .song(let song): song.artistName
        case .album(let album): album.artistName
        case .playlist(let playlist): playlist.curatorName
        }
    }

    @MainActor
    func replaceQueue(of player: ApplicationMusicPlayer) {
        switch self {
        case .song(let song): player.queue = ApplicationMusicPlayer.Queue(for: [song])
        case .album(let album): player.queue = ApplicationMusicPlayer.Queue(for: [album])
        case .playlist(let playlist): player.queue = ApplicationMusicPlayer.Queue(for: [playlist])
        }
    }

    @MainActor
    func insert(into player: ApplicationMusicPlayer, position: MusicPlayer.Queue.EntryInsertionPosition) async throws {
        switch self {
        case .song(let song): try await player.queue.insert(song, position: position)
        case .album(let album): try await player.queue.insert(album, position: position)
        case .playlist(let playlist): try await player.queue.insert(playlist, position: position)
        }
    }
}

/// Apple Music through MusicKit (`music.*` device actions). The app asks for Apple Music access the first time Shannon
/// needs it. Songs play in the app's own player (`ApplicationMusicPlayer`), never the system's, so the owner's Music app
/// queue is left as it was. Making a playlist exists on iPhone only (MusicKit has no library writes on macOS).
@MainActor
final class ShannonDeviceMusic {
    private var player: ApplicationMusicPlayer { ApplicationMusicPlayer.shared }

    func search(_ action: ShannonDeviceActionDTO) async -> ShannonDeviceActionReportDTO {
        guard let query = action.string("query") else { return .failed(.invalid) }
        guard await authorized() else { return .denied() }
        let type = action.string("type") ?? "song"
        do {
            if action.string("scope") == "library" {
                var request = MusicLibrarySearchRequest(term: query, types: Self.libraryTypes(type))
                request.limit = 10
                let response = try await request.response()
                return .done(["items": .array(Self.entries(songs: response.songs, albums: response.albums, playlists: response.playlists, source: "library"))])
            }
            var request = MusicCatalogSearchRequest(term: query, types: Self.catalogTypes(type))
            request.limit = 10
            let response = try await request.response()
            return .done(["items": .array(Self.entries(songs: response.songs, albums: response.albums, playlists: response.playlists, source: "catalog"))])
        } catch {
            return .failed(.unavailable)
        }
    }

    /// Recently played songs, heavy rotation, library playlists and personal recommendations, each where it can be read.
    func recent() async -> ShannonDeviceActionReportDTO {
        guard await authorized() else { return .denied() }
        var result: [String: ShannonJSONValue] = [:]
        if let songs = try? await MusicRecentlyPlayedRequest<Song>().response().items {
            result["recent"] = .array(songs.prefix(10).map { Self.entry(id: $0.id.rawValue, type: "song", title: $0.title, artist: $0.artistName, source: "catalog") })
        }
        if let heavy = try? await heavyRotation(), !heavy.isEmpty {
            result["heavyRotation"] = .array(heavy)
        }
        var playlists = MusicLibraryRequest<Playlist>()
        playlists.limit = 10
        if let items = try? await playlists.response().items {
            result["playlists"] = .array(items.map { Self.entry(id: $0.id.rawValue, type: "playlist", title: $0.name, artist: $0.curatorName, source: "library") })
        }
        if let recommendations = try? await MusicPersonalRecommendationsRequest().response().recommendations {
            let items = recommendations.prefix(3).flatMap { recommendation in
                recommendation.playlists.prefix(3).map { Self.entry(id: $0.id.rawValue, type: "playlist", title: $0.name, artist: $0.curatorName, source: "catalog") }
                    + recommendation.albums.prefix(3).map { Self.entry(id: $0.id.rawValue, type: "album", title: $0.title, artist: $0.artistName, source: "catalog") }
            }
            result["recommendations"] = .array(Array(items.prefix(10)))
        }
        return result.isEmpty ? .failed(.unavailable) : .done(result)
    }

    /// Plays now, or after the current song (`next`), or at the end (`later`); with nothing playing, any mode plays now.
    func play(_ action: ShannonDeviceActionDTO) async -> (report: ShannonDeviceActionReportDTO, nowPlaying: ShannonNowPlaying?) {
        guard await authorized() else { return (.denied(), nil) }
        let type = action.string("itemType") ?? "song"
        let source = action.string("source") ?? "catalog"
        let mode = action.string("mode") ?? "now"
        do {
            guard let item = try await playable(id: action.string("itemId"), query: action.string("query"), type: type, source: source) else {
                return (.failed(.notFound), nil)
            }
            let playing = player.state.playbackStatus == .playing
            if mode != "now" && playing {
                try await item.insert(into: player, position: mode == "next" ? .afterCurrentEntry : .tail)
            } else {
                item.replaceQueue(of: player)
                try await player.play()
            }
            var result: [String: ShannonJSONValue] = ["title": .string(item.title), "itemId": .string(item.id)]
            if let artist = item.artist { result["artist"] = .string(artist) }
            let now = ShannonNowPlaying(actionID: action.id, itemID: item.id, title: item.title, artist: item.artist, reason: action.string("reason") ?? "")
            return (.done(result), mode == "now" || !playing ? now : nil)
        } catch {
            return (.failed(.unavailable), nil)
        }
    }

    func control(_ verb: String?) async -> ShannonDeviceActionReportDTO {
        do {
            switch verb {
            case "pause": player.pause()
            case "resume": try await player.play()
            case "skip": try await player.skipToNextEntry()
            case "previous": try await player.skipToPreviousEntry()
            case "stop": player.stop()
            default: return .failed(.invalid)
            }
            return .done(["action": .string(verb ?? "")])
        } catch {
            return .failed(.unavailable)
        }
    }

    func createPlaylist(_ action: ShannonDeviceActionDTO) async -> ShannonDeviceActionReportDTO {
#if os(iOS)
        guard let name = action.string("name"),
              let ids = action.payload["trackIds"]?.arrayValue?.compactMap(\.stringValue), !ids.isEmpty else { return .failed(.invalid) }
        guard await authorized() else { return .denied() }
        do {
            let request = MusicCatalogResourceRequest<Song>(matching: \.id, memberOf: ids.map { MusicItemID($0) })
            let songs = try await request.response().items
            guard !songs.isEmpty else { return .failed(.notFound) }
            let playlist = try await MusicLibrary.shared.createPlaylist(name: name, description: nil, authorDisplayName: nil, items: songs)
            return .done(["id": .string(playlist.id.rawValue), "count": .number(Double(songs.count))])
        } catch {
            return .failed(.failed)
        }
#else
        return .failed(.unsupported)
#endif
    }

    func status() -> ShannonMusicPlayerStatus {
        let playback = player.state.playbackStatus
        return ShannonMusicPlayerStatus(isPlaying: playback == .playing, isStopped: playback == .stopped)
    }

    private func authorized() async -> Bool {
        switch MusicAuthorization.currentStatus {
        case .authorized: return true
        case .notDetermined: return await MusicAuthorization.request() == .authorized
        default: return false
        }
    }

    private func playable(id: String?, query: String?, type: String, source: String) async throws -> ShannonPlayable? {
        if let id {
            return source == "library" ? try await libraryItem(MusicItemID(id), type: type) : try await catalogItem(MusicItemID(id), type: type)
        }
        guard let query else { return nil }
        var request = MusicCatalogSearchRequest(term: query, types: Self.catalogTypes(type))
        request.limit = 1
        let response = try await request.response()
        switch type {
        case "album": return response.albums.first.map(ShannonPlayable.album)
        case "playlist": return response.playlists.first.map(ShannonPlayable.playlist)
        default: return response.songs.first.map(ShannonPlayable.song)
        }
    }

    private func catalogItem(_ id: MusicItemID, type: String) async throws -> ShannonPlayable? {
        switch type {
        case "album": return try await MusicCatalogResourceRequest<Album>(matching: \.id, equalTo: id).response().items.first.map(ShannonPlayable.album)
        case "playlist": return try await MusicCatalogResourceRequest<Playlist>(matching: \.id, equalTo: id).response().items.first.map(ShannonPlayable.playlist)
        default: return try await MusicCatalogResourceRequest<Song>(matching: \.id, equalTo: id).response().items.first.map(ShannonPlayable.song)
        }
    }

    private func libraryItem(_ id: MusicItemID, type: String) async throws -> ShannonPlayable? {
        switch type {
        case "album":
            var request = MusicLibraryRequest<Album>()
            request.filter(matching: \.id, equalTo: id)
            return try await request.response().items.first.map(ShannonPlayable.album)
        case "playlist":
            var request = MusicLibraryRequest<Playlist>()
            request.filter(matching: \.id, equalTo: id)
            return try await request.response().items.first.map(ShannonPlayable.playlist)
        default:
            var request = MusicLibraryRequest<Song>()
            request.filter(matching: \.id, equalTo: id)
            return try await request.response().items.first.map(ShannonPlayable.song)
        }
    }

    /// The owner's heavy rotation through the Apple Music API (MusicKit adds the tokens).
    private func heavyRotation() async throws -> [ShannonJSONValue] {
        guard let url = URL(string: "https://api.music.apple.com/v1/me/history/heavy-rotation?limit=10") else { return [] }
        let response = try await MusicDataRequest(urlRequest: URLRequest(url: url)).response()
        guard let root = try JSONSerialization.jsonObject(with: response.data) as? [String: Any],
              let data = root["data"] as? [[String: Any]] else { return [] }
        return data.compactMap { item in
            guard let id = item["id"] as? String, let attributes = item["attributes"] as? [String: Any],
                  let name = attributes["name"] as? String else { return nil }
            let kind = item["type"] as? String ?? ""
            let artist = attributes["artistName"] as? String ?? attributes["curatorName"] as? String
            return Self.entry(id: id, type: kind.hasSuffix("playlists") ? "playlist" : "album", title: name, artist: artist,
                              source: kind.hasPrefix("library-") ? "library" : "catalog")
        }
    }

    private static func catalogTypes(_ type: String) -> [any MusicCatalogSearchable.Type] {
        switch type {
        case "album": [Album.self]
        case "playlist": [Playlist.self]
        default: [Song.self]
        }
    }

    private static func libraryTypes(_ type: String) -> [any MusicLibrarySearchable.Type] {
        switch type {
        case "album": [Album.self]
        case "playlist": [Playlist.self]
        default: [Song.self]
        }
    }

    private static func entries(songs: MusicItemCollection<Song>, albums: MusicItemCollection<Album>, playlists: MusicItemCollection<Playlist>,
                                source: String) -> [ShannonJSONValue] {
        songs.prefix(10).map { entry(id: $0.id.rawValue, type: "song", title: $0.title, artist: $0.artistName, source: source) }
            + albums.prefix(10).map { entry(id: $0.id.rawValue, type: "album", title: $0.title, artist: $0.artistName, source: source) }
            + playlists.prefix(10).map { entry(id: $0.id.rawValue, type: "playlist", title: $0.name, artist: $0.curatorName, source: source) }
    }

    private static func entry(id: String, type: String, title: String, artist: String?, source: String) -> ShannonJSONValue {
        var fields: [String: ShannonJSONValue] = ["id": .string(id), "type": .string(type), "title": .string(title), "source": .string(source)]
        if let artist, !artist.isEmpty { fields["artist"] = .string(artist) }
        return .object(fields)
    }
}
