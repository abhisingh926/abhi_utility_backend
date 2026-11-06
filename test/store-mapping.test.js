import assert from 'node:assert/strict';
import { test } from 'node:test';
import { givesPro, mapAppleSubscription, mapGoogleSubscription } from '../src/services/store-mapping.js';

const future = new Date(Date.now() + 30 * 86400_000).toISOString();
const past = new Date(Date.now() - 86400_000).toISOString();

function googleSub(state, extra = {}) {
  return {
    subscriptionState: state,
    startTime: '2026-01-01T00:00:00Z',
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    lineItems: [{ productId: 'abhi_pro_monthly', expiryTime: future, autoRenewingPlan: { autoRenewEnabled: true } }],
    externalAccountIdentifiers: { obfuscatedExternalAccountId: 'user-uuid' },
    ...extra,
  };
}

test('Google active subscription gives Pro and keeps the account token', () => {
  const m = mapGoogleSubscription(googleSub('SUBSCRIPTION_STATE_ACTIVE'));
  assert.equal(m.status, 'active');
  assert.equal(m.productId, 'abhi_pro_monthly');
  assert.equal(m.autoRenew, true);
  assert.equal(m.accountToken, 'user-uuid');
  assert.equal(givesPro(m), true);
});

test('Google cancelled subscription keeps Pro until it expires', () => {
  const m = mapGoogleSubscription(googleSub('SUBSCRIPTION_STATE_CANCELED'));
  assert.equal(m.status, 'cancelled');
  assert.equal(givesPro(m), true);
  assert.equal(givesPro({ ...m, expiresAt: new Date(past) }), false);
});

test('Google on hold / expired / pending do not give Pro', () => {
  for (const s of ['SUBSCRIPTION_STATE_ON_HOLD', 'SUBSCRIPTION_STATE_EXPIRED', 'SUBSCRIPTION_STATE_PENDING', 'SOMETHING_NEW']) {
    assert.equal(givesPro(mapGoogleSubscription(googleSub(s))), false, s);
  }
});

test('Google grace period gives Pro; unacknowledged purchases are flagged', () => {
  const m = mapGoogleSubscription(googleSub('SUBSCRIPTION_STATE_IN_GRACE_PERIOD', {
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    linkedPurchaseToken: 'old-token',
  }));
  assert.equal(m.status, 'grace');
  assert.equal(givesPro(m), true);
  assert.equal(m.needsAcknowledge, true);
  assert.equal(m.linkedPurchaseToken, 'old-token');
});

test('Apple statuses map to our statuses', () => {
  const tx = { productId: 'abhi_pro_yearly', expiresDate: Date.parse(future), originalTransactionId: '1000', appAccountToken: 'u' };
  assert.equal(mapAppleSubscription(1, tx, { autoRenewStatus: 1 }).status, 'active');
  assert.equal(mapAppleSubscription(1, tx, { autoRenewStatus: 0 }).status, 'cancelled');
  assert.equal(mapAppleSubscription(2, tx, null).status, 'expired');
  assert.equal(mapAppleSubscription(3, tx, null).status, 'on_hold');
  assert.equal(mapAppleSubscription(4, tx, null).status, 'grace');
  assert.equal(mapAppleSubscription(5, tx, null).status, 'revoked');
  const m = mapAppleSubscription(1, tx, { autoRenewStatus: 1 });
  assert.equal(m.accountToken, 'u');
  assert.equal(m.productId, 'abhi_pro_yearly');
  assert.equal(givesPro(m), true);
});

test('Admin lifetime grant (no expiry) gives Pro', () => {
  assert.equal(givesPro({ status: 'active', expiresAt: null }), true);
  assert.equal(givesPro({ status: 'revoked', expiresAt: null }), false);
});
