import SwiftUI

#if DEBUG
/// Synthetic launch states for the Swift Pieces–derived surfaces. Never uses real conversation data.
extension ShannonConversationView {
    func applySwiftPiecesPreviewState() {
        guard model.isDesignPreview else { return }
        let arguments = ProcessInfo.processInfo.arguments
        if arguments.contains("-ShannonPreviewEmptyConversation") {
            model.selectedThreadId = "empty-preview"
            model.messages = []
        }
        if arguments.contains("-ShannonPreviewCodeBlock") {
            model.messages.append(ConversationMessage(
                role: .shannon,
                text: Self.previewCodeReply,
                sentAt: Date(),
                emotionSnapshot: model.messages.last(where: { $0.role == .shannon })?.emotionSnapshot
            ))
        }
        if arguments.contains("-ShannonPreviewThinking") {
            // Set after the first layout so the existing scroll-to-bottom reveals the indicator.
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(800))
                model.isSending = true
            }
        }
        if arguments.contains("-ShannonPreviewPlanTimeline"),
           var task = model.agentTasks.first(where: { $0.status == .running }) {
            task.plan = task.plan.enumerated().map { index, item in
                .init(id: item.id, title: item.title, status: index < 5 ? .completed : index == 5 ? .running : .pending)
            }
            model.upsertAgentTask(task)
            selectedPage = .work
            selectedAgentTaskID = task.id
        }
    }

    static let previewCodeReply = """
    設定の読み込み部分だけ切り出すと、こうなります。

    ```ts
    // 設定を読み込み、足りない値は既定値で補う
    import { readFile } from "node:fs/promises";

    export interface Settings {
      locale: string;
      retries: number;
    }

    const defaults: Settings = { locale: "ja-JP", retries: 3 };

    export async function loadSettings(path: string): Promise<Settings> {
      try {
        const raw = await readFile(path, "utf8");
        return { ...defaults, ...JSON.parse(raw) };
      } catch {
        return defaults;
      }
    }

    console.log(await loadSettings("./settings.json"));
    ```
    """
}
#endif
