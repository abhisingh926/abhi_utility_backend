import crypto from 'node:crypto';

/** No 0/O, 1/I/L: codes are read out and typed by people. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

/** A new random referral code like "K7MQ2XHP". */
export function newReferralCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

/**
 * What the user typed -> a code to look up, or null if it can't be one.
 * Accepts lowercase, spaces/dashes and a pasted link (".../r/K7MQ2XHP" or "?ref=K7MQ2XHP").
 * (Pure function: unit-tested.)
 */
export function normalizeReferralCode(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  const fromLink = s.match(/(?:\bref(?:=|%3D)|\/r\/)([A-Za-z0-9-]+)/i);
  if (fromLink) s = fromLink[1];
  s = s.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) {
    if (!ALPHABET.includes(ch)) return null;
  }
  return s;
}
