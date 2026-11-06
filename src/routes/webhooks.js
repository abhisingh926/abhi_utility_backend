import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { ah, HttpError } from '../http.js';
import { handleAppleNotification } from '../services/apple.js';
import { logStoreEvent } from '../services/entitlements.js';
import { handleGoogleNotification } from '../services/google.js';

export const webhooksRouter = Router();

function sameSecret(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * POST /webhooks/google?token=SECRET
 * Google Play real-time developer notifications via a Cloud Pub/Sub push
 * subscription. A non-2xx answer makes Pub/Sub retry later.
 */
webhooksRouter.post('/google', ah(async (req, res) => {
  if (!config.google.rtdnToken || !sameSecret(req.query.token, config.google.rtdnToken)) {
    throw new HttpError(403, 'Forbidden', 'forbidden');
  }
  try {
    const result = await handleGoogleNotification(req.body);
    res.json({ ok: true, result });
  } catch (e) {
    await logStoreEvent({ source: 'google', eventType: 'ERROR', payload: req.body, ok: false, error: e.message }).catch(() => {});
    throw e;
  }
}));

/**
 * POST /webhooks/apple { signedPayload }
 * App Store Server Notifications V2 (signed by Apple; verified before use).
 */
webhooksRouter.post('/apple', ah(async (req, res) => {
  try {
    const result = await handleAppleNotification(req.body?.signedPayload);
    res.json({ ok: true, result });
  } catch (e) {
    await logStoreEvent({ source: 'apple', eventType: 'ERROR', ok: false, error: e.message }).catch(() => {});
    throw e;
  }
}));
