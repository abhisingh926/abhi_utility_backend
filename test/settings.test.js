import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS, validateChanges } from '../src/services/settings.js';

const current = Object.fromEntries(SETTINGS.map((s) => [s.key, s.default]));

test('every setting has a sane definition', () => {
  const keys = new Set();
  for (const s of SETTINGS) {
    assert.ok(!keys.has(s.key), `duplicate ${s.key}`);
    keys.add(s.key);
    assert.ok(s.key.length <= 64);
    assert.ok(Number.isInteger(s.default) && s.default >= s.min && s.default <= s.max, s.key);
    assert.ok(s.label && s.help && s.group && s.unit && s.env, s.key);
  }
});

test('returns only values that change, as numbers', () => {
  assert.deepEqual(validateChanges({ trialDays: 14, referralDays: current.referralDays }, current), {
    trialDays: { from: current.trialDays, to: 14 },
  });
  assert.deepEqual(validateChanges({ sosVideoMaxMb: '80' }, current), {
    sosVideoMaxMb: { from: current.sosVideoMaxMb, to: 80 },
  });
  assert.deepEqual(validateChanges({}, current), {});
});

test('0 is allowed where it switches a feature off', () => {
  assert.deepEqual(validateChanges({ trialDays: 0 }, current), { trialDays: { from: current.trialDays, to: 0 } });
});

test('refuses unknown keys, fractions, out-of-range and non-numbers', () => {
  for (const bad of [
    { nope: 1 },
    { trialDays: 1.5 },
    { trialDays: -1 },
    { trialDays: 366 },
    { sosLinkDays: 0 },
    { trialDays: '' },
    { trialDays: 'ten' },
    { trialDays: null },
    { trialDays: true },
  ]) {
    assert.throws(() => validateChanges(bad, current), { status: 400 }, JSON.stringify(bad));
  }
  assert.throws(() => validateChanges([1], current), { status: 400 });
  assert.throws(() => validateChanges(null, current), { status: 400 });
});
