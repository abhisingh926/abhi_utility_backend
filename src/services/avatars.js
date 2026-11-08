import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { query } from '../db.js';
import { HttpError } from '../http.js';
import { imageType } from './image-type.js';

/**
 * Profile photos: one per user, at STORAGE_DIR/avatars/<user uuid>.
 * Kept apart from backups (STORAGE_DIR/users/...) so deleting backups keeps the photo.
 * users.avatar_sha / avatar_type describe the current photo (null = none).
 */

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const avatarDir = () => path.resolve(config.backup.storageDir, 'avatars');
const avatarPath = (user) => path.join(avatarDir(), user.uuid);

/** Version string the app uses to know the photo changed (null = no photo). */
export const avatarVersion = (u) => (u.avatar_sha ? u.avatar_sha.slice(0, 16) : null);

export async function saveAvatar(user, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  if (!buf.length) throw new HttpError(400, 'No image was sent', 'invalid_request');
  if (buf.length > AVATAR_MAX_BYTES) throw new HttpError(413, 'The photo must be at most 2 MB', 'too_large');
  const type = imageType(buf);
  if (!type) throw new HttpError(400, 'The photo must be a JPEG, PNG or WebP image', 'invalid_image');

  await fs.mkdir(avatarDir(), { recursive: true });
  // Write next to it, then rename: a reader never sees half a file.
  const tmp = `${avatarPath(user)}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, avatarPath(user));
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  await query('UPDATE users SET avatar_sha = ?, avatar_type = ? WHERE id = ?', [sha, type, user.id]);
  return { ...user, avatar_sha: sha, avatar_type: type };
}

/** Sends the user's photo, or 404 when there is none. */
export async function sendAvatar(res, user) {
  if (!user.avatar_sha) throw new HttpError(404, 'No profile photo', 'not_found');
  let data;
  try {
    data = await fs.readFile(avatarPath(user));
  } catch {
    throw new HttpError(404, 'No profile photo', 'not_found'); // file lost (e.g. storage moved)
  }
  res.set('Cache-Control', 'private, max-age=86400');
  res.set('ETag', `"${user.avatar_sha}"`);
  res.type(user.avatar_type || 'image/jpeg').send(data);
}

export async function deleteAvatar(user) {
  await fs.rm(avatarPath(user), { force: true });
  await query('UPDATE users SET avatar_sha = NULL, avatar_type = NULL WHERE id = ?', [user.id]);
}
