import type { ToolExecutionContext, ToolRun } from './shannonToolTypes.js';
import type { ToolInput } from './shannonToolInput.js';
import type { ToolExecutor } from './shannonToolTypes.js';
import { MINECRAFT_LIFECYCLE_TOOLS } from './minecraftLifecycleToolDefinitions.js';
export interface MinecraftLifecycleToolPort {
  available(scope: string): boolean;
  execute(name: string, input: ToolInput, context: ToolExecutionContext, signal?: AbortSignal): Promise<ToolRun>;
}
export function minecraftLifecycleExecutors(port: MinecraftLifecycleToolPort): Readonly<Record<string, ToolExecutor>> {
  return Object.fromEntries(MINECRAFT_LIFECYCLE_TOOLS.map(tool => [tool.name, (input: ToolInput, context: ToolExecutionContext) => ({
    summary: '登録されたマイクラへの参加・サーバー状態を操作します。',
    run: (signal?: AbortSignal) => port.execute(tool.name, input, context, signal),
  })]));
}
