import { HttpError } from '../http.js';
import { query } from '../db.js';

/**
 * App settings changed from the admin panel (/admin → Settings), stored in the
 * `settings` table. Rows are created on start (migrate.js): from the old .env
 * variable when it is set, so a running server keeps its values, else from
 * `default`. After that the database is the only source; the .env variables
 * are no longer read.
 *
 * Read with `await getSettings()` (cached for CACHE_MS; a change made in the
 * admin panel applies at once in this process, within CACHE_MS in others).
 */
export const SETTINGS = [
  {
    key: 'trialDays', env: 'TRIAL_DAYS', default: 30, min: 0, max: 365, unit: 'days',
    group: 'Free trial', label: 'Free trial length',
    help: 'Days of Pro a new account gets once its email is verified (one trial per email). 0 turns the trial off. Applies to new trials only.',
  },
  {
    key: 'referralDays', env: 'REFERRAL_DAYS', default: 30, min: 0, max: 365, unit: 'days',
    group: 'Referrals', label: 'Reward for inviting',
    help: 'Extra days of Pro for the person whose code a new user registers with.',
  },
  {
    key: 'referralFriendDays', env: 'REFERRAL_FRIEND_DAYS', default: 10, min: 0, max: 365, unit: 'days',
    group: 'Referrals', label: 'Bonus for the new user',
    help: 'Extra days for the new user who registers with a code, on top of the free trial. 0 = trial only.',
  },
  {
    key: 'referralMaxPerYear', env: 'REFERRAL_MAX_PER_YEAR', default: 12, min: 0, max: 1000, unit: 'rewards',
    group: 'Referrals', label: 'Rewards per person per year',
    help: 'Most rewards one person can earn in 365 days. Invites past this are recorded but not rewarded.',
  },
  {
    key: 'referralApplyDays', env: 'REFERRAL_APPLY_DAYS', default: 7, min: 0, max: 365, unit: 'days',
    group: 'Referrals', label: 'Time to enter a code',
    help: "How long after registering a new user can still enter a friend's code.",
  },
  {
    key: 'sosLinkDays', env: 'SOS_LINK_DAYS', default: 30, min: 1, max: 365, unit: 'days',
    group: 'SOS', label: 'Keep SOS links and videos',
    help: 'After this, SOS links stop working and their videos are deleted. Also shown on the privacy policy. Lowering it deletes older alerts on the next SOS.',
  },
  {
    key: 'sosVideoMaxMb', env: 'SOS_VIDEO_MAX_MB', default: 60, min: 1, max: 500, unit: 'MB',
    group: 'SOS', label: 'Largest SOS video',
    help: 'Uploads bigger than this are refused. The app records 30 s; keep room for high-resolution phones.',
  },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
const CACHE_MS = 30_000;
let cache = null;
let cachedAt = 0;

/** Value from the old .env variable if valid, else the default (first start only). */
function initialValue(def) {
  const raw = process.env[def.env];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n >= def.min && n <= def.max ? n : def.default;
}

/** Creates missing rows. Existing rows are never changed. */
export async function seedSettings() {
  for (const def of SETTINGS) {
    await query('INSERT IGNORE INTO settings (name, value) VALUES (?, ?)', [def.key, String(initialValue(def))]);
  }
  cache = null;
}

/** { trialDays: 30, referralDays: 30, … } — every key, defaults for missing/invalid rows. */
export async function getSettings() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const rows = await query('SELECT name, value FROM settings');
  const stored = new Map(rows.map((r) => [r.name, Number(r.value)]));
  const values = {};
  for (const def of SETTINGS) {
    const n = stored.get(def.key);
    values[def.key] = Number.isInteger(n) && n >= def.min && n <= def.max ? n : def.default;
  }
  cache = Object.freeze(values);
  cachedAt = Date.now();
  return cache;
}

/** For the admin panel: definitions, current values and who changed each last. */
export async function settingsForAdmin() {
  const values = await getSettings();
  const rows = await query(
    `SELECT s.name, s.updated_at, u.email AS updated_by_email
     FROM settings s LEFT JOIN users u ON u.id = s.updated_by`,
  );
  const meta = new Map(rows.map((r) => [r.name, r]));
  return SETTINGS.map((def) => ({
    key: def.key,
    group: def.group,
    label: def.label,
    help: def.help,
    unit: def.unit,
    min: def.min,
    max: def.max,
    default: def.default,
    value: values[def.key],
    updatedAt: meta.get(def.key)?.updated_at ?? null,
    updatedBy: meta.get(def.key)?.updated_by_email ?? null,
  }));
}

/** Checks `{ key: value }` from the admin panel; returns only the values that change. */
export function validateChanges(input, current) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Send the settings as an object', 'invalid_request');
  }
  const changes = {};
  for (const [key, raw] of Object.entries(input)) {
    const def = BY_KEY.get(key);
    if (!def) throw new HttpError(400, `Unknown setting: ${key}`, 'invalid_request');
    const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
    if (!Number.isInteger(n) || n < def.min || n > def.max) {
      throw new HttpError(400, `${def.label} must be a whole number from ${def.min} to ${def.max}`, 'invalid_request');
    }
    if (n !== current[key]) changes[key] = { from: current[key], to: n };
  }
  return changes;
}

/** Saves validated changes (from validateChanges) and clears the cache. */
export async function saveSettings(changes, adminId) {
  for (const [key, { to }] of Object.entries(changes)) {
    await query(
      `INSERT INTO settings (name, value, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)`,
      [key, String(to), adminId],
    );
  }
  cache = null;
}
