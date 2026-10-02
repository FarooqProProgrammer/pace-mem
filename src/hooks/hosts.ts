/**
 * Host adapters. Each editor sends its own hook names and payloads; adapters
 * normalize them into one internal event shape and render the reply each host
 * expects on stdout.
 */

export type MemEvent = 'session-start' | 'prompt' | 'post-tool' | 'stop' | 'session-end';

export interface MemInput {
  session_id?: string;
  /** Project directory; its folder name is the project key. */
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
}

export interface Host {
  /** Maps the hook name given on the command line to an internal event. */
  event(name: string): MemEvent | undefined;
  normalize(raw: Record<string, unknown>): MemInput;
  /** What to print on stdout. `context` is set only for session-start. */
  reply(event: MemEvent, context?: string): string;
  /** Tool calls that are pace-mem's own memory lookups. */
  isOwnTool(toolName: string): boolean;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export const claudeCode: Host = {
  event: (name) => (['session-start', 'prompt', 'post-tool', 'stop', 'session-end'] as const).find((e) => e === name),
  normalize: (raw) => ({
    session_id: str(raw.session_id),
    cwd: str(raw.cwd),
    prompt: str(raw.prompt),
    tool_name: str(raw.tool_name),
    tool_input: raw.tool_input,
    tool_response: raw.tool_response,
    tool_use_id: str(raw.tool_use_id),
  }),
  reply: (event, context) =>
    event === 'session-start' && context
      ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } })
      : '',
  isOwnTool: (name) => name.includes('pace-mem'),
};

const CURSOR_EVENTS: Record<string, MemEvent> = {
  sessionStart: 'session-start',
  beforeSubmitPrompt: 'prompt',
  postToolUse: 'post-tool',
  stop: 'stop',
  sessionEnd: 'session-end',
};

// Cursor reports MCP calls as `MCP:<tool>` without the server name.
const OWN_MCP_TOOLS = new Set(['MCP:search', 'MCP:timeline', 'MCP:get_observations']);

export const cursor: Host = {
  event: (name) => CURSOR_EVENTS[name],
  normalize: (raw) => {
    const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots.filter((r) => typeof r === 'string') : [];
    return {
      // conversation_id is on every agent hook; session_id only on session hooks.
      session_id: str(raw.conversation_id) ?? str(raw.session_id),
      // The workspace root, not the tool's cwd, so a `cd` into a subfolder stays in the same project.
      cwd: roots[0] ?? str(process.env.CURSOR_PROJECT_DIR) ?? str(raw.cwd),
      prompt: str(raw.prompt),
      tool_name: str(raw.tool_name),
      tool_input: raw.tool_input,
      tool_response: raw.tool_output,
      tool_use_id: str(raw.tool_use_id),
    };
  },
  // Cursor parses stdout as JSON for every hook, so always print an object.
  reply: (event, context) => {
    if (event === 'session-start') return JSON.stringify(context ? { additional_context: context } : {});
    if (event === 'prompt') return JSON.stringify({ continue: true });
    return '{}';
  },
  isOwnTool: (name) => OWN_MCP_TOOLS.has(name) || name.includes('pace-mem'),
};

export const HOSTS: Record<string, Host> = { claude: claudeCode, cursor };
