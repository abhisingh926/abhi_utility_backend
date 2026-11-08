import { config } from '../config.js';
import { one, pool, query } from '../db.js';
import { HttpError } from '../http.js';
import { newReferralCode, normalizeReferralCode } from './referral-code.js';
import { sha256 } from './tokens.js';
import { trialEmailKey } from './trial-email.js';

/**
 * Referral program: every user has a code. When a NEW person registers with it
 * (or enters it within a few days of registering), the referrer gets
 * `REFERRAL_DAYS` extra days of Pro, added after the Pro time they already have.
 *
 * Abuse limits: one reward per email ever (normalised like the free trial, also
 * after deleting the account), no self-referral, at most `REFERRAL_MAX_PER_YEAR`
 * rewards per referrer in 365 days (more friends are still counted, not rewarded).
 */

const emailHash = (email) => sha256(trialEmailKey(email));

/** The user's referral code, created the first time it's needed. */
export async function codeFor(user) {
  if (user.referral_code) return user.referral_code;
  for (let i = 0; i < 6; i++) {
    const code = newReferralCode();
    const r = await query('UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL', [code, user.id])
      .catch((e) => {
        if (e.code === 'ER_DUP_ENTRY') return null; // taken by someone else: try another
        throw e;
      });
    if (r?.affectedRows === 1) return code;
    const fresh = await one('SELECT referral_code FROM users WHERE id = ?', [user.id]);
    if (fresh?.referral_code) return fresh.referral_code; // created meanwhile by another request
  }
  throw new Error('Could not create a referral code');
}

export const shareLink = (code) =>
  config.referral.appUrl
    ? `${config.referral.appUrl}${config.referral.appUrl.includes('?') ? '&' : '?'}referrer=${encodeURIComponent(`ref=${code}`)}`
    : null;

/** Looks up a typed code. Throws a friendly 400 if it doesn't exist. */
export async function findReferrer(input) {
  const code = normalizeReferralCode(input);
  const referrer = code
    ? await one("SELECT * FROM users WHERE referral_code = ? AND status = 'active'", [code])
    : null;
  if (!referrer) throw new HttpError(400, 'This referral code is not valid', 'invalid_referral_code');
  return referrer;
}

/**
 * Adds `days` of Pro to a user, starting when their current Pro time ends
 * (so a reward never overlaps time they already have).
 */
async function grantDays(conn, userId, days, refKey, note) {
  const [[row]] = await conn.query(
    `SELECT GREATEST(UTC_TIMESTAMP(), COALESCE(MAX(expires_at), UTC_TIMESTAMP())) AS start
     FROM subscriptions WHERE user_id = ? AND status IN ('active','grace','cancelled') AND expires_at IS NOT NULL`,
    [userId],
  );
  await conn.query(
    `INSERT IGNORE INTO subscriptions
       (user_id, source, product_id, store_ref_hash, status, auto_renew, starts_at, expires_at, note)
     VALUES (?, 'referral', 'referral_bonus', ?, 'active', 0, ?, ? + INTERVAL ? DAY, ?)`,
    [userId, sha256(refKey), row.start, row.start, days, note],
  );
}

/**
 * Records that `user` was referred by `referrer` and gives the reward.
 * Returns { rewarded, reason } (reason when not rewarded). Throws HttpError for
 * things the user should be told (own code, already used a code…).
 */
export async function applyReferral(user, referrer) {
  if (referrer.id === user.id || trialEmailKey(referrer.email) === trialEmailKey(user.email)) {
    throw new HttpError(400, "You can't use your own referral code", 'own_referral_code');
  }
  if (await one('SELECT 1 FROM referrals WHERE referred_user_id = ?', [user.id])) {
    throw new HttpError(409, 'You have already used a referral code', 'referral_already_used');
  }
  const hash = emailHash(user.email);
  if (await one('SELECT 1 FROM referrals WHERE referred_email_hash = ?', [hash])) {
    throw new HttpError(409, 'A referral code was already used with this email', 'referral_already_used');
  }
  // Only a person's first account counts (a deleted and re-created account doesn't).
  if (config.trial.days > 0) {
    const claim = await one('SELECT user_id FROM trial_claims WHERE email_hash = ?', [hash]);
    if (claim && claim.user_id !== user.id) {
      throw new HttpError(409, 'Referral codes are only for new users', 'referral_not_new_user');
    }
  }

  const { days, friendDays, maxPerYear } = config.referral;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Lock the referrer's row so two sign-ups at once can't both pass the yearly limit.
    await conn.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [referrer.id]);
    const [[{ n }]] = await conn.query(
      `SELECT COUNT(*) AS n FROM referrals
       WHERE referrer_id = ? AND status = 'rewarded' AND created_at > UTC_TIMESTAMP() - INTERVAL 365 DAY`,
      [referrer.id],
    );
    const rewarded = days > 0 && n < maxPerYear;
    const [ins] = await conn.query(
      `INSERT IGNORE INTO referrals (referrer_id, referred_user_id, referred_email_hash, status, reward_days)
       VALUES (?, ?, ?, ?, ?)`,
      [referrer.id, user.id, hash, rewarded ? 'rewarded' : 'limit_reached', rewarded ? days : 0],
    );
    if (ins.affectedRows !== 1) {
      await conn.rollback();
      throw new HttpError(409, 'You have already used a referral code', 'referral_already_used');
    }
    if (rewarded) {
      await grantDays(conn, referrer.id, days, `referral:${ins.insertId}:referrer`,
        `Referral bonus: ${days} days for inviting a friend`);
    }
    if (friendDays > 0) {
      await grantDays(conn, user.id, friendDays, `referral:${ins.insertId}:friend`,
        `Referral welcome bonus: ${friendDays} days`);
    }
    await conn.commit();
    return { rewarded, friendDays, reason: rewarded ? null : 'limit_reached' };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/** Can this user still enter a code? (new account, no code used yet) */
async function canApply(user) {
  if (await one('SELECT 1 FROM referrals WHERE referred_user_id = ?', [user.id])) return false;
  const age = await one(
    'SELECT TIMESTAMPDIFF(HOUR, created_at, UTC_TIMESTAMP()) AS hours FROM users WHERE id = ?',
    [user.id],
  );
  return (age?.hours ?? 1e9) < config.referral.applyWithinDays * 24;
}

/** Hides most of an email: "ab•••@gmail.com". */
function maskEmail(email) {
  const [name, host] = String(email).split('@');
  return `${name.slice(0, 2)}•••@${host ?? ''}`;
}

/** Everything the app's referral screen shows. */
export async function referralSummary(user) {
  const code = await codeFor(user);
  const friends = await query(
    `SELECT r.status, r.reward_days, r.created_at, u.name, u.email
     FROM referrals r LEFT JOIN users u ON u.id = r.referred_user_id
     WHERE r.referrer_id = ? ORDER BY r.id DESC LIMIT 100`,
    [user.id],
  );
  const usedCode = await one(
    `SELECT u.referral_code AS code, u.name FROM referrals r JOIN users u ON u.id = r.referrer_id
     WHERE r.referred_user_id = ?`,
    [user.id],
  );
  const yearCount = friends.filter(
    (f) => f.status === 'rewarded' && Date.now() - new Date(f.created_at).getTime() < 365 * 864e5,
  ).length;
  return {
    code,
    link: shareLink(code),
    rewardDays: config.referral.days,
    friendDays: config.referral.friendDays,
    maxPerYear: config.referral.maxPerYear,
    rewardsLeftThisYear: Math.max(0, config.referral.maxPerYear - yearCount),
    applyWithinDays: config.referral.applyWithinDays,
    invited: friends.length,
    rewarded: friends.filter((f) => f.status === 'rewarded').length,
    daysEarned: friends.reduce((s, f) => s + (f.reward_days || 0), 0),
    friends: friends.map((f) => ({
      name: f.name || (f.email ? maskEmail(f.email) : 'Deleted account'),
      status: f.status,
      rewardDays: f.reward_days,
      joinedAt: f.created_at,
    })),
    referredBy: usedCode ? { code: usedCode.code, name: usedCode.name } : null,
    canApplyCode: !usedCode && (await canApply(user)),
  };
}

/** POST /me/referral/apply: entering a friend's code after registering. */
export async function applyLater(user, input) {
  if (!(await canApply(user))) {
    const used = await one('SELECT 1 FROM referrals WHERE referred_user_id = ?', [user.id]);
    throw used
      ? new HttpError(409, 'You have already used a referral code', 'referral_already_used')
      : new HttpError(400, `Referral codes can only be entered in the first ${config.referral.applyWithinDays} days after registering`, 'referral_too_late');
  }
  return applyReferral(user, await findReferrer(input));
}
