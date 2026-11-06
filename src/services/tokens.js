import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { HttpError } from '../http.js';

const ISSUER = 'abhi-utility';

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** Short-lived access token (sent as "Authorization: Bearer ..."). */
export function signAccess(user) {
  return jwt.sign({ sub: String(user.id), role: user.role }, config.jwt.secret, {
    expiresIn: config.jwt.accessTtl,
    issuer: ISSUER,
  });
}

export function verifyAccess(token) {
  return jwt.verify(token, config.jwt.secret, { issuer: ISSUER });
}

/** Long-lived refresh token: random, stored only as a hash. */
export async function issueRefresh(userId, device) {
  const token = crypto.randomBytes(48).toString('base64url');
  await query(
    'INSERT INTO refresh_tokens (user_id, token_hash, device, expires_at) VALUES (?, ?, ?, UTC_TIMESTAMP() + INTERVAL ? DAY)',
    [userId, sha256(token), device ? String(device).slice(0, 120) : null, config.jwt.refreshDays],
  );
  return token;
}

/**
 * Swaps a refresh token for a new one (rotation). Using an already-used token
 * means it was stolen: every session of that user is ended.
 */
export async function rotateRefresh(token, device) {
  const row = await one('SELECT * FROM refresh_tokens WHERE token_hash = ?', [sha256(token)]);
  if (!row) throw new HttpError(401, 'Please log in again', 'invalid_refresh_token');
  if (row.revoked_at) {
    await revokeAllForUser(row.user_id);
    throw new HttpError(401, 'Please log in again', 'invalid_refresh_token');
  }
  if (new Date(row.expires_at) <= new Date()) {
    throw new HttpError(401, 'Session expired, please log in again', 'invalid_refresh_token');
  }
  await query('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE id = ?', [row.id]);
  return { userId: row.user_id, refreshToken: await issueRefresh(row.user_id, device ?? row.device) };
}

export async function revokeRefresh(token) {
  await query('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE token_hash = ? AND revoked_at IS NULL', [
    sha256(token),
  ]);
}

export async function revokeAllForUser(userId) {
  await query('UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [userId]);
}

/** New access + refresh token pair after login / register. */
export async function sessionFor(user, device) {
  return {
    accessToken: signAccess(user),
    refreshToken: await issueRefresh(user.id, device),
  };
}
