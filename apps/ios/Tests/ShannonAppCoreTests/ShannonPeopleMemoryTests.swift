import Foundation
import Testing
@testable import ShannonAppCore

@Suite("頭の中 › 人: people, audience labels, and the owner's controls")
@MainActor
struct ShannonPeopleMemoryTests {
    private static let payload = """
    {"people":[
      {"id":"p1","displayName":"ミキ","aliases":["美紀"],"howKnown":"「友人も一緒」の通話で名前を聞いた","createdAt":"2026-10-01T03:00:00.000Z",
       "lastTalkedAt":"2026-10-02T03:00:00.000Z","forgotten":false,"items":[
        {"id":"i1","kind":"summary","kindLabel":"話したことの要約","text":"相手: ミキさん 話したこと: 映画の話。","observedAt":"2026-10-02T03:00:00.000Z",
         "audience":"ミキさんと一緒の時","sensitivity":"ordinary","decidedBy":"rule","reason":"守るべき個人情報の語を含まない","status":"active"},
        {"id":"i2","kind":"fact","kindLabel":"その人のこと","text":"ミキさんは辛いものが苦手","observedAt":"2026-10-02T03:00:00.000Z",
         "audience":"ミキさんと一緒の時","sensitivity":"sensitive","decidedBy":"rule","reason":"ほかの人のこと（ほかの人についての情報）","status":"active"},
        {"id":"i3","kind":"topic","kindLabel":"次に話したいこと","text":"猫の写真","observedAt":"2026-10-01T03:00:00.000Z",
         "audience":"ミキさんと一緒の時","sensitivity":"ordinary","decidedBy":"owner","reason":"ライ氏が選んだ扱い","status":"forgotten"}]},
      {"id":"p2","displayName":"ケン","aliases":[],"howKnown":"","createdAt":"2026-09-20T03:00:00.000Z","forgotten":true,"items":[]},
      {"id":"p3","displayName":"ユウタ","aliases":[],"howKnown":"","createdAt":"2026-10-03T03:00:00.000Z","forgotten":false,"items":[]}],
     "unnamed":[
        {"id":"u1","kind":"summary","kindLabel":"話したことの要約","text":"相手: 同席していた方","observedAt":"2026-09-30T03:00:00.000Z",
         "audience":"名前を聞いていない方と一緒の時","sensitivity":"sensitive","decidedBy":"rule","reason":"相手が分からない場での会話","status":"active"}]}
    """

    private static func people() throws -> ShannonPeopleMemoryDTO {
        try JSONDecoder().decode(ShannonPeopleMemoryDTO.self, from: Data(payload.utf8))
    }

    @Test("People are ordered by the last talk, forgotten last, with what she remembers on each row")
    func presentation() throws {
        let presentation = ShannonPeopleMemoryPresentation(people: try Self.people())
        #expect(presentation.rows.map(\.displayName) == ["ユウタ", "ミキ", "ケン"])
        #expect(presentation.rememberedCount == 2)
        #expect(presentation.summary == "覚えている人 2人：ユウタさん、ミキさん")
        let miki = presentation.rows[1]
        #expect(miki.title == "ミキさん")
        #expect(ShannonPeopleMemoryPresentation.subtitle(for: miki).contains("最後に話した日"))
        #expect(ShannonPeopleMemoryPresentation.subtitle(for: miki).hasSuffix("覚えていること 2件"))
        #expect(ShannonPeopleMemoryPresentation.subtitle(for: presentation.rows[2]) == "忘れるよう指定済み")

        let groups = ShannonPeopleMemoryPresentation.groups(miki.items)
        #expect(groups.map(\.title) == ["その人のこと", "話したことの要約", "次に話したいこと"])
        let fact = groups[0].items[0]
        let caption = ShannonPeopleMemoryPresentation.caption(for: fact)
        #expect(caption.hasPrefix("ミキさんと一緒の時・"))
        #expect(caption.hasSuffix("・機微"))
        #expect(ShannonPeopleMemoryPresentation.caption(for: groups[2].items[0]) == "忘れるよう指定済み・ミキさんと一緒の時")
        #expect(presentation.unnamed.first?.audience == "名前を聞いていない方と一緒の時")

        #expect(ShannonPeopleMemoryPresentation(people: nil).summary == "読み込み中…")
        #expect(ShannonPeopleMemoryPresentation(people: .empty).summary == "まだ誰も覚えていません")
        #expect(ShannonPeopleMemoryPresentation(people: .empty).isEmpty)
    }

    @Test("Each change is one request the server understands")
    func changeRequests() throws {
        func body(_ change: ShannonPeopleMemoryChange) throws -> [String: String] {
            let data = try JSONEncoder().encode(change.request(scopeKey: "owner"))
            return try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
        }
        #expect(try body(.rename(personID: "p1", displayName: "ミキ子")) == ["scopeKey": "owner", "action": "rename", "personId": "p1", "displayName": "ミキ子"])
        #expect(try body(.merge(personID: "p2", intoPersonID: "p1")) == ["scopeKey": "owner", "action": "merge", "personId": "p2", "intoPersonId": "p1"])
        #expect(try body(.forgetPerson("p1"))["action"] == "forget-person")
        #expect(try body(.restorePerson("p1"))["action"] == "restore-person")
        #expect(try body(.forgetItem("i1")) == ["scopeKey": "owner", "action": "forget-item", "itemId": "i1"])
        #expect(try body(.restoreItem("i1"))["action"] == "restore-item")
        #expect(try body(.mark(itemID: "i2", .ordinary))["action"] == "mark-ordinary")
        #expect(try body(.mark(itemID: "i2", .sensitive))["action"] == "mark-sensitive")
        #expect(ShannonPeopleMemoryChange.merge(personID: "p2", intoPersonID: "p1").targetID == "p2")
    }

    @Test("The model loads people apart from the dashboard, applies changes, and reports failures without losing the list")
    func model() async throws {
        let client = PeopleClient(people: try Self.people())
        let model = ShannonMemoryModel(client: client)
        #expect(ShannonMemoryOverview(model: model).peopleValue == .loading)
        await model.reloadPeople()
        #expect(model.people?.people.count == 3)
        #expect(ShannonMemoryOverview(model: model).peopleValue == .count(2))

        #expect(await model.changePeople(.forgetItem("i1")))
        #expect(await client.changes == [.forgetItem("i1")])
        await client.fail()
        #expect(!(await model.changePeople(.forgetPerson("p1"))))
        #expect(model.peopleErrorMessage == "変更できませんでした。保存されていません。")
        #expect(model.people?.people.count == 3)
        await model.reloadPeople()
        #expect(model.peopleErrorMessage == "人の記憶を読み込めませんでした。前回の表示はそのまま残しています。")
        #expect(model.people?.people.count == 3)
        #expect(ShannonMemoryOverview(model: model).peopleValue == .count(2))
    }

    @Test("A server that predates people memory shows an empty list, not an error")
    func olderServer() async {
        let model = ShannonMemoryModel(client: PeopleClient(people: .empty, missingRoute: true))
        await model.reloadPeople()
        #expect(model.people == .empty)
        #expect(model.peopleErrorMessage == nil)
    }

    @Test("A memory shows who was present and whether it is 機微; an older server's item has no label")
    func memoryItemDisclosure() throws {
        let labelled = """
        {"id":"m1","kind":"user-fact","text":"ユーザーには借金がある","status":"active","pinned":false,"createdAt":"2026-10-02T03:00:00.000Z",
         "updatedAt":"2026-10-02T03:00:00.000Z","changeReason":"会話から","evidence":[],
         "disclosure":{"audience":"ライ氏と二人の時","sensitivity":"sensitive","decidedBy":"rule","reason":"お金（「借金」を含む）"}}
        """
        let item = try JSONDecoder().decode(ShannonMemoryItemDTO.self, from: Data(labelled.utf8))
        let disclosure = try #require(item.disclosure)
        #expect(disclosure.audience == "ライ氏と二人の時")
        #expect(disclosure.sensitivity.japaneseName == "機微")
        #expect(ShannonMemoryDisclosureCopy.reason(disclosure) == "シャノンが内容から判断：お金（「借金」を含む）")
        #expect(ShannonMemorySensitivityDTO.ordinary.japaneseName == "ふつう")
        // A rule-decided 機微 is checked at speak time; only a hand-marked one is promised never to be given to her.
        #expect(ShannonMemorySensitivityDTO.sensitive.explanation.contains("話す前に"))
        #expect(!ShannonMemorySensitivityDTO.sensitive.explanation.contains("使いません"))
        #expect(ShannonMemorySensitivityDTO.sensitive.chosenExplanation.contains("シャノンにも渡しません"))
        #expect(ShannonMemorySensitivityDTO.ordinary.chosenExplanation.contains("そのまま使います"))
        #expect(ShannonMemoryDisclosureDTO(audience: "", sensitivity: .sensitive, decidedBy: "default").decidedByLabel == "区別を記録する前の記憶")
        #expect(ShannonMemoryDisclosureDTO(audience: "", sensitivity: .ordinary, decidedBy: "owner").decidedByLabel == "ライ氏が選びました")

        let older = """
        {"id":"m2","kind":"user-fact","text":"ユーザーは紅茶が好き","status":"active","pinned":false,"createdAt":"2026-10-02T03:00:00.000Z",
         "updatedAt":"2026-10-02T03:00:00.000Z","changeReason":"会話から","evidence":[]}
        """
        #expect(try JSONDecoder().decode(ShannonMemoryItemDTO.self, from: Data(older.utf8)).disclosure == nil)
        #expect(ShannonMemoryActionDTO.markSensitive.rawValue == "mark-sensitive")
        #expect(ShannonMemoryActionDTO.markOrdinary.rawValue == "mark-ordinary")
    }

    @Test("The words under 人 say what is kept, when it is used, and that forgetting can be undone")
    func copy() {
        #expect(ShannonPeopleMemoryCopy.rule.contains("別の人がいる場ではシャノンが話す前に確かめます"))
        #expect(ShannonPeopleMemoryCopy.rule.contains("手で機微にしたものは、その時に一緒にいた人の前でだけ使います"))
        #expect(ShannonPeopleMemoryCopy.emptyMessage.contains("声で人を聞き分けることはしません"))
        #expect(ShannonPeopleMemoryCopy.forgetItem.contains("復元すると元に戻ります"))
        #expect(ShannonPeopleMemoryCopy.forgetPerson("ミキさん").contains("初めての人として挨拶します"))
        #expect(ShannonPeopleMemoryCopy.merge("美紀さん", into: "ミキさん").contains("元に戻せません"))
        #expect(ShannonPeopleMemoryCopy.unnamedFooter.contains("ライ氏と二人の時にだけ使います"))
    }
}

private actor PeopleClient: ShannonMemoryServing {
    private let people: ShannonPeopleMemoryDTO
    private let missingRoute: Bool
    private var failing = false
    private(set) var changes: [ShannonPeopleMemoryChange] = []

    init(people: ShannonPeopleMemoryDTO, missingRoute: Bool = false) {
        self.people = people
        self.missingRoute = missingRoute
    }

    func fail() { failing = true }

    func loadMemories(scopeKey: String) async throws -> ShannonMemoryDashboardDTO { throw ShannonAPIError.invalidResponse }

    func mutateMemory(scopeKey: String, memoryID: String, action: ShannonMemoryActionDTO, text: String?) async throws -> ShannonMemoryDashboardDTO {
        throw ShannonAPIError.invalidResponse
    }

    func correctKnowledge(scopeKey: String, answerId: String, answer: String) async throws -> ShannonMemoryDashboardDTO {
        throw ShannonAPIError.invalidResponse
    }

    func loadPeopleMemory(scopeKey: String) async throws -> ShannonPeopleMemoryDTO {
        if missingRoute { throw ShannonAPIError.rejected(status: 404) }
        if failing { throw ShannonAPIError.rejected(status: 500) }
        return people
    }

    func mutatePeopleMemory(scopeKey: String, change: ShannonPeopleMemoryChange) async throws -> ShannonPeopleMemoryDTO {
        if failing { throw ShannonAPIError.rejected(status: 500) }
        changes.append(change)
        return people
    }
}
