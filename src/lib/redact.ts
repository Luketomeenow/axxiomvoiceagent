/**
 * PII redaction for logs. Phone numbers, emails, and names should not land in
 * plaintext application logs (Railway log retention + access). Use these when
 * logging tool args or dial targets.
 */

/** +14155551234 → "***1234"; keeps just enough to correlate without exposing the number. */
export function maskPhone(v: unknown): string {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return `***${digits.slice(-4)}`;
}

/** john.doe@x.com → "j***@x.com". */
export function maskEmail(v: unknown): string {
  const s = String(v ?? "").trim();
  const at = s.indexOf("@");
  if (at <= 0) return s ? "***" : "";
  return `${s[0]}***${s.slice(at)}`;
}

/** Mask a free-text name to its first initial: "Jane Smith" → "J***". */
function maskName(v: unknown): string {
  const s = String(v ?? "").trim();
  return s ? `${s[0]}***` : "";
}

const SECRET_KEY = /(secret|token|authorization|api[_-]?key|password)/i;

/**
 * Deep-clone a value with any secret-ish string fields masked, for safe printing.
 * Used by the create-assistant scripts: a Vapi validation error can echo back the
 * request body (including server.secret), which would otherwise land in CI logs.
 */
export function redactSecretsDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretsDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) && typeof v === "string" ? "***redacted***" : redactSecretsDeep(v);
    }
    return out;
  }
  return value;
}

const PHONE_KEY = /(phone|number|mobile|cell)/i;
const EMAIL_KEY = /email/i;
const NAME_KEY = /name/i;

/**
 * Shallow-copy an object with known-PII fields masked, for safe logging. Matches
 * on key name (phone/number/email/name), so it covers tool args like
 * bestCallbackPhone, contact_email, fullName without an explicit allow-list.
 */
export function redactPII(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) {
    if (typeof val === "string" && val) {
      if (EMAIL_KEY.test(k)) out[k] = maskEmail(val);
      else if (PHONE_KEY.test(k)) out[k] = maskPhone(val);
      else if (NAME_KEY.test(k)) out[k] = maskName(val);
      else out[k] = val;
    } else {
      out[k] = val;
    }
  }
  return out;
}
