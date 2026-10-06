/**
 * Reading and writing settings from the dashboard. Worker-only (pulls in zod),
 * so the hook bundle stays small.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { DEFAULTS, paths, type Settings } from '../shared/config.js';

export const SettingsPatchSchema = z
  .object({
    contextObservations: z.number().int().min(0).max(200),
    contextSummaries: z.number().int().min(0).max(20),
    redactSecrets: z.boolean(),
    skipTools: z.array(z.string().trim().min(1).max(120)).max(200),
    maxPayloadBytes: z.number().int().min(1_000).max(200_000),
    port: z.number().int().min(1024).max(65535),
  })
  .partial()
  .strict();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;

/** Changing these only takes effect after the worker restarts. */
export const RESTART_REQUIRED: (keyof Settings)[] = ['port'];

export function publicSettings(s: Settings) {
  const {
    provider: _provider,
    model: _model,
    effort: _effort,
    batchSize: _batchSize,
    batchDelaySeconds: _batchDelay,
    anthropicApiKey: _key,
    ...rest
  } = s;
  return rest;
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
    if (JSON.stringify(live[key]) !== JSON.stringify(value)) changed.push(key);
    (file as Record<string, unknown>)[key] = value;
    (live as unknown as Record<string, unknown>)[key] = value;
  }
  delete file.provider;
  delete file.model;
  delete file.effort;
  delete file.batchSize;
  delete file.batchDelaySeconds;
  delete file.anthropicApiKey;
  writeFileSync(paths.settings(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return { changed, restartRequired: changed.some((k) => RESTART_REQUIRED.includes(k)) };
}

export function resetSettings(live: Settings): void {
  const port = live.port; // a port change would orphan the running worker
  for (const k of Object.keys(live) as (keyof Settings)[]) delete (live as Partial<Settings>)[k];
  Object.assign(live, { ...DEFAULTS, skipTools: [...DEFAULTS.skipTools], port });
  const file: Partial<Settings> = {};
  if (port !== DEFAULTS.port) file.port = port;
  writeFileSync(paths.settings(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}
