import fs from 'node:fs';
import path from 'node:path';
import { AppStoreServerAPIClient, Environment, SignedDataVerifier } from '@apple/app-store-server-library';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { findByStoreRef, logStoreEvent, upsertStoreSubscription } from './entitlements.js';
import { rechainBonusDays } from './referrals.js';
import { mapAppleSubscription } from './store-mapping.js';
import { findByUuid } from './users.js';

let apiClient;
let verifier;

const environment = () =>
  config.apple.environment === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX;

function assertConfigured() {
  const a = config.apple;
  if (!a.issuerId || !a.keyId || !a.privateKeyPath) {
    throw new HttpError(503, 'App Store verification is not set up on the server yet', 'store_not_configured');
  }
}

/** App Store Server API client (signed with your App Store Connect API key). */
function api() {
  assertConfigured();
  apiClient ??= new AppStoreServerAPIClient(
    fs.readFileSync(config.apple.privateKeyPath, 'utf8'),
    config.apple.keyId,
    config.apple.issuerId,
    config.apple.bundleId,
    environment(),
  );
  return apiClient;
}

/** Verifies Apple's signed data against Apple's root certificates (certs/apple/*.cer). */
function signedData() {
  if (!verifier) {
    const dir = config.apple.rootCertsDir;
    const certs = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.cer')).map((f) => fs.readFileSync(path.join(dir, f)))
      : [];
    if (!certs.length) {
      throw new HttpError(503, 'Apple root certificates are missing on the server', 'store_not_configured');
    }
    verifier = new SignedDataVerifier(certs, true, environment(), config.apple.bundleId, config.apple.appAppleId);
  }
  return verifier;
}

/** Fetches the current status of a subscription and stores it. */
async function syncOriginal(originalTransactionId, { requestingUser = null, eventType = 'verify' } = {}) {
  const res = await api().getAllSubscriptionStatuses(originalTransactionId);
  let last;
  for (const group of res.data ?? []) {
    last = (group.lastTransactions ?? []).find((t) => t.originalTransactionId === originalTransactionId) ?? last;
  }
  if (!last) throw new HttpError(400, 'Subscription not found on the App Store', 'invalid_purchase');

  const tx = await signedData().verifyAndDecodeTransaction(last.signedTransactionInfo);
  const renewal = last.signedRenewalInfo ? await signedData().verifyAndDecodeRenewalInfo(last.signedRenewalInfo) : null;
  const m = mapAppleSubscription(last.status, tx, renewal);

  let ownerId = null;
  if (m.accountToken) ownerId = (await findByUuid(m.accountToken))?.id ?? null;
  const existing = await findByStoreRef(originalTransactionId);
  ownerId ??= existing?.user_id ?? null;
  if (requestingUser) {
    if (ownerId && ownerId !== requestingUser.id) {
      throw new HttpError(409, 'This purchase belongs to another account', 'purchase_owned_by_other');
    }
    ownerId = requestingUser.id;
  }

  await upsertStoreSubscription({
    source: 'apple',
    storeRef: originalTransactionId,
    userId: ownerId,
    productId: m.productId,
    status: m.status,
    autoRenew: m.autoRenew,
    startsAt: m.startsAt,
    expiresAt: m.expiresAt,
    raw: { status: last.status, transaction: tx, renewal },
  });
  // A renewal must not eat referral bonus days: move them behind the paid time.
  await rechainBonusDays(ownerId);
  await logStoreEvent({ source: 'apple', eventType, storeRef: originalTransactionId, payload: { status: last.status, productId: m.productId } });
  return { ...m, userId: ownerId };
}

/**
 * Verifies a purchase sent by the app: either the signed transaction (StoreKit 2
 * JWS) or a transaction ID.
 */
export async function syncApplePurchase({ signedTransaction, transactionId }, { requestingUser }) {
  let tx;
  if (signedTransaction) {
    tx = await signedData().verifyAndDecodeTransaction(signedTransaction);
  } else if (transactionId) {
    const info = await api().getTransactionInfo(String(transactionId));
    tx = await signedData().verifyAndDecodeTransaction(info.signedTransactionInfo);
  } else {
    throw new HttpError(400, 'signedTransaction or transactionId is required', 'invalid_request');
  }
  return syncOriginal(tx.originalTransactionId, { requestingUser });
}

/**
 * App Store Server Notifications V2.
 * https://developer.apple.com/documentation/appstoreservernotifications
 */
export async function handleAppleNotification(signedPayload) {
  if (!signedPayload) throw new HttpError(400, 'signedPayload is required', 'invalid_request');
  const n = await signedData().verifyAndDecodeNotification(signedPayload);
  if (n.notificationType === 'TEST') {
    await logStoreEvent({ source: 'apple', eventType: 'TEST', payload: { notificationUUID: n.notificationUUID } });
    return 'test notification received';
  }
  const signedTx = n.data?.signedTransactionInfo;
  if (!signedTx) {
    await logStoreEvent({ source: 'apple', eventType: n.notificationType, payload: { notificationUUID: n.notificationUUID } });
    return 'ignored: no transaction';
  }
  const tx = await signedData().verifyAndDecodeTransaction(signedTx);
  await syncOriginal(tx.originalTransactionId, {
    eventType: [n.notificationType, n.subtype].filter(Boolean).join(':'),
  });
  return `subscription updated (${n.notificationType})`;
}
