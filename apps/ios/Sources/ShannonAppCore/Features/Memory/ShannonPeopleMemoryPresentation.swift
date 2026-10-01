import Foundation

/// Pure projection behind 頭の中 › 人: ordering, counts and the words on each row.
struct ShannonPeopleMemoryPresentation: Equatable {
    struct Group: Equatable, Identifiable {
        let id: String
        let title: String
        let items: [ShannonPersonMemoryItemDTO]
    }

    let people: ShannonPeopleMemoryDTO?

    /// People who are remembered first, most recently talked with first; forgotten people last.
    var rows: [ShannonRememberedPersonDTO] {
        (people?.people ?? []).sorted { left, right in
            if left.forgotten != right.forgotten { return !left.forgotten }
            return (left.lastTalkedAt ?? left.createdAt) > (right.lastTalkedAt ?? right.createdAt)
        }
    }

    var unnamed: [ShannonPersonMemoryItemDTO] { people?.unnamed ?? [] }
    var isEmpty: Bool { people?.isEmpty ?? true }
    var rememberedCount: Int { rows.filter { !$0.forgotten }.count }

    /// One line for the Mac entry card.
    var summary: String {
        guard let people else { return "読み込み中…" }
        if people.isEmpty { return "まだ誰も覚えていません" }
        let names = rows.filter { !$0.forgotten }.prefix(3).map(\.title).joined(separator: "、")
        return names.isEmpty ? "覚えている人 0人" : "覚えている人 \(rememberedCount)人：\(names)"
    }

    static func subtitle(for person: ShannonRememberedPersonDTO) -> String {
        if person.forgotten { return "忘れるよう指定済み" }
        let count = person.items.filter { !$0.isForgotten }.count
        let last = person.lastTalkedAt.map { "最後に話した日 \(displayDay($0))" } ?? "まだ話した記録はありません"
        return "\(last)・覚えていること \(count)件"
    }

    /// 「音声・Discord」, or nothing for a server that does not say.
    static func sources(for person: ShannonRememberedPersonDTO) -> String? {
        guard let sources = person.sources, !sources.isEmpty else { return nil }
        return sources.joined(separator: "・")
    }

    /// Whether the person is known from anywhere other than a voice call.
    static func knownFromPlatform(_ person: ShannonRememberedPersonDTO) -> Bool {
        (person.sources ?? []).contains { $0 != "音声" }
    }

    /// 「同じ名前のミキさん（Discord）と統合…」
    static func mergeSuggestionTitle(_ suggestion: ShannonPersonMergeSuggestionDTO) -> String {
        let place = suggestion.sources.isEmpty ? "" : "（\(suggestion.sources.joined(separator: "・"))）"
        return "同じ名前の\(suggestion.displayName)さん\(place)と統合…"
    }

    /// 「ミキさんと一緒の時・2026/10/2・機微」: who was there, when, and how the item is handled.
    static func caption(for item: ShannonPersonMemoryItemDTO) -> String {
        if item.isForgotten { return "忘れるよう指定済み・\(item.audience)" }
        return "\(item.audience)・\(displayDay(item.observedAt))・\(item.sensitivity.japaneseName)"
    }

    /// Her facts about the person first, then what they talked about, promises, and next topics.
    static func groups(_ items: [ShannonPersonMemoryItemDTO]) -> [Group] {
        let order = ["fact", "summary", "promise", "topic"]
        return order.compactMap { kind in
            let matching = items.filter { $0.kind == kind }.sorted { $0.observedAt > $1.observedAt }
            guard let first = matching.first else { return nil }
            return Group(id: kind, title: first.kindLabel, items: matching)
        }
    }

    private static func displayDay(_ value: String) -> String {
        let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let date = (try? fractional.parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value))
        return date?.formatted(date: .numeric, time: .omitted) ?? String(value.prefix(10))
    }
}
