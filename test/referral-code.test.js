import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODE_LENGTH, newReferralCode, normalizeReferralCode } from '../src/services/referral-code.js';

test('new codes are 8 easy-to-read characters', () => {
  for (let i = 0; i < 200; i++) {
    const c = newReferralCode();
    assert.equal(c.length, CODE_LENGTH);
    assert.match(c, /^[A-HJKMNP-Z2-9]{8}$/);
    assert.equal(normalizeReferralCode(c), c);
  }
});

test('typed codes are cleaned up', () => {
  assert.equal(normalizeReferralCode(' k7mq-2xhp '), 'K7MQ2XHP');
  assert.equal(normalizeReferralCode('K7MQ 2XHP'), 'K7MQ2XHP');
  assert.equal(normalizeReferralCode('https://example.com/r/K7MQ2XHP'), 'K7MQ2XHP');
  // The link the app shares (Play Store install referrer).
  assert.equal(
    normalizeReferralCode('https://play.google.com/store/apps/details?id=com.abhi.abhi_utility&referrer=ref%3DK7MQ2XHP'),
    'K7MQ2XHP',
  );
  assert.equal(normalizeReferralCode('Use my code: https://x.com/?ref=k7mq2xhp'), 'K7MQ2XHP');
});

test('things that cannot be codes are rejected', () => {
  for (const bad of ['', 'ABC', 'K7MQ2XHPX', 'K7MQ2XH0', 'K7MQ2XHI', null, 42, undefined]) {
    assert.equal(normalizeReferralCode(bad), null, String(bad));
  }
});
