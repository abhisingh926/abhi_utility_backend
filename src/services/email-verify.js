import crypto from 'node:crypto';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { HttpError } from '../http.js';
import { sendMail, verificationEmail } from './mailer.js';
import { applyReferral } from './referrals.js';
import { sha256 } from './tokens.js';
import { startTrialIfEligible } from './trial.js';
import { findById } from './users.js';

/**
 * Email verification: a 6-digit code sent to the address. The free trial and
 * referral rewards start only once the user proves the address is theirs, so
 * made-up emails can't be used to farm trials or referral days.
 */

export const VERIFY_MINUTES = 30;
const MAX_ATTEMPTS = 5;
const RESEND_SECONDS = 60;

export const isVerified = (user) => !!user?.email_verified_at;

/** Emails a new code (older ones stop working). Returns the code only in tests. */
export async function sendVerificationCode(user) {
  if (isVerified(user)) return { alreadyVerified: true };
  const recent = await one(
    `SELECT 1 AS ok FROM email_verifications
     WHERE user_id = ? AND created_at > UTC_TIMESTAMP() - INTERVAL ? SECOND`,
    [user.id, RESEND_SECONDS],
  );
  if (recent) {
    throw new HttpError(429, 'A code was just sent. Wait a minute before asking for another one.', 'too_soon');
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await query('UPDATE email_verifications SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL', [user.id]);
  await query(
    'INSERT INTO email_verifications (user_id, code_hash, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE)',
    [user.id, sha256(`verify:${user.id}:${code}`), VERIFY_MINUTES],
  );
  await sendMail({ to: user.email, ...verificationEmail({ name: user.name, code, minutes: VERIFY_MINUTES }) });
  return config.exposeResetCodeForTests ? { devCode: code } : {};
}

/** Marks the email as verified (also used after a password reset by email code). */
export async function markVerified(userId) {
  await query('UPDATE users SET email_verified_at = UTC_TIMESTAMP() WHERE id = ? AND email_verified_at IS NULL', [userId]);
  await query('UPDATE email_verifications SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL', [userId]);
}

/**
 * What verifying unlocks: the free trial and a referral code given at sign-up.
 * Safe to call again. Returns { trialStarted, referral }.
 */
export async function unlockAfterVerification(userId) {
  const user = await findById(userId);
  if (!isVerified(user)) return { trialStarted: false, referral: null };
  const trialStarted = await startTrialIfEligible(user);
  let referral = null;
  if (user.pending_referrer_id) {
    await query('UPDATE users SET pending_referrer_id = NULL WHERE id = ?', [user.id]);
    const referrer = await one("SELECT * FROM users WHERE id = ? AND status = 'active'", [user.pending_referrer_id]);
    if (referrer) {
      try {
        referral = { applied: true, ...(await applyReferral(user, referrer)) };
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        referral = { applied: false, code: e.code, message: e.message };
      }
    }
  }
  return { trialStarted, referral };
}

/** Checks a code; on success the email is verified and the trial / referral start. */
export async function verifyEmail(user, rawCode) {
  if (isVerified(user)) return { alreadyVerified: true, ...(await unlockAfterVerification(user.id)) };
  const code = String(rawCode ?? '').replace(/\s/g, '');
  const invalid = new HttpError(400, 'The code is wrong or has expired. Ask for a new one.', 'invalid_verification_code');
  if (!/^\d{6}$/.test(code)) throw invalid;
  const row = await one(
    `SELECT * FROM email_verifications WHERE user_id = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()
     ORDER BY id DESC LIMIT 1`,
    [user.id],
  );
  if (!row || row.attempts >= MAX_ATTEMPTS) throw invalid;
  const a = Buffer.from(row.code_hash);
  const b = Buffer.from(sha256(`verify:${user.id}:${code}`));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    // Counted atomically, so parallel guesses can't go past the limit.
    await query('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?', [row.id]);
    throw invalid;
  }
  // Only the request that actually uses the code goes on (no double rewards).
  const used = await query(
    'UPDATE email_verifications SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL AND attempts < ?',
    [row.id, MAX_ATTEMPTS],
  );
  if (used.affectedRows !== 1) throw invalid;
  await markVerified(user.id);
  return { alreadyVerified: false, ...(await unlockAfterVerification(user.id)) };
}
