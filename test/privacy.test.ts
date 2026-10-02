import { describe, expect, it } from 'vitest';
import { redactSecrets, sanitize, stripPrivate, truncate } from '../src/shared/privacy.js';

describe('privacy', () => {
  it('removes <private> blocks, including an unclosed one', () => {
    expect(stripPrivate('keep <private>secret</private> this')).toBe('keep  this');
    expect(stripPrivate('a <PRIVATE>x\ny</PRIVATE> b <private>tail')).toBe('a  b ');
  });

  it('redacts common secret formats', () => {
    const text = [
      'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
      'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'aws AKIAABCDEFGHIJKLMNOP',
      'PASSWORD="hunter2hunter2"',
      'db postgres://admin:s3cret@db.local/app',
      '{"api_key": "abcdef123456"}',
    ].join('\n');
    const out = redactSecrets(text);
    for (const leaked of ['sk-ant-api03', 'ghp_abc', 'AKIAABCD', 'hunter2', 's3cret', 'abcdef123456']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('PASSWORD="<redacted/>');
  });

  it('leaves ordinary code alone', () => {
    const code = 'const passwordField = form.get("password");\nfunction getApiKeyName() {}';
    expect(redactSecrets(code)).toBe(code);
  });

  it('truncates by bytes with a marker', () => {
    expect(truncate('abcdef', 10)).toBe('abcdef');
    expect(truncate('abcdefghij', 4)).toBe('abcd\n…[truncated: 6 bytes]');
  });

  it('sanitize stringifies objects and applies every rule', () => {
    const out = sanitize({ cmd: 'echo <private>x</private>', token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, { redact: true, maxBytes: 1000 });
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('<private>');
  });
});
