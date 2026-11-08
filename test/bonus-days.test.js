import assert from 'node:assert/strict';
import test from 'node:test';
import { planBonusDays } from '../src/services/bonus-days.js';

const d = (s) => new Date(`${s}T00:00:00Z`);
const day = 864e5;

test('nothing to do without paid time', () => {
  assert.deepEqual(planBonusDays(null, [{ id: 1, startsAt: d('2026-12-01'), expiresAt: d('2026-12-31') }]), []);
});

test('bonus already after the paid period stays', () => {
  const b = [{ id: 1, startsAt: d('2026-12-01'), expiresAt: d('2026-12-31') }];
  assert.deepEqual(planBonusDays(d('2026-12-01'), b, d('2026-11-15')), []);
});

test('monthly renewal over a waiting bonus moves it after the new period', () => {
  // Earned Nov 15 (sub ends Dec 1) -> bonus Dec 1..Dec 31. Dec 1: renewal to Jan 1.
  const now = new Date(d('2026-12-01').getTime() + 60_000);
  const b = [{ id: 7, startsAt: d('2026-12-01'), expiresAt: d('2026-12-31') }];
  const [c] = planBonusDays(d('2027-01-01'), b, now);
  assert.equal(c.id, 7);
  assert.deepEqual(c.startsAt, d('2027-01-01'));
  // 30 days minus the minute already "used" during the renewal
  assert.equal(c.expiresAt - c.startsAt, 30 * day - 60_000);
});

test('several bonuses are chained one after another', () => {
  const now = d('2026-11-20');
  const b = [
    { id: 1, startsAt: d('2026-12-01'), expiresAt: d('2026-12-31') },
    { id: 2, startsAt: d('2026-12-31'), expiresAt: d('2027-01-30') },
  ];
  const c = planBonusDays(d('2027-01-01'), b, now);
  assert.deepEqual(c.map((x) => x.id), [1, 2]);
  assert.deepEqual(c[0].startsAt, d('2027-01-01'));
  assert.deepEqual(c[0].expiresAt, d('2027-01-31'));
  assert.deepEqual(c[1].startsAt, d('2027-01-31'));
  assert.deepEqual(c[1].expiresAt, d('2027-03-02'));
});

test('a bonus in use when the user subscribes keeps only its unused days', () => {
  // Bonus Nov 1..Dec 1, used for 10 days, then a paid month starts Nov 11 (until Dec 11).
  const b = [{ id: 3, startsAt: d('2026-11-01'), expiresAt: d('2026-12-01') }];
  const [c] = planBonusDays(d('2026-12-11'), b, d('2026-11-11'));
  assert.deepEqual(c.startsAt, d('2026-12-11'));
  assert.equal(c.expiresAt - c.startsAt, 20 * day);
});

test('running it again changes nothing', () => {
  const now = d('2026-11-20');
  const b = [{ id: 1, startsAt: d('2026-12-01'), expiresAt: d('2026-12-31') }];
  const [c] = planBonusDays(d('2027-01-01'), b, now);
  assert.deepEqual(planBonusDays(d('2027-01-01'), [{ id: 1, ...c }], now), []);
});
