import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { DISABLE_ENV, type Settings } from '../shared/config.js';

export interface LlmRequest<T extends z.ZodType> {
  system: string;
  prompt: string;
  schema: T;
}

export interface Llm {
  generate<T extends z.ZodType>(req: LlmRequest<T>): Promise<z.infer<T>>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    /** Retrying the same input would not help (refusal, bad output). */
    readonly permanent = false,
  ) {
    super(message);
  }
}

/** JSON Schema for `--json-schema`; the CLI's validator rejects zod's draft-2020-12 `$schema` tag. */
export function cliSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * Runs `claude -p` headless, so compression uses the user's existing Claude Code
 * login. No tools, no settings, no MCP, no saved session: one structured answer.
 */
export class ClaudeCliLlm implements Llm {
  constructor(
    private readonly settings: Settings,
    private readonly bin = process.env.PACE_MEM_CLAUDE_BIN || 'claude',
  ) {}

  generate<T extends z.ZodType>(req: LlmRequest<T>): Promise<z.infer<T>> {
    const args = [
      '-p',
      '--model', this.settings.model,
      ...(supportsEffort(this.settings.model) ? ['--effort', this.settings.effort] : []),
      '--tools', '',
      '--setting-sources', '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--output-format', 'json',
      '--system-prompt', req.system,
      '--json-schema', JSON.stringify(cliSchema(req.schema)),
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        env: { ...process.env, [DISABLE_ENV]: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new LlmError('claude CLI timed out after 180s'));
      }, 180_000);
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new LlmError(`could not start claude CLI: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        try {
          const out = JSON.parse(stdout);
          if (out.is_error) return reject(new LlmError(`claude CLI error: ${out.result ?? out.subtype}`));
          const parsed = req.schema.safeParse(out.structured_output);
          if (!parsed.success) return reject(new LlmError('claude CLI returned output that does not match the schema', true));
          resolve(parsed.data);
        } catch {
          reject(new LlmError(`claude CLI exited ${code}: ${(stderr || stdout).slice(0, 500)}`));
        }
      });
      child.stdin.end(req.prompt);
    });
  }
}

const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1|sonnet-5-5)/;

/** Haiku, Sonnet 4.5 and pre-4.5 models reject the effort parameter. */
export function supportsEffort(model: string): boolean {
  return !/haiku|sonnet-4-5|claude-3|-4-0|-4-1|-4-2025/.test(model);
}

/** Calls the Messages API with ANTHROPIC_API_KEY (or any credential the SDK resolves). */
export class AnthropicApiLlm implements Llm {
  private client?: Anthropic;
  private clientKey?: string;

  constructor(private readonly settings: Settings) {}

  /** Rebuilt when the key changes in the dashboard. */
  private getClient(): Anthropic {
    const key = this.settings.anthropicApiKey;
    if (!this.client || this.clientKey !== key) {
      this.client = key ? new Anthropic({ apiKey: key }) : new Anthropic();
      this.clientKey = key;
    }
    return this.client;
  }

  async generate<T extends z.ZodType>(req: LlmRequest<T>): Promise<z.infer<T>> {
    // Server-side fallback reroutes a safety refusal to another model instead of dropping the batch.
    const fallback = FALLBACK_MODELS.test(this.settings.model);
    try {
      const res = await this.getClient().beta.messages.parse({
        model: this.settings.model,
        max_tokens: 16000,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
        output_config: {
          ...(supportsEffort(this.settings.model) ? { effort: this.settings.effort } : {}),
          format: betaZodOutputFormat(req.schema),
        },
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      if (res.stop_reason === 'refusal') throw new LlmError(`model refused: ${res.stop_details?.category ?? 'unknown'}`, true);
      if (res.stop_reason === 'max_tokens') throw new LlmError('model hit max_tokens', true);
      if (res.parsed_output == null) throw new LlmError('model returned unparseable output', true);
      return res.parsed_output as z.infer<T>;
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.AuthenticationError) {
        throw new LlmError(`Anthropic API rejected the request: ${err.message}`, err instanceof Anthropic.BadRequestError);
      }
      if (err instanceof Anthropic.APIError) throw new LlmError(`Anthropic API error: ${err.message}`);
      throw err;
    }
  }
}

/** Picks the provider on every call, so a provider switch in the dashboard applies without a restart. */
export function createLlm(settings: Settings): Llm {
  const cli = new ClaudeCliLlm(settings);
  const api = new AnthropicApiLlm(settings);
  return { generate: (req) => (settings.provider === 'anthropic' ? api : cli).generate(req) };
}
