/**
 * Phone helpers for the outbound dialer. The leads workbook mixes formats
 * ("+1 877-834-3613", "(510) 555-1212", "5105551212"), and many `owner_phone`
 * values are generic toll-free / reservation lines that won't reach a decision
 * maker — we normalize to E.164 and flag those so the dialer can skip them.
 */

const TOLL_FREE_PREFIXES = ["800", "833", "844", "855", "866", "877", "888"];

/** Normalize a US/CA phone string to E.164 (+1XXXXXXXXXX), or null if invalid. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

/** A toll-free number is usually a call center / reservation line, not a lead. */
export function isTollFree(e164: string | null): boolean {
  if (!e164) return false;
  const area = e164.replace("+1", "").slice(0, 3);
  return TOLL_FREE_PREFIXES.includes(area);
}

/**
 * Pick the best number to dial for a lead. Prefers a direct contact line over a
 * generic owner line; returns { phone, lowQuality } so the importer can mark
 * leads whose only number is toll-free as `bad_number`.
 */
export function chooseDialNumber(
  contactPhone: string | null | undefined,
  ownerPhone: string | null | undefined,
): { phone: string | null; lowQuality: boolean } {
  const contact = toE164(contactPhone);
  const owner = toE164(ownerPhone);

  if (contact && !isTollFree(contact)) return { phone: contact, lowQuality: false };
  if (owner && !isTollFree(owner)) return { phone: owner, lowQuality: false };

  // Only toll-free numbers available — dial the contact one but flag it.
  const fallback = contact ?? owner;
  return { phone: fallback, lowQuality: !!fallback };
}
