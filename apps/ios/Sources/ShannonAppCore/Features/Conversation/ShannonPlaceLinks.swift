import Foundation

enum ShannonPlaceLinks {
    static func appending(_ places: [ShannonPlaceDTO], to reply: String) -> String {
        guard !places.isEmpty else { return reply }
        let links = places.map { place in
            let name = place.name.replacingOccurrences(of: "[", with: " ")
                .replacingOccurrences(of: "]", with: " ")
                .replacingOccurrences(of: "\n", with: " ")
            return "- [\(name)](\(place.mapUrl)) — \(place.address)"
        }.joined(separator: "\n")
        return "\(reply)\n\n地図で開く\n\(links)"
    }

    static func places(in text: String) -> [ShannonPlaceDTO] {
        text.split(separator: "\n").compactMap { line in
            let row = String(line)
            guard row.hasPrefix("- ["),
                  let nameEnd = row.range(of: "]("),
                  let urlEnd = row.range(of: ") — ", range: nameEnd.upperBound..<row.endIndex)
            else { return nil }
            let name = String(row[row.index(row.startIndex, offsetBy: 3)..<nameEnd.lowerBound])
            let rawURL = String(row[nameEnd.upperBound..<urlEnd.lowerBound])
            guard let url = URL(string: rawURL), url.scheme == "https",
                  url.host == "maps.apple.com",
                  let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                  let query = components.queryItems?.first(where: { $0.name == "q" })?.value,
                  !name.isEmpty, !query.isEmpty
            else { return nil }
            return ShannonPlaceDTO(
                name: name,
                address: String(row[urlEnd.upperBound...]),
                reason: "",
                mapQuery: query,
                mapUrl: rawURL
            )
        }
    }
}
