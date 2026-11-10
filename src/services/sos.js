import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { getSettings } from './settings.js';

/**
 * SOS alerts: when no SOS contact answers, the phone uploads its location and a
 * short video (with sound). Contacts get an SMS with a private link
 * (PUBLIC_URL/sos/<token>) that works without logging in.
 *
 * The phone authenticates with a long-lived SOS key (made while logged in, kept by
 * the native SOS code): at the moment of an emergency the phone is locked and the
 * normal 15-minute login token may have expired.
 */

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const isAlertToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{32}$/.test(t);

export function sosDir() {
  return path.resolve(config.backup.storageDir, 'sos');
}

export const videoPath = (token) => path.join(sosDir(), `${token}.mp4`);

export const alertUrl = (token) => `${config.publicUrl.replace(/\/$/, '')}/sos/${token}`;

/** Makes a new SOS key for the user (the previous one stops working). */
export async function issueKey(userId) {
  const key = `sos_${crypto.randomBytes(32).toString('base64url')}`;
  await query(
    `INSERT INTO sos_keys (user_id, key_hash) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE key_hash = VALUES(key_hash), created_at = CURRENT_TIMESTAMP`,
    [userId, sha256(key)],
  );
  return key;
}

export async function revokeKey(userId) {
  await query('DELETE FROM sos_keys WHERE user_id = ?', [userId]);
}

/** The active user an SOS key belongs to, or null. */
export async function userForKey(key) {
  if (typeof key !== 'string' || !key.startsWith('sos_') || key.length > 100) return null;
  return one(
    `SELECT u.* FROM sos_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = ? AND u.status = 'active'`,
    [sha256(key)],
  );
}

export async function createAlert(user, { lat, lng, accuracy }) {
  const token = crypto.randomBytes(24).toString('base64url'); // 32 chars
  await query(
    `INSERT INTO sos_alerts (user_id, token, sender_name, lat, lng, accuracy_m)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [user.id, token, user.name || null, lat ?? null, lng ?? null, accuracy == null ? null : Math.round(accuracy)],
  );
  return token;
}

/** Alert that is still within its link lifetime, or null. */
export async function liveAlert(token) {
  if (!isAlertToken(token)) return null;
  return one(
    `SELECT * FROM sos_alerts WHERE token = ? AND created_at > UTC_TIMESTAMP() - INTERVAL ? DAY`,
    [token, (await getSettings()).sosLinkDays],
  );
}

/** Deletes alerts (and their videos) older than the link lifetime. */
export async function pruneExpiredAlerts() {
  const old = await query('SELECT token FROM sos_alerts WHERE created_at <= UTC_TIMESTAMP() - INTERVAL ? DAY', [
    (await getSettings()).sosLinkDays,
  ]);
  for (const { token } of old) {
    await fs.rm(videoPath(token), { force: true });
    await query('DELETE FROM sos_alerts WHERE token = ?', [token]);
  }
}

/** Account deletion: remove the user's SOS videos (rows go with the user). */
export async function deleteUserSos(user) {
  for (const { token } of await query('SELECT token FROM sos_alerts WHERE user_id = ?', [user.id])) {
    await fs.rm(videoPath(token), { force: true });
  }
  await query('DELETE FROM sos_alerts WHERE user_id = ?', [user.id]);
  await revokeKey(user.id);
}

/** MP4 / MOV files have "ftyp" at byte 4. */
export const looksLikeMp4 = (buf) => buf.length > 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp';
