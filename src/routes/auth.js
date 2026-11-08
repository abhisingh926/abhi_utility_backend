import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { ah, HttpError } from '../http.js';
import { requireAuth } from '../middleware/auth.js';
import { entitlementFor } from '../services/entitlements.js';
import { passwordResetEmail, sendMail } from '../services/mailer.js';
import { applyReferral, findReferrer } from '../services/referrals.js';
import { startTrialIfEligible } from '../services/trial.js';
import { revokeAllForUser, revokeRefresh, rotateRefresh, sessionFor, sha256, signAccess } from '../services/tokens.js';
import { checkPassword, createUser, dummyCheck, findByEmail, findById, hashPassword, publicUser } from '../services/users.js';
import * as v from '../validate.js';

export const authRouter = Router();

const device = (req) => req.body?.device || req.get('user-agent');

async function sessionResponse(user, req) {
  return {
    ...(await sessionFor(user, device(req))),
    user: publicUser(user),
    entitlement: await entitlementFor(user.id),
  };
}

/** POST /api/v1/auth/register { email, password, name?, referralCode? } */
authRouter.post('/register', ah(async (req, res) => {
  const email = v.email(req.body?.email);
  const password = v.password(req.body?.password);
  const name = v.optionalName(req.body?.name);
  // A wrong referral code stops the sign-up, so the user can fix it (or clear it).
  const rawCode = typeof req.body?.referralCode === 'string' ? req.body.referralCode.trim() : '';
  const referrer = rawCode ? await findReferrer(rawCode) : null;

  const user = await createUser({ email, password, name });
  // Registering is what starts the free trial.
  const trialStarted = await startTrialIfEligible(user);
  let referral = null;
  if (referrer) {
    try {
      referral = { applied: true, ...(await applyReferral(user, referrer)) };
    } catch (e) {
      // The account exists now: don't fail the sign-up over the code, just say why.
      if (!(e instanceof HttpError)) throw e;
      referral = { applied: false, code: e.code, message: e.message };
    }
  }
  res.status(201).json({ ...(await sessionResponse(user, req)), trialStarted, referral });
}));

/** POST /api/v1/auth/login { email, password } */
authRouter.post('/login', ah(async (req, res) => {
  const email = v.email(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = await findByEmail(email);
  const ok = user ? await checkPassword(password, user.password_hash) : await dummyCheck(password);
  if (!user || !ok) throw new HttpError(401, 'Wrong email or password', 'invalid_credentials');
  if (user.status !== 'active') throw new HttpError(403, 'This account has been disabled', 'account_disabled');
  await query('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
  // Accounts made before the trial existed (or by an admin) get theirs on first login.
  const trialStarted = await startTrialIfEligible(user);
  res.json({ ...(await sessionResponse(user, req)), trialStarted });
}));

/** POST /api/v1/auth/refresh { refreshToken } -> new token pair */
authRouter.post('/refresh', ah(async (req, res) => {
  const token = v.requiredString(req.body?.refreshToken, 'refreshToken', 200);
  const { userId, refreshToken } = await rotateRefresh(token, device(req));
  const user = await findById(userId);
  if (!user || user.status !== 'active') {
    await revokeRefresh(refreshToken);
    throw new HttpError(403, 'This account has been disabled', 'account_disabled');
  }
  res.json({ accessToken: signAccess(user), refreshToken });
}));

/** POST /api/v1/auth/logout { refreshToken } */
authRouter.post('/logout', ah(async (req, res) => {
  if (typeof req.body?.refreshToken === 'string') await revokeRefresh(req.body.refreshToken);
  res.json({ ok: true });
}));

// ---- Forgot password ------------------------------------------------------------

const RESET_MINUTES = 15;
const RESET_MAX_ATTEMPTS = 5;

/**
 * POST /api/v1/auth/forgot-password { email }
 * Emails a 6-digit code. Always answers the same way, so it doesn't reveal
 * which emails have accounts.
 */
authRouter.post('/forgot-password', ah(async (req, res) => {
  const email = v.email(req.body?.email);
  const user = await findByEmail(email);
  let devCode;
  if (user && user.status === 'active') {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    // Only the newest code works.
    await query('UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL', [user.id]);
    await query(
      'INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE)',
      [user.id, sha256(`${user.id}:${code}`), RESET_MINUTES],
    );
    await sendMail({ to: user.email, ...passwordResetEmail({ name: user.name, code, minutes: RESET_MINUTES }) });
    if (config.exposeResetCodeForTests) devCode = code;
  }
  res.json({
    ok: true,
    message: `If an account exists for ${email}, a reset code has been sent. It expires in ${RESET_MINUTES} minutes.`,
    ...(devCode ? { devCode } : {}),
  });
}));

/**
 * POST /api/v1/auth/reset-password { email, code, newPassword }
 * Sets the new password, logs out every device, and logs this one in.
 */
authRouter.post('/reset-password', ah(async (req, res) => {
  const email = v.email(req.body?.email);
  const code = String(req.body?.code ?? '').replace(/\s/g, '');
  const newPassword = v.password(req.body?.newPassword, 'New password');
  const invalid = new HttpError(400, 'The code is wrong or has expired. Ask for a new one.', 'invalid_reset_code');

  const user = await findByEmail(email);
  if (!user || user.status !== 'active' || !/^\d{6}$/.test(code)) throw invalid;
  const reset = await one(
    `SELECT * FROM password_resets WHERE user_id = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()
     ORDER BY id DESC LIMIT 1`,
    [user.id],
  );
  if (!reset || reset.attempts >= RESET_MAX_ATTEMPTS) throw invalid;
  if (reset.code_hash !== sha256(`${user.id}:${code}`)) {
    // Wrong guess: count it; after 5 the code stops working.
    await query('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?', [reset.id]);
    throw invalid;
  }

  await query('UPDATE password_resets SET used_at = UTC_TIMESTAMP() WHERE id = ?', [reset.id]);
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(newPassword), user.id]);
  await revokeAllForUser(user.id);
  res.json(await sessionResponse(user, req));
}));

/** POST /api/v1/auth/change-password { currentPassword, newPassword } -> logs out other devices */
authRouter.post('/change-password', requireAuth, ah(async (req, res) => {
  const ok = await checkPassword(String(req.body?.currentPassword ?? ''), req.user.password_hash);
  if (!ok) throw new HttpError(400, 'Current password is wrong', 'invalid_credentials');
  const newPassword = v.password(req.body?.newPassword, 'New password');
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(newPassword), req.user.id]);
  await revokeAllForUser(req.user.id);
  res.json(await sessionResponse(req.user, req));
}));
