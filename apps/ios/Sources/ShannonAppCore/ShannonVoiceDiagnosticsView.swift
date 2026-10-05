import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

public struct ShannonVoiceDiagnosticsView: View {
    /// The iPhone opens it as a sheet with 閉じる; the Mac shows it as a page of 設定 › 管理.
    private let showsCloseButton: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var report = ""
    @State private var copied = false

    public init(showsCloseButton: Bool = true) {
        self.showsCloseButton = showsCloseButton
    }

    public var body: some View {
        let palette = ShannonPalette.resolve(colorScheme)

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: ShannonSpacing.large) {
                    Text("会話内容や音声は記録せず、音声入力を開始した時の処理段階だけを端末内に保存します。")
                        .font(.shannon(.callout))
                        .foregroundStyle(palette.textSecondary)

                    Text(report.isEmpty ? "まだ診断ログはありません。" : report)
                        .font(.shannon(.caption, design: .monospaced))
                        .foregroundStyle(palette.textPrimary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(ShannonSpacing.medium)
                        .background(palette.subtleSurface, in: RoundedRectangle(cornerRadius: ShannonShape.medium))

                    Button {
                        copyReport()
                    } label: {
                        Label(copied ? "コピーしました" : "診断ログをコピー", systemImage: copied ? "checkmark" : "doc.on.doc")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(report.isEmpty)

                    Button("ログを消去", role: .destructive) {
                        ShannonVoiceDiagnostics.shared.clear()
                        report = ShannonVoiceDiagnostics.shared.report()
                        copied = false
                    }
                    .frame(maxWidth: .infinity)
                }
                .padding(ShannonSpacing.large)
            }
            .background(palette.canvas)
            .navigationTitle("音声診断")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                if showsCloseButton {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("閉じる") { dismiss() }
                    }
                }
            }
            .onAppear {
                report = ShannonVoiceDiagnostics.shared.report()
            }
        }
    }

    private func copyReport() {
#if canImport(UIKit)
        UIPasteboard.general.string = report
#elseif canImport(AppKit)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(report, forType: .string)
#endif
        copied = true
    }
}
