/** Removes `<private>...</private>` blocks; content inside them is never stored. */
export function stripPrivate(text: string): string {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, '').replace(/<private>[\s\S]*$/i, '');
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@/gi,
];

const SECRET_KEY = String.raw`[A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)[A-Za-z0-9_]*`;
// `password = "..."`, `"api_key": "..."`: a quoted literal. Keep the key, drop the value.
const QUOTED_ASSIGNMENT = new RegExp(String.raw`\b(${SECRET_KEY})(["']?\s*[:=]\s*)(["'])([^"'\s]{6,})\3`, 'gi');
// `API_KEY=abc123…` (env files, shell): an unquoted token. Code like `x = form.get(...)` is left alone.
const BARE_ASSIGNMENT = new RegExp(String.raw`\b(${SECRET_KEY})(\s*[:=]\s*)([A-Za-z0-9_\-+/=!@#$%^&*~]{8,})(?=[\s;,]|$)`, 'gim');

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '<redacted/>');
  return out
    .replace(QUOTED_ASSIGNMENT, (_m, key, sep, quote) => `${key}${sep}${quote}<redacted/>${quote}`)
    .replace(BARE_ASSIGNMENT, (_m, key, sep) => `${key}${sep}<redacted/>`);
}

export function truncate(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return `${cut}\n…[truncated: ${bytes - maxBytes} bytes]`;
}

export function toText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Applies every privacy rule to a payload before it is stored or sent to a model. */
export function sanitize(value: unknown, opts: { redact: boolean; maxBytes: number }): string {
  let text = stripPrivate(toText(value));
  if (opts.redact) text = redactSecrets(text);
  return truncate(text, opts.maxBytes);
}
