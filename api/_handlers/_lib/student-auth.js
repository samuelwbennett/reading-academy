// api/_handlers/_lib/student-auth.js  (M16-L2)
//
// Server-side helpers for the passwordless student auth flow:
//   - hashPin(pin)          → { hash, salt } using scrypt (Node built-in)
//   - verifyPin(pin, hash, salt) → boolean
//   - generateClassCode()   → 5-char unambiguous uppercase code
//   - generateSessionToken() → { token, hash } — token sent to client,
//                              only the hash lands in the DB
//
// No external bcrypt dep — Node's crypto.scrypt is built in and
// stronger than 4-digit-PIN brute-force needs anyway.

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = 16384; // N — keep modest, PINs are small space anyway
const SALT_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;

// 5-char unambiguous alphanumeric. Drops O / 0 / I / 1 / L because
// printed roster sheets get squinted at by 5-year-olds.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function hashPin(pin) {
  if (!isValidPinFormat(pin)) {
    throw new Error("PIN must be 4 digits (0-9)");
  }
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const hash = scryptSync(String(pin), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_COST,
  }).toString("hex");
  return { hash, salt };
}

export function verifyPin(pin, hash, salt) {
  if (!hash || !salt || !isValidPinFormat(pin)) return false;
  let candidate;
  try {
    candidate = scryptSync(String(pin), salt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST,
    });
  } catch {
    return false;
  }
  let stored;
  try {
    stored = Buffer.from(hash, "hex");
  } catch {
    return false;
  }
  if (stored.length !== candidate.length) return false;
  return timingSafeEqual(stored, candidate);
}

export function isValidPinFormat(pin) {
  return typeof pin === "string" && /^[0-9]{4}$/.test(pin);
}

export function generateClassCode() {
  let out = "";
  for (let i = 0; i < 5; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

// Generate a session token + its storage hash. The hash uses the
// same scrypt KDF (with a fixed app-wide salt isn't needed; we hash
// with no salt because the token itself is 256 bits of entropy).
export function generateSessionToken() {
  const token = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
  // Use a fast SHA-256 here, not scrypt — token has 256 bits of
  // entropy already, scrypt overkill and slow on the validation
  // path that runs on every API call.
  const hash = sha256Hex(token);
  return { token, hash };
}

export function hashSessionToken(token) {
  return sha256Hex(String(token || ""));
}

function sha256Hex(input) {
  // Lazy import to avoid pulling crypto into static analysis cost.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}

// Generate a 4-digit PIN at random for new students. Avoids the
// boring 0000 / 1234 / 9999 patterns by retrying on those specific
// values. Callers can also accept a PIN typed by the teacher.
const BORING_PINS = new Set(["0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999", "1234", "4321", "0123"]);
export function generateRandomPin() {
  for (let attempt = 0; attempt < 12; attempt++) {
    const pin = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    if (!BORING_PINS.has(pin)) return pin;
  }
  // Fallback — extremely unlikely to ever hit.
  return "0420";
}
