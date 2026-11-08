import { config } from '../config.js';
import { HttpError } from '../http.js';
import { one, query } from '../db.js';
import { PRO_SQL } from './entitlements.js';
import * as v from '../validate.js';

/**
 * Subscription plans shown in the app, managed in the admin panel (/admin → Plans).
 *
 * The amount the customer pays is set in Play Console / App Store Connect; the app shows
 * the store's price on the buy button. The price stored here is the admin's copy of it,
 * used for revenue estimates; keep the two the same.
 */

export const PERIODS = ['week', 'month', 'quarter', 'half_year', 'year'];

/** Length of each billing period in months (for "per month" revenue). */
const PERIOD_MONTHS = { week: 12 / 52, month: 1, quarter: 3, half_year: 6, year: 12 };

/** Creates the two default plans (from PRODUCT_MONTHLY / PRODUCT_YEARLY) on an empty table. */
export async function seedPlans() {
  const { n } = await one('SELECT COUNT(*) AS n FROM plans');
  if (Number(n) > 0) return;
  await query(
    `INSERT IGNORE INTO plans (product_id, name, description, badge, billing_period, sort_order) VALUES
     (?, 'Monthly', 'Cancel any time', NULL, 'month', 1),
     (?, 'Yearly', 'Pay once a year', 'Best value', 'year', 2)`,
    [config.products.monthly, config.products.yearly],
  );
}

const toPlan = (r) => ({
  id: r.id,
  productId: r.product_id,
  name: r.name,
  description: r.description,
  badge: r.badge,
  period: r.billing_period,
  price: r.price === null ? null : Number(r.price),
  currency: r.currency,
  active: !!r.active,
  sortOrder: r.sort_order,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const ORDER = 'ORDER BY sort_order, id';

/** Plans the app offers (active only), in display order. */
export async function activePlans() {
  return (await query(`SELECT * FROM plans WHERE active = 1 ${ORDER}`)).map(toPlan);
}

/** Price per month, or null when no price is set. */
export function monthlyValue(plan) {
  return plan.price === null ? null : plan.price / PERIOD_MONTHS[plan.period];
}

/**
 * Every plan with its subscribers (paid store subscriptions only, not trials or admin
 * grants) and estimated revenue, plus totals per currency.
 */
export async function plansWithStats() {
  const plans = (await query(`SELECT * FROM plans ${ORDER}`)).map(toPlan);
  const counts = await query(
    `SELECT product_id,
            SUM(${PRO_SQL}) AS active_now,
            SUM(auto_renew = 1 AND ${PRO_SQL}) AS renewing,
            COUNT(*) AS ever
     FROM subscriptions WHERE source IN ('google','apple') GROUP BY product_id`,
  );
  const byProduct = new Map(counts.map((c) => [c.product_id, c]));
  const totals = {}; // currency -> { monthly, yearly }

  const rows = plans.map((p) => {
    const c = byProduct.get(p.productId);
    const subscribers = { active: Number(c?.active_now ?? 0), renewing: Number(c?.renewing ?? 0), ever: Number(c?.ever ?? 0) };
    const perMonth = monthlyValue(p);
    const revenuePerMonth = perMonth === null ? null : round2(perMonth * subscribers.active);
    if (revenuePerMonth !== null) {
      const t = (totals[p.currency] ??= { monthly: 0, yearly: 0 });
      t.monthly = round2(t.monthly + revenuePerMonth);
      t.yearly = round2(t.monthly * 12);
    }
    return { ...p, subscribers, revenuePerMonth };
  });

  // Store subscriptions whose product isn't in the plan list (e.g. a plan was deleted).
  const known = new Set(plans.map((p) => p.productId));
  const unknownProducts = counts
    .filter((c) => !known.has(c.product_id))
    .map((c) => ({ productId: c.product_id, active: Number(c.active_now), ever: Number(c.ever) }));

  return { plans: rows, totals, unknownProducts };
}

const round2 = (n) => Math.round(n * 100) / 100;

async function findPlan(id) {
  const row = await one('SELECT * FROM plans WHERE id = ?', [Number(id)]);
  if (!row) throw new HttpError(404, 'Plan not found', 'not_found');
  return toPlan(row);
}

// ---- Validation -------------------------------------------------------------------

function productId(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  // Google Play: lowercase letters, numbers, "_" and "."; starts with a letter or number.
  if (!/^[a-z0-9][a-z0-9._]{0,149}$/.test(s)) {
    throw new HttpError(
      400,
      'Product ID must be the same as in Play Console: lowercase letters, numbers, "_" and "." (e.g. abhi_pro_monthly)',
      'invalid_request',
    );
  }
  return s;
}

function text(value, field, max, { required = false } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    if (required) throw new HttpError(400, `${field} is required`, 'invalid_request');
    return null;
  }
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new HttpError(400, `${field} must be at most ${max} characters`, 'invalid_request');
  }
  return value.trim();
}

function price(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000 || Math.round(n * 100) !== n * 100) {
    throw new HttpError(400, 'Amount must be a number like 99 or 99.50', 'invalid_request');
  }
  return n;
}

function currency(value) {
  const s = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(s)) throw new HttpError(400, 'Currency must be a 3-letter code like INR or USD', 'invalid_request');
  return s;
}

/** Reads the editable fields present in [body] (all of them when [creating]). */
function fields(body, creating) {
  const b = body ?? {};
  const has = (k) => creating || b[k] !== undefined;
  const f = {};
  if (has('name')) f.name = text(b.name, 'Name', 80, { required: true });
  if (has('description')) f.description = text(b.description, 'Description', 255);
  if (has('badge')) f.badge = text(b.badge, 'Label', 40);
  if (has('period')) f.billing_period = v.oneOf(b.period ?? 'month', PERIODS, 'period');
  if (has('price')) f.price = price(b.price);
  if (has('currency')) f.currency = currency(b.currency ?? 'INR');
  if (has('active')) f.active = b.active === undefined ? 1 : b.active === true ? 1 : b.active === false ? 0 : bad('active');
  if (has('sortOrder')) f.sort_order = b.sortOrder === undefined ? 0 : v.intInRange(b.sortOrder, -1000, 1000, 'sortOrder');
  return f;
}

function bad(field) {
  throw new HttpError(400, `${field} must be true or false`, 'invalid_request');
}

// ---- Changes ----------------------------------------------------------------------

export async function createPlan(body) {
  const f = { product_id: productId(body?.productId), ...fields(body, true) };
  if (await one('SELECT 1 FROM plans WHERE product_id = ?', [f.product_id])) {
    throw new HttpError(409, 'A plan with this product ID already exists', 'plan_exists');
  }
  const cols = Object.keys(f);
  const res = await query(
    `INSERT INTO plans (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    cols.map((c) => f[c]),
  );
  return findPlan(res.insertId);
}

/** Updates a plan. The product ID can't change: subscriptions are linked to it. */
export async function updatePlan(id, body) {
  const before = await findPlan(id);
  if (body?.productId !== undefined && body.productId !== before.productId) {
    throw new HttpError(400, "The product ID can't be changed. Create a new plan and hide this one.", 'product_id_locked');
  }
  const f = fields(body, false);
  const cols = Object.keys(f);
  if (!cols.length) throw new HttpError(400, 'Nothing to change', 'invalid_request');
  await query(`UPDATE plans SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => f[c]), before.id]);
  return { before, after: await findPlan(before.id) };
}

/** Deletes a plan nobody has bought. Plans with subscriptions can only be hidden. */
export async function deletePlan(id) {
  const plan = await findPlan(id);
  const used = await one("SELECT COUNT(*) AS n FROM subscriptions WHERE source IN ('google','apple') AND product_id = ?", [
    plan.productId,
  ]);
  if (Number(used.n) > 0) {
    throw new HttpError(409, `${used.n} subscription(s) use this plan. Hide it instead of deleting it.`, 'plan_in_use');
  }
  await query('DELETE FROM plans WHERE id = ?', [plan.id]);
  return plan;
}
