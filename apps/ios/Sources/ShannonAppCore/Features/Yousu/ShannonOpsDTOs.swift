import Foundation

/// The operations console as the owner's app reads it (`docs/ops-contract.md`).
/// The server is the authority for every value; decoding is tolerant so a newer
/// server never takes the screen away: an unknown status reads as 不明, a row in
/// another shape is dropped, and a missing `allowed` allows nothing.

public enum ShannonOpsStatus: String, Equatable, Sendable {
    case running, stopped, degraded, unknown

    init(lenient value: String?) {
        self = value.flatMap(ShannonOpsStatus.init(rawValue:)) ?? .unknown
    }
}

public enum ShannonOpsStepStatus: String, Equatable, Sendable {
    case pending, running, done, failed, skipped
}

public enum ShannonOpsCommandType: String, Codable, Equatable, Sendable, CaseIterable {
    case serviceStart = "service.start"
    case serviceStop = "service.stop"
    case scheduleRun = "schedule.run"
    case minecraftStart = "minecraft.start"
    case minecraftStop = "minecraft.stop"
    case minebotStart = "minebot.start"
}

public enum ShannonOpsCommandStatus: String, Equatable, Sendable {
    case pending, claimed, done, failed, refused, expired
    /// A state of a later server: not waited for, and not worded as anything it did not say.
    case unknown

    /// Still waiting for its result; only then does the screen read again every few seconds.
    public var isOpen: Bool { self == .pending || self == .claimed }
}

public struct ShannonOpsServiceDTO: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let label: String
    public let category: String
    public let status: ShannonOpsStatus
    public let detail: String?

    public init(id: String, label: String? = nil, category: String = "", status: ShannonOpsStatus, detail: String? = nil) {
        self.id = id
        self.label = label ?? id
        self.category = category
        self.status = status
        self.detail = detail
    }

    private enum CodingKeys: String, CodingKey { case id, label, category, status, detail }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(String.self, forKey: .id)
        guard !id.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .id, in: container, debugDescription: "empty id")
        }
        self.id = id
        let label = try? container.decodeIfPresent(String.self, forKey: .label)
        self.label = label.flatMap { $0.isEmpty ? nil : $0 } ?? id
        self.category = (try? container.decodeIfPresent(String.self, forKey: .category)) ?? ""
        self.status = ShannonOpsStatus(lenient: try? container.decodeIfPresent(String.self, forKey: .status))
        let detail = try? container.decodeIfPresent(String.self, forKey: .detail)
        self.detail = detail.flatMap { $0.isEmpty ? nil : $0 }
    }
}

public struct ShannonOpsMinebotDTO: Decodable, Equatable, Identifiable, Sendable {
    public struct Step: Decodable, Equatable, Sendable {
        public let title: String
        public let status: ShannonOpsStepStatus

        public init(title: String, status: ShannonOpsStepStatus) {
            self.title = title
            self.status = status
        }

        private enum CodingKeys: String, CodingKey { case title, status }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            title = try container.decode(String.self, forKey: .title)
            let raw = try? container.decodeIfPresent(String.self, forKey: .status)
            status = raw.flatMap(ShannonOpsStepStatus.init(rawValue:)) ?? .pending
        }
    }

    public struct Task: Decodable, Equatable, Sendable {
        public let title: String
        public let steps: [Step]

        public init(title: String, steps: [Step]) {
            self.title = title
            self.steps = steps
        }

        private enum CodingKeys: String, CodingKey { case title, steps }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            title = try container.decode(String.self, forKey: .title)
            steps = (try? container.decode(ShannonLossyList<Step>.self, forKey: .steps))?.items ?? []
        }
    }

    public let id: String
    public let server: String
    public let status: ShannonOpsStatus
    public let task: Task?

    public init(id: String, server: String, status: ShannonOpsStatus, task: Task? = nil) {
        self.id = id
        self.server = server
        self.status = status
        self.task = task
    }

    private enum CodingKeys: String, CodingKey { case id, server, status, task }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        server = (try? container.decodeIfPresent(String.self, forKey: .server)) ?? ""
        status = ShannonOpsStatus(lenient: try? container.decodeIfPresent(String.self, forKey: .status))
        let decoded = try? container.decodeIfPresent(Task.self, forKey: .task)
        task = decoded.flatMap { $0.title.isEmpty ? nil : $0 }
    }
}

public struct ShannonOpsScheduleDTO: Decodable, Equatable, Identifiable, Sendable {
    public let name: String
    public let time: String
    /// Absent when the runtime does not say; then nothing is claimed about today.
    public let postedToday: Bool?

    public var id: String { name }

    public init(name: String, time: String, postedToday: Bool? = nil) {
        self.name = name
        self.time = time
        self.postedToday = postedToday
    }

    private enum CodingKeys: String, CodingKey { case name, time, postedToday }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let name = try container.decode(String.self, forKey: .name)
        guard !name.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: container, debugDescription: "empty name")
        }
        self.name = name
        time = (try? container.decodeIfPresent(String.self, forKey: .time)) ?? ""
        postedToday = try? container.decodeIfPresent(Bool.self, forKey: .postedToday)
    }
}

public struct ShannonOpsKPIDTO: Decodable, Equatable, Sendable {
    public let postsToday: Int
    public let postsPlanned: Int
    public let tokensToday: Int
    public let apiCallsToday: Int

    public init(postsToday: Int, postsPlanned: Int, tokensToday: Int, apiCallsToday: Int) {
        self.postsToday = postsToday
        self.postsPlanned = postsPlanned
        self.tokensToday = tokensToday
        self.apiCallsToday = apiCallsToday
    }
}

public struct ShannonOpsSkillDTO: Decodable, Equatable, Identifiable, Sendable {
    public let name: String
    public let description: String

    public var id: String { name }

    public init(name: String, description: String) {
        self.name = name
        self.description = description
    }

    private enum CodingKeys: String, CodingKey { case name, description }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        description = (try? container.decodeIfPresent(String.self, forKey: .description)) ?? ""
    }
}

public struct ShannonOpsSnapshotDTO: Decodable, Equatable, Sendable {
    public struct Runtime: Decodable, Equatable, Sendable {
        public let release: String
        public let startedAt: String

        public init(release: String, startedAt: String) {
            self.release = release
            self.startedAt = startedAt
        }
    }

    public let reportedAt: String
    public let runtime: Runtime
    public let services: [ShannonOpsServiceDTO]
    public let minebot: [ShannonOpsMinebotDTO]
    public let schedules: [ShannonOpsScheduleDTO]
    /// Only when the runtime counts them; never shown as zeros otherwise.
    public let kpi: ShannonOpsKPIDTO?
    public let skills: [ShannonOpsSkillDTO]

    public init(
        reportedAt: String, runtime: Runtime, services: [ShannonOpsServiceDTO], minebot: [ShannonOpsMinebotDTO] = [],
        schedules: [ShannonOpsScheduleDTO] = [], kpi: ShannonOpsKPIDTO? = nil, skills: [ShannonOpsSkillDTO] = []
    ) {
        self.reportedAt = reportedAt
        self.runtime = runtime
        self.services = services
        self.minebot = minebot
        self.schedules = schedules
        self.kpi = kpi
        self.skills = skills
    }

    private enum CodingKeys: String, CodingKey { case reportedAt, runtime, services, minebot, schedules, kpi, skills }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        reportedAt = (try? container.decodeIfPresent(String.self, forKey: .reportedAt)) ?? ""
        runtime = (try? container.decodeIfPresent(Runtime.self, forKey: .runtime)) ?? Runtime(release: "", startedAt: "")
        services = (try? container.decode(ShannonLossyList<ShannonOpsServiceDTO>.self, forKey: .services))?.items ?? []
        minebot = (try? container.decode(ShannonLossyList<ShannonOpsMinebotDTO>.self, forKey: .minebot))?.items ?? []
        // A schedule is addressed by its name: a second one of the same name could not be told apart.
        var names = Set<String>()
        schedules = ((try? container.decode(ShannonLossyList<ShannonOpsScheduleDTO>.self, forKey: .schedules))?.items ?? [])
            .filter { names.insert($0.name).inserted }
        kpi = try? container.decodeIfPresent(ShannonOpsKPIDTO.self, forKey: .kpi)
        skills = (try? container.decode(ShannonLossyList<ShannonOpsSkillDTO>.self, forKey: .skills))?.items ?? []
    }
}

/// Only on a finished Minecraft start that made a new world (「新しいワールドで始める」): where the previous world is kept
/// (a name in the server folder; nil when there was none). A server that predates it sends none, and nothing is claimed then.
public struct ShannonOpsFreshWorldResultDTO: Decodable, Equatable, Sendable {
    public let movedTo: String?

    public init(movedTo: String?) {
        self.movedTo = movedTo
    }
}

public struct ShannonOpsCommandDTO: Decodable, Equatable, Identifiable, Sendable {
    public let id: String
    public let type: ShannonOpsCommandType
    public let target: String
    public let status: ShannonOpsCommandStatus
    public let createdAt: String
    public let expiresAt: String
    public let finishedAt: String?
    /// The closed reason vocabulary of the contract; an unknown word is shown as it is.
    public let code: String?
    /// Set only when this start made a new world; the previous world is kept under `movedTo`, not deleted.
    public let freshWorld: ShannonOpsFreshWorldResultDTO?

    public init(
        id: String, type: ShannonOpsCommandType, target: String, status: ShannonOpsCommandStatus,
        createdAt: String, expiresAt: String = "", finishedAt: String? = nil, code: String? = nil,
        freshWorld: ShannonOpsFreshWorldResultDTO? = nil
    ) {
        self.id = id
        self.type = type
        self.target = target
        self.status = status
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.finishedAt = finishedAt
        self.code = code
        self.freshWorld = freshWorld
    }

    private enum CodingKeys: String, CodingKey { case id, type, target, status, createdAt, expiresAt, finishedAt, code, freshWorld }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        // A type this app does not know is dropped by the lossy list: it cannot be worded.
        type = try container.decode(ShannonOpsCommandType.self, forKey: .type)
        target = try container.decode(String.self, forKey: .target)
        // An unknown state is not waited for (no polling forever) and is shown as 不明.
        let raw = try? container.decodeIfPresent(String.self, forKey: .status)
        status = raw.flatMap(ShannonOpsCommandStatus.init(rawValue:)) ?? .unknown
        createdAt = (try? container.decodeIfPresent(String.self, forKey: .createdAt)) ?? ""
        expiresAt = (try? container.decodeIfPresent(String.self, forKey: .expiresAt)) ?? ""
        finishedAt = try? container.decodeIfPresent(String.self, forKey: .finishedAt)
        let code = try? container.decodeIfPresent(String.self, forKey: .code)
        self.code = code.flatMap { $0.isEmpty ? nil : $0 }
        freshWorld = try? container.decodeIfPresent(ShannonOpsFreshWorldResultDTO.self, forKey: .freshWorld)
    }
}

/// What a command would be accepted for right now. A control exists only for what is in here.
public struct ShannonOpsAllowedDTO: Decodable, Equatable, Sendable {
    public let serviceStart: [String]
    public let serviceStop: [String]
    public let minecraft: Bool
    public let scheduleRun: Bool
    public let minebotStart: Bool

    public static let nothing = ShannonOpsAllowedDTO(
        serviceStart: [], serviceStop: [], minecraft: false, scheduleRun: false, minebotStart: false
    )

    public init(serviceStart: [String], serviceStop: [String], minecraft: Bool, scheduleRun: Bool, minebotStart: Bool) {
        self.serviceStart = serviceStart
        self.serviceStop = serviceStop
        self.minecraft = minecraft
        self.scheduleRun = scheduleRun
        self.minebotStart = minebotStart
    }

    private enum CodingKeys: String, CodingKey { case serviceStart, serviceStop, minecraft, scheduleRun, minebotStart }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        serviceStart = (try? container.decode(ShannonLossyList<String>.self, forKey: .serviceStart))?.items.filter { !$0.isEmpty } ?? []
        serviceStop = (try? container.decode(ShannonLossyList<String>.self, forKey: .serviceStop))?.items.filter { !$0.isEmpty } ?? []
        minecraft = (try? container.decodeIfPresent(Bool.self, forKey: .minecraft)) ?? false
        scheduleRun = (try? container.decodeIfPresent(Bool.self, forKey: .scheduleRun)) ?? false
        minebotStart = (try? container.decodeIfPresent(Bool.self, forKey: .minebotStart)) ?? false
    }
}

/// The owner's switches that are not commands (`settings` of `GET /v1/ops`, docs/ops-contract.md).
/// `freshWorld` is 「新しいワールドで始める」: the server stores it, so this is the server's value, never a local choice.
public struct ShannonOpsSettingsDTO: Decodable, Equatable, Sendable {
    public let freshWorld: Bool

    public init(freshWorld: Bool) {
        self.freshWorld = freshWorld
    }
}

/// The answer of `GET /v1/ops`, already held to the rules of the contract:
/// no snapshot is always stale, and a stale or unsupported answer allows nothing,
/// whatever the fields say.
public struct ShannonOpsViewDTO: Decodable, Equatable, Sendable {
    public let snapshot: ShannonOpsSnapshotDTO?
    public let receivedAt: String?
    public let stale: Bool
    public let staleAfterSeconds: Double
    public let commandsSupported: Bool
    /// The last 20 commands, newest first.
    public let commands: [ShannonOpsCommandDTO]
    public let allowed: ShannonOpsAllowedDTO
    /// Nil from a server that has no such switches (or an answer that cannot be read): then no switch is offered.
    public let settings: ShannonOpsSettingsDTO?

    public init(
        snapshot: ShannonOpsSnapshotDTO?, receivedAt: String?, stale: Bool, staleAfterSeconds: Double = 180,
        commandsSupported: Bool, commands: [ShannonOpsCommandDTO] = [], allowed: ShannonOpsAllowedDTO = .nothing,
        settings: ShannonOpsSettingsDTO? = nil
    ) {
        let isStale = snapshot == nil || stale
        self.snapshot = snapshot
        self.receivedAt = receivedAt
        self.stale = isStale
        self.staleAfterSeconds = staleAfterSeconds
        self.commandsSupported = commandsSupported
        self.commands = commandsSupported ? Array(commands.prefix(20)) : []
        self.allowed = commandsSupported && !isStale ? allowed : .nothing
        self.settings = settings
    }

    /// The same answer with the switches the server just stored.
    func replacing(settings: ShannonOpsSettingsDTO) -> ShannonOpsViewDTO {
        ShannonOpsViewDTO(
            snapshot: snapshot, receivedAt: receivedAt, stale: stale, staleAfterSeconds: staleAfterSeconds,
            commandsSupported: commandsSupported, commands: commands, allowed: allowed, settings: settings
        )
    }

    private enum CodingKeys: String, CodingKey {
        case snapshot, receivedAt, stale, staleAfterSeconds, commandsSupported, commands, allowed, settings
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let seconds = try? container.decodeIfPresent(Double.self, forKey: .staleAfterSeconds)
        self.init(
            snapshot: try? container.decodeIfPresent(ShannonOpsSnapshotDTO.self, forKey: .snapshot),
            receivedAt: try? container.decodeIfPresent(String.self, forKey: .receivedAt),
            // Only an explicit `false` is current.
            stale: (try? container.decodeIfPresent(Bool.self, forKey: .stale)) != false,
            staleAfterSeconds: seconds.flatMap { $0 > 0 ? $0 : nil } ?? 180,
            commandsSupported: (try? container.decodeIfPresent(Bool.self, forKey: .commandsSupported)) == true,
            commands: (try? container.decode(ShannonLossyList<ShannonOpsCommandDTO>.self, forKey: .commands))?.items ?? [],
            allowed: (try? container.decodeIfPresent(ShannonOpsAllowedDTO.self, forKey: .allowed)) ?? .nothing,
            settings: try? container.decodeIfPresent(ShannonOpsSettingsDTO.self, forKey: .settings)
        )
    }
}

struct ShannonOpsCommandRequestDTO: Encodable, Equatable, Sendable {
    let scopeKey: String
    let idempotencyKey: String
    let type: ShannonOpsCommandType
    let target: String
}

struct ShannonOpsCommandResponseDTO: Decodable, Sendable {
    let command: ShannonOpsCommandDTO
}

struct ShannonOpsSettingsRequestDTO: Encodable, Equatable, Sendable {
    let scopeKey: String
    let freshWorld: Bool
}

struct ShannonOpsSettingsResponseDTO: Decodable, Sendable {
    let settings: ShannonOpsSettingsDTO
}

struct ShannonOpsErrorDTO: Decodable, Sendable {
    let error: String?
}

/// Decodes an array and drops the elements that do not decode, instead of failing the whole answer.
struct ShannonLossyList<Element: Decodable>: Decodable {
    let items: [Element]

    private struct Skipped: Decodable {}

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var items: [Element] = []
        while !container.isAtEnd {
            if let item = try? container.decode(Element.self) {
                items.append(item)
            } else {
                _ = try? container.decode(Skipped.self)
            }
        }
        self.items = items
    }
}
