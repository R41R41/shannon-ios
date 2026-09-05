import SwiftUI
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

struct ShannonVoiceDiagnosticsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var report = ""
    @State private var copied = false

    var body: some View {
        let palette = M3Palette.resolve(colorScheme)

        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: M3Spacing.large) {
                    Text("会話内容や音声は記録せず、音声入力を開始した時の処理段階だけを端末内に保存します。")
                        .font(.callout)
                        .foregroundStyle(palette.onSurfaceVariant)

                    Text(report.isEmpty ? "まだ診断ログはありません。" : report)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(palette.onSurface)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(M3Spacing.medium)
                        .background(palette.surfaceContainer, in: RoundedRectangle(cornerRadius: M3Shape.medium))

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
                .padding(M3Spacing.large)
            }
            .background(palette.surface)
            .navigationTitle("音声診断")
#if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
#endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
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
