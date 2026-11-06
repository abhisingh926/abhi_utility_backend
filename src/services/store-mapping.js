/**
 * Turns Google Play / App Store subscription data into our own fields.
 * Pure functions (no network, no database) so they can be unit-tested.
 */

const GOOGLE_STATES = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace',
  SUBSCRIPTION_STATE_CANCELED: 'cancelled', // won't renew, still paid until expiry
  SUBSCRIPTION_STATE_ON_HOLD: 'on_hold', // payment failed after grace period
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_PENDING: 'pending', // payment not completed yet
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'expired',
  SUBSCRIPTION_STATE_EXPIRED: 'expired',
};

/** Google Play Developer API purchases.subscriptionsv2 resource -> our fields. */
export function mapGoogleSubscription(sub) {
  // Several line items only with add-ons; the base plan is the latest-expiring one.
  const items = [...(sub.lineItems ?? [])].sort(
    (a, b) => new Date(b.expiryTime ?? 0) - new Date(a.expiryTime ?? 0),
  );
  const item = items[0] ?? {};
  return {
    productId: item.productId ?? 'unknown',
    status: GOOGLE_STATES[sub.subscriptionState] ?? 'expired',
    autoRenew: !!item.autoRenewingPlan?.autoRenewEnabled,
    startsAt: sub.startTime ? new Date(sub.startTime) : null,
    expiresAt: item.expiryTime ? new Date(item.expiryTime) : null,
    // Set by the app at purchase time (our user's accountToken).
    accountToken: sub.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? null,
    // When a user upgrades/downgrades, the old token is replaced by this one.
    linkedPurchaseToken: sub.linkedPurchaseToken ?? null,
    needsAcknowledge: sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING',
    isTest: !!sub.testPurchase,
  };
}

/**
 * App Store subscription status (1..5) + decoded transaction + renewal info ->
 * our fields. https://developer.apple.com/documentation/appstoreserverapi/status
 */
export function mapAppleSubscription(statusCode, tx, renewal) {
  const autoRenew = renewal?.autoRenewStatus === 1;
  const status = {
    1: autoRenew ? 'active' : 'cancelled', // ACTIVE
    2: 'expired', // EXPIRED
    3: 'on_hold', // BILLING_RETRY
    4: 'grace', // BILLING_GRACE_PERIOD
    5: 'revoked', // REVOKED (refund / family sharing removed)
  }[statusCode] ?? 'expired';
  return {
    productId: tx?.productId ?? 'unknown',
    status,
    autoRenew,
    startsAt: tx?.originalPurchaseDate ? new Date(tx.originalPurchaseDate) : null,
    expiresAt: tx?.expiresDate ? new Date(tx.expiresDate) : null,
    accountToken: tx?.appAccountToken ?? null,
    originalTransactionId: tx?.originalTransactionId ?? null,
  };
}

/** Statuses that give Pro (must match PRO_STATUSES / PRO_SQL). */
export function givesPro({ status, expiresAt }, now = new Date()) {
  return ['active', 'grace', 'cancelled'].includes(status) && (expiresAt === null || expiresAt > now);
}
