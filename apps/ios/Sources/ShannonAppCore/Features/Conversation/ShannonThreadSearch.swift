import Foundation

enum ShannonThreadSearch {
    static func matches(_ threads: [ChatThreadDTO], query: String) -> [ChatThreadDTO] {
        let foldedQuery = normalized(query)
        guard !foldedQuery.isEmpty else { return threads }
        return threads.filter { thread in
            searchableValues(for: thread).contains { normalized($0).contains(foldedQuery) }
        }
    }

    static func matchContext(for thread: ChatThreadDTO, query: String) -> String? {
        let foldedQuery = normalized(query)
        guard !foldedQuery.isEmpty else { return nil }
        return [thread.summary].compactMap { $0 }.first { normalized($0).contains(foldedQuery) }
            ?? (thread.sections ?? []).first { normalized($0).contains(foldedQuery) }
    }

    private static func searchableValues(for thread: ChatThreadDTO) -> [String] {
        [thread.title] + [thread.summary].compactMap { $0 } + (thread.sections ?? [])
    }

    private static func normalized(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(
                options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
                locale: .current
            )
    }
}
