import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { findByStoreRef, logStoreEvent, upsertStoreSubscription } from './entitlements.js';
import { rechainBonusDays } from './referrals.js';
import { mapGoogleSubscription } from './store-mapping.js';
import { sha256 } from './tokens.js';
import { query } from '../db.js';
import { findByUuid } from './users.js';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
let clientPromise;

function credentials() {
  const v = config.google.serviceAccount;
  if (!v) {
    throw new HttpError(503, 'Google Play verification is not set up on the server yet', 'store_not_configured');
  }
  return v.trim().startsWith('{') ? JSON.parse(v) : JSON.parse(fs.readFileSync(v, 'utf8'));
}

/** Authenticated client for the Google Play Developer API (service account). */
function client() {
  clientPromise ??= new GoogleAuth({
    credentials: credentials(),
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  })
    .getClient()
    .catch((e) => {
      clientPromise = null; // try again next time instead of caching the failure
      throw e;
    });
  return clientPromise;
}

const pkg = () => encodeURIComponent(config.google.packageName);

export async function fetchSubscription(purchaseToken) {
  const c = await client();
  try {
    const res = await c.request({
      url: `${API}/${pkg()}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
    });
    return res.data;
  } catch (e) {
    const status = e.response?.status;
    if (status === 400 || status === 404 || status === 410) {
      throw new HttpError(400, 'This purchase could not be verified with Google Play', 'invalid_purchase');
    }
    throw e;
  }
}

/** Google refunds the purchase after 3 days unless it is acknowledged. */
async function acknowledge(productId, purchaseToken) {
  const c = await client();
  await c.request({
    method: 'POST',
    url: `${API}/${pkg()}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
    data: {},
  });
}

/**
 * Re-reads a purchase from Google and stores its current state.
 * [requestingUser]: the logged-in user who sent it from the app (links the
 * purchase to their account), or null for webhook updates.
 */
export async function syncGooglePurchase(purchaseToken, { requestingUser = null, eventType = 'verify' } = {}) {
  const sub = await fetchSubscription(purchaseToken);
  const m = mapGoogleSubscription(sub);

  // Whose purchase is it? The app sends our accountToken to Google at purchase.
  let ownerId = null;
  if (m.accountToken) ownerId = (await findByUuid(m.accountToken))?.id ?? null;
  const existing = await findByStoreRef(purchaseToken);
  ownerId ??= existing?.user_id ?? null;

  if (requestingUser) {
    if (ownerId && ownerId !== requestingUser.id) {
      throw new HttpError(409, 'This purchase belongs to another account', 'purchase_owned_by_other');
    }
    ownerId = requestingUser.id;
  }

  await upsertStoreSubscription({
    source: 'google',
    storeRef: purchaseToken,
    userId: ownerId,
    productId: m.productId,
    status: m.status,
    autoRenew: m.autoRenew,
    startsAt: m.startsAt,
    expiresAt: m.expiresAt,
    raw: sub,
  });
  // A renewal must not eat referral bonus days: move them behind the paid time.
  await rechainBonusDays(ownerId);

  // Upgrade / downgrade / resubscribe: the previous token no longer gives Pro.
  if (m.linkedPurchaseToken) {
    await query(
      `UPDATE subscriptions SET status = 'expired', auto_renew = 0
       WHERE source = 'google' AND store_ref_hash = ? AND status <> 'expired'`,
      [sha256(m.linkedPurchaseToken)],
    );
  }

  if (m.needsAcknowledge && ['active', 'grace', 'cancelled'].includes(m.status)) {
    try {
      await acknowledge(m.productId, purchaseToken);
    } catch (e) {
      console.error('Google acknowledge failed', e.message); // retried on the next sync
    }
  }

  await logStoreEvent({ source: 'google', eventType, storeRef: purchaseToken, payload: { state: sub.subscriptionState, productId: m.productId } });
  return { ...m, userId: ownerId };
}

/**
 * Real-time developer notification (Pub/Sub push). Returns a short description.
 * https://developer.android.com/google/play/billing/rtdn-reference
 */
export async function handleGoogleNotification(body) {
  const data = body?.message?.data;
  if (!data) throw new HttpError(400, 'Not a Pub/Sub push message', 'invalid_request');
  const n = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));

  if (n.testNotification) {
    await logStoreEvent({ source: 'google', eventType: 'TEST', payload: n });
    return 'test notification received';
  }
  if (n.packageName && n.packageName !== config.google.packageName) {
    await logStoreEvent({ source: 'google', eventType: 'WRONG_PACKAGE', payload: n, ok: false });
    return 'ignored: other package';
  }
  const sn = n.subscriptionNotification;
  if (!sn?.purchaseToken) {
    // One-time products / voided purchases: not used by this app (yet).
    await logStoreEvent({ source: 'google', eventType: 'OTHER', payload: n });
    return 'ignored: not a subscription notification';
  }
  await syncGooglePurchase(sn.purchaseToken, { eventType: `RTDN_${sn.notificationType}` });
  return `subscription updated (type ${sn.notificationType})`;
}
