import { Router } from 'express';
import { ah } from '../http.js';
import { requireAuth } from '../middleware/auth.js';
import { syncApplePurchase } from '../services/apple.js';
import { entitlementFor } from '../services/entitlements.js';
import { activePlans } from '../services/plans.js';
import { syncGooglePurchase } from '../services/google.js';
import * as v from '../validate.js';
import { getSettings } from '../services/settings.js';

export const plansRouter = Router();

/**
 * GET /api/v1/plans -> the plans the app offers (public), managed in /admin → Plans.
 * `id` is the store product ID; the app shows the store's own price on the buy button.
 */
plansRouter.get('/', ah(async (req, res) => {
  res.json({
    trialDays: (await getSettings()).trialDays, // free trial after registering (/admin → Settings)
    products: (await activePlans()).map((p) => ({
      id: p.productId,
      name: p.name,
      description: p.description,
      badge: p.badge,
      period: p.period,
      price: p.price,
      currency: p.currency,
    })),
  });
}));

export const purchasesRouter = Router();
purchasesRouter.use(requireAuth);

/**
 * POST /api/v1/purchases/google { purchaseToken }
 * Sent by the app right after a Google Play purchase (and on "Restore").
 */
purchasesRouter.post('/google', ah(async (req, res) => {
  const token = v.requiredString(req.body?.purchaseToken, 'purchaseToken', 512);
  await syncGooglePurchase(token, { requestingUser: req.user });
  res.json({ entitlement: await entitlementFor(req.user.id) });
}));

/**
 * POST /api/v1/purchases/apple { signedTransaction } or { transactionId }
 * Sent by the app after an App Store purchase (and on "Restore").
 */
purchasesRouter.post('/apple', ah(async (req, res) => {
  await syncApplePurchase(
    { signedTransaction: req.body?.signedTransaction, transactionId: req.body?.transactionId },
    { requestingUser: req.user },
  );
  res.json({ entitlement: await entitlementFor(req.user.id) });
}));
