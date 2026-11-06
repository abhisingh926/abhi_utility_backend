import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import express, { Router } from 'express';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { ah, HttpError } from '../http.js';
import { requireAuth } from '../middleware/auth.js';
import { deleteAllBackups, isSha256, photoPath, pruneBackups, usageFor, userDir } from '../services/backups.js';
import { entitlementFor } from '../services/entitlements.js';

/**
 * Backup of the app's diary + tasks.
 *
 * The app:
 *  1. POST /photos/check { hashes }           -> which photos the server doesn't have yet
 *  2. PUT  /photos/:sha256  (raw bytes)        -> uploads each missing photo once
 *  3. POST /                { payload, ... }   -> saves the snapshot (diary + tasks JSON)
 * Restore: GET / (list) -> GET /:id (snapshot) -> GET /photos/:sha256.
 *
 * The server never looks inside the payload or photos, so the app can encrypt
 * them on the phone first (encrypted: true).
 */
export const backupsRouter = Router();
backupsRouter.use(requireAuth);

const MB = 1024 * 1024;

backupsRouter.use(ah(async (req, res, next) => {
  if (config.backup.proOnly && !(await entitlementFor(req.user.id)).isPro) {
    throw new HttpError(402, 'Cloud backup is a Pro feature', 'pro_required');
  }
  next();
}));

/** GET /api/v1/backups -> backups (newest first, without the data) + storage used */
backupsRouter.get('/', ah(async (req, res) => {
  const rows = await query(
    `SELECT id, encrypted, size_bytes, meta, device, app_version, created_at,
            JSON_LENGTH(photo_hashes) AS photo_count
     FROM backups WHERE user_id = ? ORDER BY id DESC`,
    [req.user.id],
  );
  res.json({
    backups: rows.map((b) => ({
      id: b.id,
      createdAt: b.created_at,
      sizeBytes: b.size_bytes,
      encrypted: !!b.encrypted,
      photoCount: Number(b.photo_count ?? 0),
      meta: typeof b.meta === 'string' ? JSON.parse(b.meta) : b.meta,
      device: b.device,
      appVersion: b.app_version,
    })),
    usage: await usageFor(req.user.id),
    keep: config.backup.keep,
  });
}));

/** POST /api/v1/backups/photos/check { hashes: [sha256...] } -> { missing: [...] } */
backupsRouter.post('/photos/check', ah(async (req, res) => {
  const hashes = Array.isArray(req.body?.hashes) ? [...new Set(req.body.hashes)] : null;
  if (!hashes || hashes.length > 5000 || !hashes.every(isSha256)) {
    throw new HttpError(400, 'hashes must be a list of SHA-256 hex strings', 'invalid_request');
  }
  const have = new Set();
  for (let i = 0; i < hashes.length; i += 500) {
    const chunk = hashes.slice(i, i + 500);
    if (!chunk.length) continue;
    const rows = await query('SELECT sha256 FROM backup_photos WHERE user_id = ? AND sha256 IN (?)', [req.user.id, chunk]);
    rows.forEach((r) => have.add(r.sha256));
  }
  res.json({ missing: hashes.filter((h) => !have.has(h)) });
}));

/** PUT /api/v1/backups/photos/:sha256  body = the photo's raw bytes (any content type) */
backupsRouter.put(
  '/photos/:sha256',
  express.raw({ type: () => true, limit: `${config.backup.maxPhotoMb}mb` }),
  ah(async (req, res) => {
    const sha = req.params.sha256;
    if (!isSha256(sha)) throw new HttpError(400, 'Invalid photo id', 'invalid_request');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!body.length) throw new HttpError(400, 'Empty photo', 'invalid_request');
    if (crypto.createHash('sha256').update(body).digest('hex') !== sha) {
      throw new HttpError(400, 'Photo data does not match its id (upload damaged?)', 'hash_mismatch');
    }
    if (await one('SELECT 1 FROM backup_photos WHERE user_id = ? AND sha256 = ?', [req.user.id, sha])) {
      return res.json({ ok: true, stored: false }); // already there
    }
    const usage = await usageFor(req.user.id);
    if (usage.backupBytes + usage.photoBytes + body.length > usage.quotaBytes) {
      throw new HttpError(413, `Backup storage is full (${config.backup.quotaMb} MB)`, 'quota_exceeded');
    }
    await fs.mkdir(userDir(req.user), { recursive: true });
    await fs.writeFile(photoPath(req.user, sha), body);
    await query(
      'INSERT IGNORE INTO backup_photos (user_id, sha256, size_bytes, content_type) VALUES (?, ?, ?, ?)',
      [req.user.id, sha, body.length, String(req.get('content-type') || 'application/octet-stream').slice(0, 100)],
    );
    res.status(201).json({ ok: true, stored: true });
  }),
);

/** GET /api/v1/backups/photos/:sha256 -> the photo bytes */
backupsRouter.get('/photos/:sha256', ah(async (req, res) => {
  const sha = req.params.sha256;
  if (!isSha256(sha)) throw new HttpError(400, 'Invalid photo id', 'invalid_request');
  const row = await one('SELECT content_type FROM backup_photos WHERE user_id = ? AND sha256 = ?', [req.user.id, sha]);
  if (!row) throw new HttpError(404, 'Photo not found', 'not_found');
  res.type(row.content_type);
  res.sendFile(photoPath(req.user, sha));
}));

/**
 * POST /api/v1/backups
 * { payload: string (JSON or encrypted text), encrypted?: bool, photoHashes?: [...],
 *   meta?: { tasks, entries, ... }, device?, appVersion? }
 */
backupsRouter.post('/', ah(async (req, res) => {
  const { payload, encrypted = false, photoHashes = [], meta = null, device = null, appVersion = null } = req.body ?? {};
  if (typeof payload !== 'string' || !payload.length) {
    throw new HttpError(400, 'payload (string) is required', 'invalid_request');
  }
  const size = Buffer.byteLength(payload, 'utf8');
  if (size > config.backup.maxPayloadMb * MB) {
    throw new HttpError(413, `Backup is larger than ${config.backup.maxPayloadMb} MB`, 'payload_too_large');
  }
  const hashes = [...new Set(photoHashes)];
  if (!Array.isArray(photoHashes) || hashes.length > 5000 || !hashes.every(isSha256)) {
    throw new HttpError(400, 'photoHashes must be a list of SHA-256 hex strings', 'invalid_request');
  }
  // Every photo the backup needs must be uploaded first.
  if (hashes.length) {
    const have = new Set();
    for (let i = 0; i < hashes.length; i += 500) {
      const rows = await query('SELECT sha256 FROM backup_photos WHERE user_id = ? AND sha256 IN (?)', [req.user.id, hashes.slice(i, i + 500)]);
      rows.forEach((r) => have.add(r.sha256));
    }
    const missing = hashes.filter((h) => !have.has(h));
    if (missing.length) {
      return res.status(409).json({ error: { code: 'photos_missing', message: 'Upload these photos first', missing } });
    }
  }
  const usage = await usageFor(req.user.id);
  if (usage.backupBytes + usage.photoBytes + size > usage.quotaBytes) {
    throw new HttpError(413, `Backup storage is full (${config.backup.quotaMb} MB)`, 'quota_exceeded');
  }
  if (meta !== null && (typeof meta !== 'object' || JSON.stringify(meta).length > 2000)) {
    throw new HttpError(400, 'meta must be a small object', 'invalid_request');
  }

  const result = await query(
    `INSERT INTO backups (user_id, payload, encrypted, size_bytes, photo_hashes, meta, device, app_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id,
      payload,
      encrypted ? 1 : 0,
      size,
      JSON.stringify(hashes),
      meta ? JSON.stringify(meta) : null,
      device ? String(device).slice(0, 120) : null,
      appVersion ? String(appVersion).slice(0, 40) : null,
    ],
  );
  await pruneBackups(req.user);
  res.status(201).json({ id: result.insertId, sizeBytes: size, usage: await usageFor(req.user.id) });
}));

/** GET /api/v1/backups/latest -> the newest backup with its data (for restore) */
backupsRouter.get('/latest', ah(async (req, res) => {
  const b = await one('SELECT * FROM backups WHERE user_id = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
  if (!b) throw new HttpError(404, 'No backup yet', 'not_found');
  res.json(fullBackup(b));
}));

/** GET /api/v1/backups/:id -> one backup with its data */
backupsRouter.get('/:id', ah(async (req, res) => {
  const b = await one('SELECT * FROM backups WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
  if (!b) throw new HttpError(404, 'Backup not found', 'not_found');
  res.json(fullBackup(b));
}));

/** DELETE /api/v1/backups/:id */
backupsRouter.delete('/:id', ah(async (req, res) => {
  const r = await query('DELETE FROM backups WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
  if (!r.affectedRows) throw new HttpError(404, 'Backup not found', 'not_found');
  await pruneBackups(req.user);
  res.json({ ok: true, usage: await usageFor(req.user.id) });
}));

/** DELETE /api/v1/backups -> deletes every backup and photo of the user */
backupsRouter.delete('/', ah(async (req, res) => {
  await deleteAllBackups(req.user);
  res.json({ ok: true });
}));

function fullBackup(b) {
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  return {
    id: b.id,
    createdAt: b.created_at,
    encrypted: !!b.encrypted,
    sizeBytes: b.size_bytes,
    photoHashes: parse(b.photo_hashes) ?? [],
    meta: parse(b.meta),
    device: b.device,
    appVersion: b.app_version,
    payload: b.payload,
  };
}
