/**
 * Password hashing for dashboard accounts: scrypt (Node built-in, no
 * dependency), N=2^15, r=8, p=1, 32-byte salt, 64-byte key — the same
 * `scrypt$<N>$<salt-b64>$<key-b64>` format axxiommarketinghub uses for its
 * brand-reviewer accounts, so parameters can change later without breaking
 * existing hashes.
 *
 * Async on purpose: a ~50–100 ms synchronous scrypt would block the event loop
 * that is also answering live-call webhooks; the async form runs on the libuv
 * thread pool.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const N = 32768;
const KEYLEN = 64;
const MAXMEM = 128 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, keylen: number, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, keylen, { N: n, r: 8, p: 1, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(32);
  const key = await scrypt(password, salt, KEYLEN, N);
  return `scrypt$${N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  if (!Number.isFinite(n) || n < 1024) return false;
  try {
    const salt = Buffer.from(parts[2], "base64");
    const expected = Buffer.from(parts[3], "base64");
    const key = await scrypt(password, salt, expected.length, n);
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burn the same scrypt work as a real verification when the email is unknown or
 * the account is disabled, so response timing doesn't reveal which emails exist.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await dummyHash);
  return false;
}

/** A hand-off password the admin reads once: 16 chars, unambiguous alphabet. */
export function generatePassword(length = 16): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function passwordPolicyError(password: string): string | null {
  if (password.length < 10) return "Password must be at least 10 characters.";
  if (password.length > 128) return "Password is too long.";
  return null;
}
