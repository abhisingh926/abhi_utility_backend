// End-to-end check against a running server:  BASE_URL=http://localhost:3000 npm run smoke
// Uses ADMIN_EMAIL / ADMIN_PASSWORD from .env. Creates and deletes a test user.
import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
let step = 0;

async function call(method, path, { token, body, expect = 200 } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  assert.equal(res.status, expect, `${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  console.log(`✔ ${++step}. ${method} ${path} -> ${res.status}`);
  return data;
}

const email = `smoke+${Date.now()}@example.com`;
const password = 'SmokeTest#12345';

await call('GET', '/api/health');
await call('GET', '/api/v1/plans');

// Sign up, log in, wrong password, duplicate email.
const reg = await call('POST', '/api/v1/auth/register', { body: { email, password, name: 'Smoke' }, expect: 201 });
// Registering starts the free trial (unless TRIAL_DAYS=0).
const trialOn = Number(process.env.TRIAL_DAYS ?? 30) > 0;
assert.equal(reg.trialStarted, trialOn);
assert.equal(reg.entitlement.isPro, trialOn);
if (trialOn) {
  assert.equal(reg.entitlement.isTrial, true);
  assert.equal(reg.entitlement.source, 'trial');
  assert.ok(new Date(reg.entitlement.expiresAt) > new Date());
}
await call('POST', '/api/v1/auth/register', { body: { email, password }, expect: 409 });
await call('POST', '/api/v1/auth/login', { body: { email, password: 'wrong-password' }, expect: 401 });
const login = await call('POST', '/api/v1/auth/login', { body: { email, password } });
assert.equal(login.trialStarted, false); // only one trial
await call('GET', '/api/v1/me', { expect: 401 });
const me = await call('GET', '/api/v1/me', { token: login.accessToken });
assert.equal(me.user.email, email);

// Refresh-token rotation; reusing an old refresh token ends all sessions.
const r1 = await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: login.refreshToken } });
await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: login.refreshToken }, expect: 401 });
await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: r1.refreshToken }, expect: 401 });

// Normal users can't use admin routes; store verification needs configuration.
await call('GET', '/api/v1/admin/stats', { token: login.accessToken, expect: 403 });

// Admin: give Pro, user sees it, revoke, disable.
const admin = await call('POST', '/api/v1/auth/login', {
  body: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
});
const stats = await call('GET', '/api/v1/admin/stats', { token: admin.accessToken });
assert.ok(stats.users >= 2);
const list = await call('GET', `/api/v1/admin/users?q=${encodeURIComponent(email)}`, { token: admin.accessToken });
assert.equal(list.users.length, 1);
const id = list.users[0].id;

const granted = await call('POST', `/api/v1/admin/users/${id}/grant`, { token: admin.accessToken, body: { days: 30, note: 'smoke' } });
assert.equal(granted.entitlement.isPro, true);
const proMe = await call('GET', '/api/v1/me', { token: login.accessToken });
assert.equal(proMe.entitlement.isPro, true);
assert.equal(proMe.entitlement.source, 'admin');
const proList = await call('GET', '/api/v1/admin/users?filter=pro', { token: admin.accessToken });
assert.ok(proList.users.some((u) => u.id === id));

const detail = await call('GET', `/api/v1/admin/users/${id}`, { token: admin.accessToken });
// Paid/admin Pro wins over the trial; revoke the grant and the trial too.
for (const s of detail.subscriptions.filter((x) => x.source === 'admin' || x.source === 'trial')) {
  await call('POST', `/api/v1/admin/users/${id}/subscriptions/${s.id}/revoke`, { token: admin.accessToken });
}
const revoked = await call('GET', '/api/v1/me', { token: login.accessToken });
assert.equal(revoked.entitlement.isPro, false);
assert.equal(revoked.entitlement.trial.used, trialOn);

await call('POST', `/api/v1/admin/users/${id}/grant`, { token: admin.accessToken, body: { lifetime: true } });
assert.equal((await call('GET', '/api/v1/me', { token: login.accessToken })).entitlement.expiresAt, null);

await call('PATCH', `/api/v1/admin/users/${id}`, { token: admin.accessToken, body: { status: 'disabled' } });
await call('GET', '/api/v1/me', { token: login.accessToken, expect: 403 });
await call('POST', '/api/v1/auth/login', { body: { email, password }, expect: 403 });
await call('PATCH', `/api/v1/admin/users/${id}`, { token: admin.accessToken, body: { status: 'active' } });

// Admin can't lock themselves out.
await call('PATCH', `/api/v1/admin/users/${admin.user.id}`, { token: admin.accessToken, body: { role: 'user' }, expect: 400 });

// Admin-created account, password reset.
const created = await call('POST', '/api/v1/admin/users', {
  token: admin.accessToken,
  body: { email: `smoke-admin-made+${Date.now()}@example.com`, password: 'Created#12345', proDays: 7 },
  expect: 201,
});
assert.equal(created.entitlement.isPro, true);
await call('POST', `/api/v1/admin/users/${created.user.id}/reset-password`, { token: admin.accessToken, body: { password: 'NewPass#12345' } });
await call('POST', '/api/v1/auth/login', { body: { email: created.user.email, password: 'NewPass#12345' } });
await call('DELETE', `/api/v1/admin/users/${created.user.id}`, { token: admin.accessToken });

// Purchases without store credentials -> clear "not configured" answer, webhook secret enforced.
const fresh = await call('POST', '/api/v1/auth/login', { body: { email, password } });
await call('POST', '/api/v1/purchases/google', { token: fresh.accessToken, body: { purchaseToken: 'x' }, expect: 503 });
await call('POST', '/webhooks/google?token=wrong', { body: {}, expect: 403 });

// ---- Cloud backup of diary + tasks -----------------------------------------------
const t = fresh.accessToken;
const photo = crypto.randomBytes(3000);
const sha = crypto.createHash('sha256').update(photo).digest('hex');

async function putPhoto(hash, bytes, expect) {
  const res = await fetch(`${BASE}/api/v1/backups/photos/${hash}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'image/jpeg' },
    body: bytes,
  });
  assert.equal(res.status, expect, `PUT photo -> ${res.status} ${await res.text()}`);
  console.log(`✔ ${++step}. PUT /api/v1/backups/photos/… -> ${res.status}`);
}

assert.equal((await call('GET', '/api/v1/backups', { token: t })).backups.length, 0);
assert.deepEqual((await call('POST', '/api/v1/backups/photos/check', { token: t, body: { hashes: [sha] } })).missing, [sha]);
const diary = JSON.stringify({ tasks: { '2026-11-05': [{ text: 'Call bank', done: false }] }, journal: [{ text: 'Dear diary', images: [sha] }] });
const early = await call('POST', '/api/v1/backups', { token: t, body: { payload: diary, photoHashes: [sha] }, expect: 409 });
assert.deepEqual(early.error.missing, [sha]);
await putPhoto(sha, crypto.randomBytes(3000), 400); // bytes don't match the hash
await putPhoto(sha, photo, 201);
await putPhoto(sha, photo, 200); // already stored
assert.deepEqual((await call('POST', '/api/v1/backups/photos/check', { token: t, body: { hashes: [sha] } })).missing, []);
await call('POST', '/api/v1/backups', {
  token: t,
  body: { payload: diary, photoHashes: [sha], meta: { tasks: 1, entries: 1 }, device: 'smoke', appVersion: '1.0.0' },
  expect: 201,
});
const latest = await call('GET', '/api/v1/backups/latest', { token: t });
assert.equal(latest.payload, diary);
assert.deepEqual(latest.photoHashes, [sha]);
const photoRes = await fetch(`${BASE}/api/v1/backups/photos/${sha}`, { headers: { Authorization: `Bearer ${t}` } });
assert.ok(Buffer.from(await photoRes.arrayBuffer()).equals(photo), 'restored photo matches');
console.log(`✔ ${++step}. GET /api/v1/backups/photos/… -> photo restored byte-for-byte`);
await call('GET', `/api/v1/backups/photos/${sha}`, { expect: 401 }); // other people can't fetch it

// Only the newest backups are kept.
for (let i = 0; i < 11; i++) {
  await call('POST', '/api/v1/backups', { token: t, body: { payload: `{"n":${i}}` }, expect: 201 });
}
const listed = await call('GET', '/api/v1/backups', { token: t });
assert.equal(listed.backups.length, listed.keep);
assert.ok(listed.usage.backupBytes > 0);
await call('DELETE', '/api/v1/backups', { token: t });
assert.equal((await call('GET', '/api/v1/backups', { token: t })).backups.length, 0);

// Change password, then forgot password -> email code -> reset.
const changed = await call('POST', '/api/v1/auth/change-password', {
  token: fresh.accessToken,
  body: { currentPassword: password, newPassword: 'Changed#12345' },
});
const unknown = await call('POST', '/api/v1/auth/forgot-password', { body: { email: 'nobody-here@example.com' } });
assert.equal(unknown.devCode, undefined); // same answer, nothing sent
const forgot = await call('POST', '/api/v1/auth/forgot-password', { body: { email } });
assert.match(forgot.devCode ?? '', /^\d{6}$/, 'set EXPOSE_RESET_CODE_FOR_TESTS=true for this test');
const wrongCode = forgot.devCode === '000000' ? '111111' : '000000';
await call('POST', '/api/v1/auth/reset-password', { body: { email, code: wrongCode, newPassword: 'Reset#12345' }, expect: 400 });
const reset = await call('POST', '/api/v1/auth/reset-password', { body: { email, code: forgot.devCode, newPassword: 'Reset#12345' } });
await call('POST', '/api/v1/auth/reset-password', { body: { email, code: forgot.devCode, newPassword: 'Again#12345' }, expect: 400 }); // used once
await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: changed.refreshToken }, expect: 401 }); // other sessions ended
await call('POST', '/api/v1/auth/login', { body: { email, password: 'Changed#12345' }, expect: 401 });
await call('POST', '/api/v1/auth/login', { body: { email, password: 'Reset#12345' } });

// Delete the account (store policy requirement).
await call('DELETE', '/api/v1/me', { token: reset.accessToken, body: { password: 'wrong' }, expect: 400 });
await call('DELETE', '/api/v1/me', { token: reset.accessToken, body: { password: 'Reset#12345' } });
await call('POST', '/api/v1/auth/login', { body: { email, password: 'Reset#12345' }, expect: 401 });

console.log(`\nAll ${step} checks passed.`);
