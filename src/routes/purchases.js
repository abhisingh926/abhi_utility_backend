import { Router } from 'express';
import { config } from '../config.js';
import { ah } from '../http.js';
import { requireAuth } from '../middleware/auth.js';
import { syncApplePurchase } from '../services/apple.js';
import { entitlementFor } from '../services/entitlements.js';
import { syncGooglePurchase } from '../services/google.js';
import * as v from '../validate.js';

export const plansRouter = Router();

/** GET /api/v1/plans -> product IDs the app should offer (public). */
plansRouter.get('/', (req, res) => {
  res.json({
    products: [
      { id: config.products.monthly, period: 'month' },
      { id: config.products.yearly, period: 'year' },
    ],
  });
});

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
