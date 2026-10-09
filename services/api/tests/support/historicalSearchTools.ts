type ToolModule = typeof import('../../src/mind/tools/shannonTools.js');
/** Old policy proofs keep their schema menu; new optional controls are tested by native schema/integration tests. */
export function historicalSearchTools(actual: ToolModule): ToolModule {
  const additions: Record<string, readonly string[]> = {
    'study.search': ['match', 'after', 'before', 'offset', 'order', 'field', 'kind', 'status'],
    'schedule.upcoming': ['query', 'kind', 'after', 'before', 'offset', 'limit'],
    'memory.search': ['match', 'after', 'before', 'offset', 'order', 'kind', 'limit'],
  };
  const project = (tool: ReturnType<ToolModule['shannonTool']>) => {
    if (!tool || !additions[tool.name]) return tool;
    const properties = { ...tool.input.properties };
    for (const key of additions[tool.name]!) delete properties[key];
    return { ...tool, input: { ...tool.input, properties } };
  };
  return { ...actual, SHANNON_TOOLS: actual.SHANNON_TOOLS.map(tool => project(tool)!),
    shannonTool: name => project(actual.shannonTool(name)),
    toolFromProviderName: name => project(actual.toolFromProviderName(name)),
    toolForSurface: (tool, surface) => project(actual.toolForSurface(tool, surface))!,
    offeredTools: (...args) => actual.offeredTools(...args).map(tool => project(tool)!),
  };
}
