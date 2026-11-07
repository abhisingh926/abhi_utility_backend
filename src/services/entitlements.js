import { one, query } from '../db.js';
import { sha256 } from './tokens.js';

/** Statuses that still give Pro (cancelled = won't renew, but paid until expiry). */
export const PRO_STATUSES = ['active', 'grace', 'cancelled'];

/** SQL condition "this subscription row gives Pro now", for a table alias. */
export const proSql = (alias) =>
  `${alias}.status IN ('active','grace','cancelled') AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > UTC_TIMESTAMP())`;

export const PRO_SQL = "status IN ('active','grace','cancelled') AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())";

/**
 * Is the user Pro right now, and until when? A free trial counts as Pro; a
 * paid or admin-given plan is preferred over the trial when both are active.
 */
export async function entitlementFor(userId) {
  const best = await one(
    `SELECT * FROM subscriptions WHERE user_id = ? AND ${PRO_SQL}
     ORDER BY source = 'trial' ASC, expires_at IS NULL DESC, expires_at DESC LIMIT 1`,
    [userId],
  );
  const trialRow = await one(
    "SELECT starts_at, expires_at FROM subscriptions WHERE user_id = ? AND source = 'trial' ORDER BY id DESC LIMIT 1",
    [userId],
  );
  const trial = {
    used: !!trialRow,
    startedAt: trialRow?.starts_at ?? null,
    endsAt: trialRow?.expires_at ?? null,
  };
  if (!best) {
    return { isPro: false, isTrial: false, source: null, productId: null, status: null, expiresAt: null, autoRenew: false, trial };
  }
  return {
    isPro: true,
    isTrial: best.source === 'trial',
    source: best.source, // google | apple | admin | trial
    productId: best.product_id,
    status: best.status,
    expiresAt: best.expires_at, // null = lifetime
    autoRenew: !!best.auto_renew,
    trial,
  };
}

export const listSubscriptions = (userId) =>
  query(
    `SELECT id, source, product_id, status, auto_renew, starts_at, expires_at, note, created_at, updated_at
     FROM subscriptions WHERE user_id = ? ORDER BY id DESC`,
    [userId],
  );

export const findByStoreRef = (storeRef) =>
  one('SELECT * FROM subscriptions WHERE store_ref_hash = ?', [sha256(storeRef)]);

/** Inserts or updates the row for a Google purchase token / Apple original transaction. */
export async function upsertStoreSubscription({
  source, storeRef, userId, productId, status, autoRenew, startsAt, expiresAt, raw,
}) {
  await query(
    `INSERT INTO subscriptions
       (user_id, source, product_id, store_ref, store_ref_hash, status, auto_renew, starts_at, expires_at, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       user_id = COALESCE(VALUES(user_id), user_id),
       product_id = VALUES(product_id),
       status = VALUES(status),
       auto_renew = VALUES(auto_renew),
       starts_at = COALESCE(VALUES(starts_at), starts_at),
       expires_at = VALUES(expires_at),
       raw = VALUES(raw)`,
    [
      userId ?? null,
      source,
      productId,
      storeRef,
      sha256(storeRef),
      status,
      autoRenew ? 1 : 0,
      startsAt ?? null,
      expiresAt ?? null,
      raw ? JSON.stringify(raw) : null,
    ],
  );
}

export async function logStoreEvent({ source, eventType, storeRef, payload, ok = true, error = null }) {
  await query(
    'INSERT INTO store_events (source, event_type, store_ref_hash, payload, processed_ok, error) VALUES (?, ?, ?, ?, ?, ?)',
    [
      source,
      eventType ?? null,
      storeRef ? sha256(storeRef) : null,
      payload ? JSON.stringify(payload) : null,
      ok ? 1 : 0,
      error ? String(error).slice(0, 500) : null,
    ],
  );
}
