import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { one, query } from '../db.js';

/** Each user's photos live in STORAGE_DIR/users/<user uuid>/<sha256>. */
export function userDir(user) {
  return path.resolve(config.backup.storageDir, 'users', user.uuid);
}

export const photoPath = (user, sha) => path.join(userDir(user), sha);

export const isSha256 = (s) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);

/** Bytes used by the user's backups (text + photos). */
export async function usageFor(userId) {
  const row = await one(
    `SELECT
       (SELECT COALESCE(SUM(size_bytes), 0) FROM backups WHERE user_id = ?) AS backupBytes,
       (SELECT COUNT(*) FROM backups WHERE user_id = ?) AS backups,
       (SELECT COALESCE(SUM(size_bytes), 0) FROM backup_photos WHERE user_id = ?) AS photoBytes,
       (SELECT COUNT(*) FROM backup_photos WHERE user_id = ?) AS photos`,
    [userId, userId, userId, userId],
  );
  const usage = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
  return { ...usage, quotaBytes: config.backup.quotaMb * 1024 * 1024 };
}

/** Keeps only the newest [keep] backups, then removes photos no backup uses. */
export async function pruneBackups(user, keep = config.backup.keep) {
  await query(
    `DELETE FROM backups WHERE user_id = ? AND id NOT IN (
       SELECT id FROM (SELECT id FROM backups WHERE user_id = ? ORDER BY id DESC LIMIT ?) AS newest)`,
    [user.id, user.id, keep],
  );
  await removeUnusedPhotos(user);
}

/**
 * Deletes photos that no remaining backup refers to. Photos uploaded in the
 * last hour are kept: their backup may still be on its way.
 */
export async function removeUnusedPhotos(user) {
  const used = new Set();
  for (const b of await query('SELECT photo_hashes FROM backups WHERE user_id = ?', [user.id])) {
    const list = typeof b.photo_hashes === 'string' ? JSON.parse(b.photo_hashes) : b.photo_hashes;
    for (const h of list ?? []) used.add(h);
  }
  const photos = await query(
    'SELECT sha256 FROM backup_photos WHERE user_id = ? AND created_at < UTC_TIMESTAMP() - INTERVAL 1 HOUR',
    [user.id],
  );
  for (const { sha256 } of photos) {
    if (used.has(sha256)) continue;
    await query('DELETE FROM backup_photos WHERE user_id = ? AND sha256 = ?', [user.id, sha256]);
    await fs.rm(photoPath(user, sha256), { force: true });
  }
}

/** Removes all backup data of a user (account deletion / "delete my backups"). */
export async function deleteAllBackups(user) {
  await query('DELETE FROM backups WHERE user_id = ?', [user.id]);
  await query('DELETE FROM backup_photos WHERE user_id = ?', [user.id]);
  await fs.rm(userDir(user), { recursive: true, force: true });
}
