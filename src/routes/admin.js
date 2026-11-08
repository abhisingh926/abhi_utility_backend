import { Router } from 'express';
import { one, query } from '../db.js';
import { ah, HttpError } from '../http.js';
import { requireAdmin } from '../middleware/auth.js';
import { deleteAvatar, sendAvatar } from '../services/avatars.js';
import { deleteAllBackups, usageFor } from '../services/backups.js';
import { entitlementFor, listSubscriptions, PRO_SQL, proSql } from '../services/entitlements.js';
import { createPlan, deletePlan, plansWithStats, updatePlan } from '../services/plans.js';
import { revokeAllForUser } from '../services/tokens.js';
import { createUser, findById, hashPassword, publicUser } from '../services/users.js';
import * as v from '../validate.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

async function logAction(req, targetUserId, action, details = null) {
  await query('INSERT INTO admin_actions (admin_id, target_user_id, action, details) VALUES (?, ?, ?, ?)', [
    req.user.id,
    targetUserId,
    action,
    details ? JSON.stringify(details) : null,
  ]);
}

async function targetUser(req) {
  const user = await findById(Number(req.params.id));
  if (!user) throw new HttpError(404, 'User not found', 'not_found');
  return user;
}

function notSelf(req, user, what) {
  if (user.id === req.user.id) throw new HttpError(400, `You can't ${what} your own account`, 'self_action');
}

/** Gives Pro for [days] days (or forever when days is null). */
async function grantPro(userId, days, note) {
  await query(
    `INSERT INTO subscriptions (user_id, source, product_id, status, auto_renew, starts_at, expires_at, note)
     VALUES (?, 'admin', 'admin_grant', 'active', 0, UTC_TIMESTAMP(),
             ${days === null ? 'NULL' : 'UTC_TIMESTAMP() + INTERVAL ? DAY'}, ?)`,
    days === null ? [userId, note] : [userId, days, note],
  );
}

/** GET /api/v1/admin/stats */
adminRouter.get('/stats', ah(async (req, res) => {
  const stats = await one(
    `SELECT
       (SELECT COUNT(*) FROM users) AS users,
       (SELECT COUNT(*) FROM users WHERE created_at > UTC_TIMESTAMP() - INTERVAL 7 DAY) AS newThisWeek,
       (SELECT COUNT(DISTINCT user_id) FROM subscriptions
          WHERE user_id IS NOT NULL AND source <> 'trial' AND ${PRO_SQL}) AS pro,
       (SELECT COUNT(DISTINCT t.user_id) FROM subscriptions t
          WHERE t.user_id IS NOT NULL AND t.source = 'trial' AND ${proSql('t')}
            AND NOT EXISTS (SELECT 1 FROM subscriptions p WHERE p.user_id = t.user_id AND p.source <> 'trial'
              AND ${proSql('p')})) AS onTrial,
       (SELECT COUNT(DISTINCT user_id) FROM subscriptions
          WHERE user_id IS NOT NULL AND source IN ('google','apple') AND ${PRO_SQL}) AS paying,
       (SELECT COUNT(*) FROM users WHERE status = 'disabled') AS disabled`,
  );
  res.json(Object.fromEntries(Object.entries(stats).map(([k, val]) => [k, Number(val)])));
}));

/** GET /api/v1/admin/users?q=&filter=all|pro|trial|free|disabled|admin&page=1 */
adminRouter.get('/users', ah(async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 25;
  const activeSub = (sourceSql) =>
    `EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND ${sourceSql} AND ${proSql('s')})`;
  const proExists = activeSub("s.source <> 'trial'"); // paid or given by an admin
  const trialExists = activeSub("s.source = 'trial'");

  const where = [];
  const params = [];
  if (q) {
    where.push('(u.email LIKE ? OR u.name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const filter = req.query.filter;
  if (filter === 'pro') where.push(proExists);
  if (filter === 'trial') where.push(`${trialExists} AND NOT ${proExists}`);
  if (filter === 'free') where.push(`NOT ${proExists} AND NOT ${trialExists}`);
  if (filter === 'disabled') where.push("u.status = 'disabled'");
  if (filter === 'admin') where.push("u.role = 'admin'");
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = Number((await one(`SELECT COUNT(*) AS n FROM users u ${whereSql}`, params)).n);
  const rows = await query(
    `SELECT u.*, ${proExists} AS is_pro, ${trialExists} AS on_trial FROM users u ${whereSql} ORDER BY u.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  res.json({
    users: rows.map((u) => ({
      ...publicUser(u),
      isPro: !!u.is_pro,
      onTrial: !u.is_pro && !!u.on_trial,
      createdByAdmin: !!u.created_by_admin,
    })),
    page,
    pageSize,
    total,
  });
}));

/** POST /api/v1/admin/users { email, password, name?, role?, proDays? (number | "lifetime") } */
adminRouter.post('/users', ah(async (req, res) => {
  const user = await createUser({
    email: v.email(req.body?.email),
    password: v.password(req.body?.password),
    name: v.optionalName(req.body?.name),
    role: v.oneOf(req.body?.role ?? 'user', ['user', 'admin'], 'role'),
    createdByAdmin: true,
  });
  const proDays = req.body?.proDays;
  if (proDays === 'lifetime') await grantPro(user.id, null, 'Granted when the account was created');
  else if (proDays) await grantPro(user.id, v.intInRange(proDays, 1, 3650, 'proDays'), 'Granted when the account was created');
  await logAction(req, user.id, 'create_user', { email: user.email, role: user.role, proDays: proDays ?? null });
  res.status(201).json({ user: publicUser(user), entitlement: await entitlementFor(user.id) });
}));

/** GET /api/v1/admin/users/:id -> user, entitlement, subscriptions, recent admin actions */
adminRouter.get('/users/:id', ah(async (req, res) => {
  const user = await targetUser(req);
  const actions = await query(
    `SELECT a.action, a.details, a.created_at, adm.email AS admin_email
     FROM admin_actions a LEFT JOIN users adm ON adm.id = a.admin_id
     WHERE a.target_user_id = ? ORDER BY a.id DESC LIMIT 20`,
    [user.id],
  );
  // Backup sizes only: the content belongs to the user (and may be encrypted).
  const lastBackup = await one('SELECT created_at FROM backups WHERE user_id = ? ORDER BY id DESC LIMIT 1', [user.id]);
  res.json({
    user: { ...publicUser(user), createdByAdmin: !!user.created_by_admin },
    entitlement: await entitlementFor(user.id),
    subscriptions: await listSubscriptions(user.id),
    backup: { ...(await usageFor(user.id)), lastBackupAt: lastBackup?.created_at ?? null },
    actions,
  });
}));

/** DELETE /api/v1/admin/users/:id/backups -> frees a user's backup storage */
adminRouter.delete('/users/:id/backups', ah(async (req, res) => {
  const user = await targetUser(req);
  await deleteAllBackups(user);
  await logAction(req, user.id, 'delete_backups');
  res.json({ ok: true });
}));

/** GET /api/v1/admin/users/:id/avatar -> the user's profile photo (404 = none) */
adminRouter.get('/users/:id/avatar', ah(async (req, res) => {
  await sendAvatar(res, await targetUser(req));
}));

/** DELETE /api/v1/admin/users/:id/avatar -> removes an unsuitable profile photo */
adminRouter.delete('/users/:id/avatar', ah(async (req, res) => {
  const user = await targetUser(req);
  await deleteAvatar(user);
  await logAction(req, user.id, 'remove_avatar');
  res.json({ ok: true });
}));

/** PATCH /api/v1/admin/users/:id { name?, role?, status? } */
adminRouter.patch('/users/:id', ah(async (req, res) => {
  const user = await targetUser(req);
  const changes = {};
  if (req.body?.name !== undefined) changes.name = v.optionalName(req.body.name);
  if (req.body?.role !== undefined) {
    changes.role = v.oneOf(req.body.role, ['user', 'admin'], 'role');
    if (changes.role !== 'admin') notSelf(req, user, 'remove admin rights from');
  }
  if (req.body?.status !== undefined) {
    changes.status = v.oneOf(req.body.status, ['active', 'disabled'], 'status');
    if (changes.status === 'disabled') notSelf(req, user, 'disable');
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change', 'invalid_request');

  const cols = Object.keys(changes);
  await query(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...cols.map((c) => changes[c]),
    user.id,
  ]);
  if (changes.status === 'disabled') await revokeAllForUser(user.id); // log out everywhere
  await logAction(req, user.id, 'update_user', changes);
  res.json({ user: publicUser(await findById(user.id)) });
}));

/** POST /api/v1/admin/users/:id/reset-password { password } -> also logs the user out everywhere */
adminRouter.post('/users/:id/reset-password', ah(async (req, res) => {
  const user = await targetUser(req);
  const password = v.password(req.body?.password);
  await query('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), user.id]);
  await revokeAllForUser(user.id);
  await logAction(req, user.id, 'reset_password');
  res.json({ ok: true });
}));

/** POST /api/v1/admin/users/:id/grant { days | lifetime: true, note? } */
adminRouter.post('/users/:id/grant', ah(async (req, res) => {
  const user = await targetUser(req);
  const lifetime = req.body?.lifetime === true;
  const days = lifetime ? null : v.intInRange(req.body?.days, 1, 3650, 'days');
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 255) : null;
  await grantPro(user.id, days, note);
  await logAction(req, user.id, 'grant_pro', { days: lifetime ? 'lifetime' : days, note });
  res.json({ entitlement: await entitlementFor(user.id) });
}));

/**
 * POST /api/v1/admin/users/:id/subscriptions/:subId/revoke
 * Ends an admin grant or a free trial. Store subscriptions are controlled by Google/Apple:
 * cancel or refund those in Play Console / App Store Connect instead.
 */
adminRouter.post('/users/:id/subscriptions/:subId/revoke', ah(async (req, res) => {
  const user = await targetUser(req);
  const sub = await one('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [Number(req.params.subId), user.id]);
  if (!sub) throw new HttpError(404, 'Subscription not found', 'not_found');
  if (sub.source !== 'admin' && sub.source !== 'trial') {
    throw new HttpError(400, 'Store subscriptions are cancelled or refunded in Play Console / App Store Connect', 'store_managed');
  }
  await query("UPDATE subscriptions SET status = 'revoked', expires_at = UTC_TIMESTAMP() WHERE id = ?", [sub.id]);
  await logAction(req, user.id, sub.source === 'trial' ? 'end_trial' : 'revoke_pro', { subscriptionId: sub.id });
  res.json({ entitlement: await entitlementFor(user.id) });
}));

/** DELETE /api/v1/admin/users/:id */
adminRouter.delete('/users/:id', ah(async (req, res) => {
  const user = await targetUser(req);
  notSelf(req, user, 'delete');
  await deleteAllBackups(user);
  await deleteAvatar(user);
  await query('DELETE FROM users WHERE id = ?', [user.id]);
  await logAction(req, null, 'delete_user', { id: user.id, email: user.email });
  res.json({ ok: true });
}));

// ---- Subscription plans -----------------------------------------------------------

/** GET /api/v1/admin/plans -> every plan with subscribers and estimated revenue */
adminRouter.get('/plans', ah(async (req, res) => {
  res.json(await plansWithStats());
}));

/** POST /api/v1/admin/plans { productId, name, period, price?, currency?, description?, badge?, active?, sortOrder? } */
adminRouter.post('/plans', ah(async (req, res) => {
  const plan = await createPlan(req.body);
  await logAction(req, null, 'create_plan', plan);
  res.status(201).json({ plan });
}));

/** PATCH /api/v1/admin/plans/:id { any of the fields above except productId } */
adminRouter.patch('/plans/:id', ah(async (req, res) => {
  const { before, after } = await updatePlan(req.params.id, req.body);
  const changed = Object.fromEntries(
    Object.keys(after)
      .filter((k) => !['updatedAt', 'createdAt'].includes(k) && after[k] !== before[k])
      .map((k) => [k, { from: before[k], to: after[k] }]),
  );
  await logAction(req, null, 'update_plan', { productId: after.productId, changed });
  res.json({ plan: after });
}));

/** DELETE /api/v1/admin/plans/:id -> only plans nobody has bought */
adminRouter.delete('/plans/:id', ah(async (req, res) => {
  const plan = await deletePlan(req.params.id);
  await logAction(req, null, 'delete_plan', { productId: plan.productId, name: plan.name });
  res.json({ ok: true });
}));

/** GET /api/v1/admin/plans/history -> recent plan changes (who changed what) */
adminRouter.get('/plans/history', ah(async (req, res) => {
  const rows = await query(
    `SELECT a.action, a.details, a.created_at, adm.email AS admin_email
     FROM admin_actions a LEFT JOIN users adm ON adm.id = a.admin_id
     WHERE a.action IN ('create_plan','update_plan','delete_plan') ORDER BY a.id DESC LIMIT 30`,
  );
  res.json({ history: rows });
}));
