import { config } from '../config.js';
import { one, pool } from '../db.js';
import { sha256 } from './tokens.js';
import { trialEmailKey } from './trial-email.js';

/** Each user has at most one trial row; this keeps it unique. */
const trialRefHash = (userId) => sha256(`trial:${userId}`);

/**
 * Starts the free trial for a registered user, once per email (also across
 * deleted and re-created accounts). Safe to call again: returns false when the
 * trial was already used or trials are switched off.
 */
export async function startTrialIfEligible(user) {
  if (!(config.trial.days > 0)) return false;
  if (!user.email_verified_at) return false; // starts once the email is confirmed
  if (await one("SELECT 1 FROM subscriptions WHERE user_id = ? AND source = 'trial' LIMIT 1", [user.id])) return false;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [claim] = await conn.query('INSERT IGNORE INTO trial_claims (email_hash, user_id) VALUES (?, ?)', [
      sha256(trialEmailKey(user.email)),
      user.id,
    ]);
    if (claim.affectedRows !== 1) {
      await conn.rollback();
      return false; // this email already had a trial
    }
    await conn.query(
      `INSERT IGNORE INTO subscriptions
         (user_id, source, product_id, store_ref_hash, status, auto_renew, starts_at, expires_at, note)
       VALUES (?, 'trial', 'free_trial', ?, 'active', 0, UTC_TIMESTAMP(), UTC_TIMESTAMP() + INTERVAL ? DAY, ?)`,
      [user.id, trialRefHash(user.id), config.trial.days, `${config.trial.days}-day free trial`],
    );
    await conn.commit();
    return true;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}
