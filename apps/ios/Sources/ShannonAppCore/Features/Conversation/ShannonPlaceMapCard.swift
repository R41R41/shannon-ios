import MapKit
import SwiftUI

private struct ShannonMapPin: Identifiable {
    let place: ShannonPlaceDTO
    let coordinate: CLLocationCoordinate2D
    var id: String { place.id }
}

struct ShannonPlaceMapCard: View {
    let places: [ShannonPlaceDTO]
    @Environment(\.colorScheme) private var colorScheme
    @State private var pins: [ShannonMapPin] = []
    @State private var isLoading = true
    @State private var showsMap = false

    var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)
        VStack(alignment: .leading, spacing: ShannonSpacing.small) {
            Label("場所の候補", systemImage: "map")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.textPrimary)

            if let first = pins.first {
                Map(initialPosition: .region(region(around: first.coordinate))) {
                    ForEach(pins) { pin in
                        Marker(pin.place.name, coordinate: pin.coordinate)
                    }
                }
                .frame(height: 156)
                .clipShape(RoundedRectangle(cornerRadius: ShannonShape.medium))
                .allowsHitTesting(false)
                .accessibilityLabel("候補地の地図。地図を開くと操作できます")
            } else if isLoading {
                ProgressView("地図を準備中")
                    .frame(maxWidth: .infinity, minHeight: 80)
            } else {
                Text("地図上の位置を確認できませんでした。候補のリンクから確認できます。")
                    .font(.caption)
                    .foregroundStyle(palette.textSecondary)
            }

            Button {
                showsMap = true
            } label: {
                Label("地図を開く", systemImage: "arrow.up.left.and.arrow.down.right")
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: ShannonTouchTarget.minimum)
            }
            .buttonStyle(.bordered)
            .disabled(pins.isEmpty)

            ForEach(places) { place in
                if let url = safeURL(place.mapUrl) {
                    Link(destination: url) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(place.name).font(.callout.weight(.medium))
                            Text(place.address).font(.caption).foregroundStyle(palette.textSecondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 4)
                    }
                    .accessibilityLabel("\(place.name)、\(place.address)。マップで開く")
                }
            }
        }
        .padding(ShannonSpacing.medium)
        .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.large))
        .task(id: places.map(\.id)) { await resolvePlaces() }
        .sheet(isPresented: $showsMap) {
            NavigationStack {
                VStack(spacing: 0) {
                    if let first = pins.first {
                        Map(initialPosition: .region(region(around: first.coordinate))) {
                            ForEach(pins) { pin in
                                Marker(pin.place.name, coordinate: pin.coordinate)
                            }
                        }
                    }
                    List(places) { place in
                        if let url = safeURL(place.mapUrl) {
                            Link(destination: url) {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(place.name).font(.headline)
                                    Text(place.address).font(.subheadline)
                                    if !place.reason.isEmpty {
                                        Text(place.reason).font(.caption)
                                    }
                                }
                            }
                        }
                    }
                    .frame(maxHeight: 250)
                }
                .navigationTitle("場所を探す")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("閉じる") { showsMap = false }
                    }
                }
            }
        }
    }

    private func resolvePlaces() async {
        isLoading = true
        defer { isLoading = false }
        var resolved: [ShannonMapPin] = []
        for place in places.prefix(5) {
            guard !Task.isCancelled else { return }
            let request = MKLocalSearch.Request()
            request.naturalLanguageQuery = place.mapQuery
            guard let item = try? await MKLocalSearch(request: request).start().mapItems.first else { continue }
            resolved.append(ShannonMapPin(place: place, coordinate: item.placemark.coordinate))
        }
        pins = resolved
    }

    private func region(around coordinate: CLLocationCoordinate2D) -> MKCoordinateRegion {
        MKCoordinateRegion(center: coordinate, span: MKCoordinateSpan(latitudeDelta: 0.03, longitudeDelta: 0.03))
    }

    private func safeURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw), url.scheme == "https", url.host == "maps.apple.com" else { return nil }
        return url
    }
}
