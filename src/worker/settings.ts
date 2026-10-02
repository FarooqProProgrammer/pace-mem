/**
 * Reading and writing settings from the dashboard. Worker-only (pulls in zod),
 * so the hook bundle stays small.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { DEFAULTS, paths, type Settings } from '../shared/config.js';

export const SettingsPatchSchema = z
  .object({
    provider: z.enum(['claude-cli', 'anthropic']),
    model: z.string().trim().regex(/^[a-z0-9][a-z0-9.\-]{2,80}$/, 'not a valid model id'),
    effort: z.enum(['low', 'medium', 'high']),
    batchSize: z.number().int().min(1).max(50),
    batchDelaySeconds: z.number().min(0).max(120),
    contextObservations: z.number().int().min(0).max(200),
    contextSummaries: z.number().int().min(0).max(20),
    redactSecrets: z.boolean(),
    skipTools: z.array(z.string().trim().min(1).max(120)).max(200),
    maxPayloadBytes: z.number().int().min(1_000).max(200_000),
    port: z.number().int().min(1024).max(65535),
    /** Empty string removes a stored key. */
    anthropicApiKey: z.string().trim().max(400),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** Changing these only takes effect after the worker restarts. */
export const RESTART_REQUIRED: (keyof Settings)[] = ['port'];

/** Settings without the API key, which never leaves the worker. */
export function publicSettings(s: Settings) {
  const { anthropicApiKey, ...rest } = s;
  return {
    ...rest,
    hasApiKey: !!anthropicApiKey,
    apiKeyHint: anthropicApiKey ? `…${anthropicApiKey.slice(-4)}` : null,
  };
}

function readFile(): Partial<Settings> {
  try {
    return existsSync(paths.settings()) ? JSON.parse(readFileSync(paths.settings(), 'utf8')) : {};
  } catch {
    return {};
  }
}

/**
 * Validates and persists a patch, then applies it to `live` in place, so every
 * component holding the settings object sees the change immediately.
 */
export function saveSettings(live: Settings, patch: unknown): { changed: (keyof Settings)[]; restartRequired: boolean } {
  const parsed = SettingsPatchSchema.parse(patch);
  const file: Partial<Settings> = { ...readFile() };
  const changed: (keyof Settings)[] = [];
  for (const [key, value] of Object.entries(parsed) as [keyof Settings, unknown][]) {
    if (key === 'anthropicApiKey' && value === '') {
      if (file.anthropicApiKey || live.anthropicApiKey) changed.push(key);
      delete file.anthropicApiKey;
      delete live.anthropicApiKey;
      continue;
    }
    if (JSON.stringify(live[key]) !== JSON.stringify(value)) changed.push(key);
    (file as Record<string, unknown>)[key] = value;
    (live as unknown as Record<string, unknown>)[key] = value;
  }
  // The file can hold an API key: keep it readable by the current user only.
  writeFileSync(paths.settings(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return { changed, restartRequired: changed.some((k) => RESTART_REQUIRED.includes(k)) };
}

/** Back to defaults; the API key is kept unless `keepApiKey` is false. */
export function resetSettings(live: Settings, keepApiKey = true): void {
  const key = keepApiKey ? live.anthropicApiKey : undefined;
  const port = live.port; // a port change would orphan the running worker
  for (const k of Object.keys(live) as (keyof Settings)[]) delete (live as Partial<Settings>)[k];
  Object.assign(live, { ...DEFAULTS, skipTools: [...DEFAULTS.skipTools], port }, key ? { anthropicApiKey: key } : {});
  const file: Partial<Settings> = key ? { anthropicApiKey: key } : {};
  if (port !== DEFAULTS.port) file.port = port;
  writeFileSync(paths.settings(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}
