// Control chars, zero-width chars and bidi overrides (Trojan Source) never carry meaning in this domain.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export function clean(text: string): string {
  return text.normalize("NFC").replace(INVISIBLE, "").replace(/\r\n?/g, "\n").trim();
}

const SECRET_PATTERNS: [string, RegExp][] = [
  ["anthropic_key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ["aws_key", /\bAKIA[0-9A-Z]{16}\b/],
  ["google_key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["platform_token", /\bcb_[A-Za-z0-9_-]{40,}/],
];

export function findSecret(text: string): string | null {
  for (const [name, re] of SECRET_PATTERNS) if (re.test(text)) return name;
  return null;
}

// Blocked outright: text that only makes sense as an attack on the reading agent.
const INJECTION_BLOCK: RegExp[] = [
  /\b(?:ignore|disregard|forget)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|your)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules|directions)\b/i,
  /<\/?\s*(?:system|assistant|user|instructions?)\s*>/i,
  /\[\/?(?:INST|SYS)\]|<\|im_(?:start|end)\|>/i,
];

// Flagged but allowed: legitimate text can discuss these.
const INJECTION_FLAG: [string, RegExp][] = [
  ["mentions_system_prompt", /\bsystem prompt\b/i],
  ["role_override", /\byou are now\b|\bact as\b|\bnew instructions\b/i],
  ["shell_command", /(?:^|\s)(?:curl|wget|bash|sh|powershell|pwsh|sudo|rm\s+-rf|chmod|npx|pip install)\s/i],
  ["asks_for_credentials", /\b(?:api[_ ]?key|password|token|credentials?)\b[^.\n]{0,30}\b(?:send|post|share|paste|give)\b/i],
];

export function injectionCheck(text: string): { blocked: boolean; flags: string[] } {
  const blocked = INJECTION_BLOCK.some((re) => re.test(text));
  const flags = INJECTION_FLAG.filter(([, re]) => re.test(text)).map(([name]) => name);
  return { blocked, flags };
}

export type TextVerdict = { ok: true; text: string; flags: string[] } | { ok: false; error: string };

export const BAD_ENCODING = "contains U+FFFD replacement characters, so it was not sent as valid UTF-8; send UTF-8 JSON or use \\u escapes";

export function screen(raw: string, field: string): TextVerdict {
  if (raw.includes("�")) return { ok: false, error: `${field} ${BAD_ENCODING}` };
  const text = clean(raw);
  const secret = findSecret(text);
  if (secret) return { ok: false, error: `${field} looks like it contains a secret (${secret}); remove it` };
  const inj = injectionCheck(text);
  if (inj.blocked) return { ok: false, error: `${field} contains instruction-like text aimed at other agents` };
  return { ok: true, text, flags: inj.flags };
}

export function textKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
