import fs from 'node:fs/promises';
import express, { Router } from 'express';
import { query } from '../db.js';
import { ah, HttpError } from '../http.js';
import { requireAuth } from '../middleware/auth.js';
import {
  alertUrl,
  createAlert,
  issueKey,
  liveAlert,
  looksLikeMp4,
  pruneExpiredAlerts,
  revokeKey,
  sosDir,
  userForKey,
  videoPath,
} from '../services/sos.js';
import { getSettings } from '../services/settings.js';

/**
 * SOS when no contact answers (see services/sos.js).
 *
 * Logged-in app:   POST   /key                      -> { key }  (DELETE /key revokes it)
 * Phone (SOS key): POST   /alerts { lat, lng, accuracy } -> { token, url }
 *                  PUT    /alerts/:token/video  (raw MP4 bytes)
 * Anyone with the link: GET /public/:token -> alert details (page: /sos/:token)
 */
export const sosRouter = Router();

async function requireSosKey(req, res, next) {
  try {
    const user = await userForKey(req.get('x-sos-key'));
    if (!user) throw new HttpError(401, 'Invalid SOS key', 'unauthorized');
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

sosRouter.post('/key', requireAuth, ah(async (req, res) => {
  res.status(201).json({ key: await issueKey(req.user.id) });
}));

sosRouter.delete('/key', requireAuth, ah(async (req, res) => {
  await revokeKey(req.user.id);
  res.json({ ok: true });
}));

const coord = (v, max) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max ? v : undefined);

sosRouter.post('/alerts', requireSosKey, ah(async (req, res) => {
  const { lat, lng, accuracy } = req.body ?? {};
  const la = coord(lat, 90);
  const ln = coord(lng, 180);
  if ((lat != null && la === undefined) || (lng != null && ln === undefined) || (la === undefined) !== (ln === undefined)) {
    throw new HttpError(400, 'lat and lng must be valid coordinates', 'invalid_request');
  }
  const acc = typeof accuracy === 'number' && accuracy >= 0 && accuracy < 1e6 ? accuracy : null;
  pruneExpiredAlerts().catch((e) => console.error('SOS prune failed', e));
  const token = await createAlert(req.user, { lat: la, lng: ln, accuracy: acc });
  res.status(201).json({ token, url: alertUrl(token) });
}));

sosRouter.put(
  '/alerts/:token/video',
  requireSosKey,
  // Size limit from /admin → Settings, read per upload.
  ah(async (req, res, next) => {
    const { sosVideoMaxMb } = await getSettings();
    express.raw({ type: () => true, limit: `${sosVideoMaxMb}mb` })(req, res, next);
  }),
  ah(async (req, res) => {
    const alert = await liveAlert(req.params.token);
    if (!alert || alert.user_id !== req.user.id) throw new HttpError(404, 'Alert not found', 'not_found');
    if (alert.video_bytes) throw new HttpError(409, 'This alert already has a video', 'conflict');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!looksLikeMp4(body)) throw new HttpError(400, 'The video must be an MP4 file', 'invalid_request');
    await fs.mkdir(sosDir(), { recursive: true });
    await fs.writeFile(videoPath(alert.token), body);
    await query('UPDATE sos_alerts SET video_bytes = ?, video_at = UTC_TIMESTAMP() WHERE id = ?', [body.length, alert.id]);
    res.status(201).json({ ok: true, url: alertUrl(alert.token) });
  }),
);

/** Details for the public page. No email or account data, only the display name. */
sosRouter.get('/public/:token', ah(async (req, res) => {
  const a = await liveAlert(req.params.token);
  if (!a) throw new HttpError(404, 'This SOS link does not exist or has expired', 'not_found');
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  const expires = new Date(new Date(a.created_at).getTime() + (await getSettings()).sosLinkDays * 86400_000);
  res.json({
    name: a.sender_name,
    createdAt: a.created_at,
    expiresAt: expires,
    location: a.lat == null ? null : { lat: Number(a.lat), lng: Number(a.lng), accuracy: a.accuracy_m },
    video: a.video_bytes ? { bytes: a.video_bytes, uploadedAt: a.video_at, url: `/sos/${a.token}/video` } : null,
  });
}));

/** GET /sos/:token/video (mounted on the app, not under /api). Supports range requests. */
export const sosVideo = ah(async (req, res) => {
  const a = await liveAlert(req.params.token);
  if (!a || !a.video_bytes) throw new HttpError(404, 'Video not found', 'not_found');
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex');
  res.type('video/mp4');
  res.sendFile(videoPath(a.token));
});
