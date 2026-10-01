import Foundation

/// 機微 (protected personal information) or ふつう.
public enum ShannonMemorySensitivityDTO: String, Codable, Equatable, Sendable {
    case sensitive, ordinary

    public var japaneseName: String { self == .sensitive ? "機微" : "ふつう" }
    public var symbolName: String { self == .sensitive ? "lock.fill" : "bubble.left.and.bubble.right" }
    /// What the label means when other people are present, as decided by the rules.
    public var explanation: String {
        self == .sensitive
            ? "ほかの人がいる場では、シャノンが話す前に「その人がまだ知らない個人情報にならないか」を自分で確かめます。確実に出さないようにするには、手で「機微にする」を選んでください。"
            : "守るべき個人情報を含まないものとして、ほかの人がいる場でもそのまま使います。"
    }

    /// What it means once the owner chose it by hand.
    public var chosenExplanation: String {
        self == .sensitive
            ? "ライ氏が機微にしたので、ほかの人がいる場ではシャノンにも渡しません。その時に一緒にいた人の前でだけ使います。"
            : "ライ氏がふつうにしたので、ほかの人がいる場でもそのまま使います。"
    }
}

/// Who was present when an item was said, and whether it is 機微 or ふつう.
public struct ShannonMemoryDisclosureDTO: Codable, Equatable, Sendable {
    /// 「ライ氏と二人の時」「ミキさんと一緒の時」「グループの会話」
    public let audience: String
    public let sensitivity: ShannonMemorySensitivityDTO
    /// `rule`, `owner`, or `default` for a memory recorded before labels existed.
    public let decidedBy: String
    public let reason: String

    public init(audience: String, sensitivity: ShannonMemorySensitivityDTO, decidedBy: String = "rule", reason: String = "") {
        self.audience = audience
        self.sensitivity = sensitivity
        self.decidedBy = decidedBy
        self.reason = reason
    }

    public var decidedByLabel: String {
        switch decidedBy {
        case "owner": "ライ氏が選びました"
        case "default": "区別を記録する前の記憶"
        default: "シャノンが内容から判断"
        }
    }
}

public struct ShannonPersonMemoryItemDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let kind: String
    public let kindLabel: String
    public let text: String
    public let observedAt: String
    public let audience: String
    public let sensitivity: ShannonMemorySensitivityDTO
    public let decidedBy: String
    public let reason: String
    /// `active` or `forgotten`.
    public let status: String

    public init(
        id: String, kind: String, kindLabel: String, text: String, observedAt: String, audience: String,
        sensitivity: ShannonMemorySensitivityDTO = .sensitive, decidedBy: String = "rule", reason: String = "", status: String = "active"
    ) {
        self.id = id
        self.kind = kind
        self.kindLabel = kindLabel
        self.text = text
        self.observedAt = observedAt
        self.audience = audience
        self.sensitivity = sensitivity
        self.decidedBy = decidedBy
        self.reason = reason
        self.status = status
    }

    public var isForgotten: Bool { status != "active" }
}

public struct ShannonRememberedPersonDTO: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let displayName: String
    public let aliases: [String]
    public let howKnown: String
    public let createdAt: String
    public let lastTalkedAt: String?
    public let forgotten: Bool
    public let items: [ShannonPersonMemoryItemDTO]

    public init(
        id: String, displayName: String, aliases: [String] = [], howKnown: String = "", createdAt: String,
        lastTalkedAt: String? = nil, forgotten: Bool = false, items: [ShannonPersonMemoryItemDTO] = []
    ) {
        self.id = id
        self.displayName = displayName
        self.aliases = aliases
        self.howKnown = howKnown
        self.createdAt = createdAt
        self.lastTalkedAt = lastTalkedAt
        self.forgotten = forgotten
        self.items = items
    }

    public var title: String { "\(displayName)さん" }
}

/// What the owner sees under 頭の中 › 人.
public struct ShannonPeopleMemoryDTO: Codable, Equatable, Sendable {
    public let people: [ShannonRememberedPersonDTO]
    /// Calls whose guest never gave a name. Used only when the owner is alone.
    public let unnamed: [ShannonPersonMemoryItemDTO]

    public init(people: [ShannonRememberedPersonDTO] = [], unnamed: [ShannonPersonMemoryItemDTO] = []) {
        self.people = people
        self.unnamed = unnamed
    }

    public static let empty = ShannonPeopleMemoryDTO()
    public var isEmpty: Bool { people.isEmpty && unnamed.isEmpty }
}

/// One change the owner makes under 人.
public enum ShannonPeopleMemoryChange: Equatable, Sendable {
    case rename(personID: String, displayName: String)
    /// `personID` disappears into `intoPersonID`, which keeps both names.
    case merge(personID: String, intoPersonID: String)
    case forgetPerson(String)
    case restorePerson(String)
    case forgetItem(String)
    case restoreItem(String)
    case mark(itemID: String, ShannonMemorySensitivityDTO)

    /// The item or person a spinner belongs to while the change is in flight.
    public var targetID: String {
        switch self {
        case let .rename(id, _), let .merge(id, _), let .forgetPerson(id), let .restorePerson(id),
             let .forgetItem(id), let .restoreItem(id), let .mark(id, _): id
        }
    }

    func request(scopeKey: String) -> ShannonPeopleMemoryActionRequestDTO {
        switch self {
        case let .rename(personID, displayName):
            .init(scopeKey: scopeKey, action: "rename", personId: personID, displayName: displayName)
        case let .merge(personID, intoPersonID):
            .init(scopeKey: scopeKey, action: "merge", personId: personID, intoPersonId: intoPersonID)
        case let .forgetPerson(personID): .init(scopeKey: scopeKey, action: "forget-person", personId: personID)
        case let .restorePerson(personID): .init(scopeKey: scopeKey, action: "restore-person", personId: personID)
        case let .forgetItem(itemID): .init(scopeKey: scopeKey, action: "forget-item", itemId: itemID)
        case let .restoreItem(itemID): .init(scopeKey: scopeKey, action: "restore-item", itemId: itemID)
        case let .mark(itemID, sensitivity):
            .init(scopeKey: scopeKey, action: sensitivity == .sensitive ? "mark-sensitive" : "mark-ordinary", itemId: itemID)
        }
    }
}

struct ShannonPeopleMemoryActionRequestDTO: Encodable, Equatable {
    let scopeKey: String
    let action: String
    var personId: String? = nil
    var itemId: String? = nil
    var displayName: String? = nil
    var intoPersonId: String? = nil
}

/// Words shown under 人 and in the call, kept in one place so both say the same thing.
public enum ShannonPeopleMemoryCopy {
    public static let title = "人"
    public static let rule = "「友人も一緒」で聞いたお名前と、その人と話したことです。機微な内容は、別の人がいる場ではシャノンが話す前に確かめます。手で機微にしたものは、その時に一緒にいた人の前でだけ使います。ライ氏と二人の時は全部使います。"
    public static let emptyTitle = "まだ誰も覚えていません"
    public static let emptyMessage = "通話を「友人も一緒」にして、お友達が名前を言うと、ここに残ります。声で人を聞き分けることはしません。"
    public static let unnamedTitle = "名前を聞いていない方"
    public static let unnamedFooter = "名前が分からない通話は、ライ氏と二人の時にだけ使います。"
    public static let forgetItem = "この内容を、今後の会話の材料から外します。この内容に触れたシャノンの返答も外れます。復元すると元に戻ります。"
    public static func forgetPerson(_ name: String) -> String {
        "\(name)について覚えていることを、すべて今後の会話の材料から外します。次に会っても初めての人として挨拶します。復元すると元に戻ります。"
    }
    public static func merge(_ name: String, into other: String) -> String {
        "\(name)の記憶を\(other)にまとめ、\(name)の記録はなくなります。この操作は元に戻せません。"
    }
}
