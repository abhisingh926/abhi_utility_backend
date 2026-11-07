import { Router } from 'express';
import { query } from '../db.js';
import { ah, HttpError } from '../http.js';
import { requireAuth } from '../middleware/auth.js';
import { deleteAllBackups } from '../services/backups.js';
import { entitlementFor, listSubscriptions } from '../services/entitlements.js';
import { startTrialIfEligible } from '../services/trial.js';
import { checkPassword, publicUser } from '../services/users.js';
import * as v from '../validate.js';

export const meRouter = Router();
meRouter.use(requireAuth);

/** GET /api/v1/me -> the user and whether they are Pro. The app calls this on start. */
meRouter.get('/', ah(async (req, res) => {
  // Users who were already logged in before the trial existed get it here.
  await startTrialIfEligible(req.user);
  res.json({ user: publicUser(req.user), entitlement: await entitlementFor(req.user.id) });
}));

/** GET /api/v1/me/subscriptions -> purchase history */
meRouter.get('/subscriptions', ah(async (req, res) => {
  res.json({ subscriptions: await listSubscriptions(req.user.id) });
}));

/** PATCH /api/v1/me { name } */
meRouter.patch('/', ah(async (req, res) => {
  await query('UPDATE users SET name = ? WHERE id = ?', [v.optionalName(req.body?.name), req.user.id]);
  res.json({ ok: true });
}));

/**
 * DELETE /api/v1/me { password } -> deletes the account and its data.
 * Required by Google Play and the App Store for apps with sign-up. Store
 * subscriptions must still be cancelled in the Play Store / App Store.
 */
meRouter.delete('/', ah(async (req, res) => {
  const ok = await checkPassword(String(req.body?.password ?? ''), req.user.password_hash);
  if (!ok) throw new HttpError(400, 'Password is wrong', 'invalid_credentials');
  await deleteAllBackups(req.user); // backup photos are files, not only rows
  await query('DELETE FROM users WHERE id = ?', [req.user.id]);
  res.json({ ok: true });
}));
