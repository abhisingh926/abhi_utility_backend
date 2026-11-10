import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { config } from './config.js';
import { HttpError } from './http.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { backupsRouter } from './routes/backups.js';
import { meRouter } from './routes/me.js';
import { plansRouter, purchasesRouter } from './routes/purchases.js';
import { sosRouter, sosVideo } from './routes/sos.js';
import { syncRouter } from './routes/sync.js';
import { webhooksRouter } from './routes/webhooks.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // Hostinger runs the app behind a proxy (real client IPs for rate limits)
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'] }, // blob: profile photos in /admin
      },
    }),
  );
  // Backups may be larger than other requests; this parser must come first.
  app.use('/api/v1/backups', express.json({ limit: `${config.backup.maxPayloadMb + 1}mb` }));
  // Synced diary text can be long; the app sends it in batches below this size.
  app.use('/api/v1/sync', express.json({ limit: '5mb' }));
  app.use(express.json({ limit: '1mb' }));

  // Slow down password guessing and mass sign-ups.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' } },
  });

  // SOS uploads come from a key, not a login: limit them too.
  const sosLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 40,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many SOS requests. Try again in a few minutes.' } },
  });

  app.get('/api/health', (req, res) => res.json({ ok: true, env: config.env, time: new Date().toISOString() }));

  app.use('/api/v1/auth/login', authLimiter);
  app.use('/api/v1/auth/register', authLimiter);
  app.use('/api/v1/auth/forgot-password', authLimiter);
  app.use('/api/v1/auth/reset-password', authLimiter);
  app.use('/api/v1/auth/verify-email', authLimiter); // also /verify-email/send
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/me', meRouter);
  app.use('/api/v1/plans', plansRouter);
  app.use('/api/v1/purchases', purchasesRouter);
  app.use('/api/v1/backups', backupsRouter);
  app.use('/api/v1/sync', syncRouter);
  app.use('/api/v1/sos/alerts', sosLimiter);
  app.use('/api/v1/sos', sosRouter);
  app.use('/api/v1/admin', adminRouter);
  app.use('/webhooks', webhooksRouter);

  // Admin panel and public pages.
  app.use('/admin', express.static(path.join(publicDir, 'admin')));
  app.get('/delete-account', (req, res) => res.sendFile(path.join(publicDir, 'delete-account.html')));
  app.get('/reset-password', (req, res) => res.sendFile(path.join(publicDir, 'reset-password.html')));
  // SOS link sent by SMS to the contacts: location + video, no login.
  app.get('/sos/:token', (req, res) => {
    res.set('X-Robots-Tag', 'noindex');
    res.sendFile(path.join(publicDir, 'sos.html'));
  });
  app.get('/sos/:token/video', sosVideo);
  app.use('/static', express.static(path.join(publicDir, 'static')));
  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Not found', 'not_found')));

  // Errors -> { error: { code, message } }
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'too_large', message: 'The upload is too large' } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong. Please try again.' } });
  });

  return app;
}
