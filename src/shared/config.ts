import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export type Provider = 'claude-cli' | 'anthropic';

export interface Settings {
  /** Port the worker listens on (127.0.0.1 only). */
  port: number;
  /** How observations are generated: the user's Claude Code login, or an API key. */
  provider: Provider;
  model: string;
  /** Effort passed to the model (`low` keeps compression cheap). */
  effort: 'low' | 'medium' | 'high';
  /** Max tool events compressed in one model call. */
  batchSize: number;
  /** Seconds to wait for more tool events before compressing a batch. */
  batchDelaySeconds: number;
  /** Observations listed in the SessionStart context index. */
  contextObservations: number;
  /** Recent session summaries included in the SessionStart context. */
  contextSummaries: number;
  /** Replace common secret patterns with <redacted/> before storing. */
  redactSecrets: boolean;
  /** Tools whose calls are never recorded. */
  skipTools: string[];
  /** Upper bound per tool payload (bytes) stored and sent to the model. */
  maxPayloadBytes: number;
  /**
   * API key for `provider: "anthropic"`. Optional: falls back to ANTHROPIC_API_KEY,
   * which editors such as Cursor usually don't pass to the worker.
   */
  anthropicApiKey?: string;
}

export const DEFAULT_SKIP_TOOLS = [
  'TodoWrite',
  'TodoRead',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskOutput',
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ScheduleWakeup',
];

const DEFAULTS: Settings = {
  port: 37800,
  provider: 'claude-cli',
  model: 'claude-opus-5-5',
  effort: 'low',
  batchSize: 15,
  batchDelaySeconds: 4,
  contextObservations: 40,
  contextSummaries: 3,
  redactSecrets: true,
  skipTools: DEFAULT_SKIP_TOOLS,
  maxPayloadBytes: 16_000,
};

export function dataDir(): string {
  const dir = process.env.PACE_MEM_DATA_DIR || join(homedir(), '.pace-mem');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export const paths = {
  db: () => join(dataDir(), 'pace-mem.db'),
  settings: () => join(dataDir(), 'settings.json'),
  pid: () => join(dataDir(), 'worker.pid'),
  log: () => join(dataDir(), 'worker.log'),
};

let cached: Settings | undefined;

export function loadSettings(): Settings {
  if (cached) return cached;
  let file: Partial<Settings> = {};
  try {
    if (existsSync(paths.settings())) file = JSON.parse(readFileSync(paths.settings(), 'utf8'));
  } catch {
    // A broken settings file must never take memory down; fall back to defaults.
  }
  const env = process.env;
  cached = {
    ...DEFAULTS,
    ...file,
    ...(env.PACE_MEM_PORT ? { port: Number(env.PACE_MEM_PORT) } : {}),
    ...(env.PACE_MEM_PROVIDER ? { provider: env.PACE_MEM_PROVIDER as Provider } : {}),
    ...(env.PACE_MEM_MODEL ? { model: env.PACE_MEM_MODEL } : {}),
  };
  return cached;
}

export function workerUrl(path = ''): string {
  return `http://127.0.0.1:${loadSettings().port}${path}`;
}

/** Project key for a working directory. */
export function projectFromCwd(cwd: string | undefined): string {
  if (!cwd) return 'default';
  return basename(cwd.replace(/[\\/]+$/, '')) || 'default';
}

/** Set on the model subprocess so our own hooks don't record the compression call. */
export const DISABLE_ENV = 'PACE_MEM_DISABLED';
