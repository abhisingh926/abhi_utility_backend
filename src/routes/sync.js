import { Router } from 'express';
import { pool, query } from '../db.js';
import { ah, HttpError } from '../http.js';
import { requireAuth } from '../middleware/auth.js';
import { isSha256 } from '../services/backups.js';

/**
 * Live copy of the user's tasks, diary entries and reel stats, so a website
 * (or a second phone) can show them. The phone is the source: it sends what
 * changed since its last sync.
 *
 * POST /api/v1/sync
 * {
 *   tasks:   [{ day: "2026-11-10", tasks: [{ id, text, done, important, time? }] }],
 *            // a day's tasks are replaced as a whole; [] clears the day
 *   journal: [{ id, date: "2026-11-10T21:00:00.000", text, mood?, photos: [sha256] }
 *             | { id, date, encryptedData: "<sealed text+mood>", photos: [sha256] }],
 *   journalDeleted: [id],
 *   reels:   [{ day: "2026-11-10", apps: { "com.instagram.android": { reels, seconds } } }]
 *            // a day's apps are replaced as a whole
 * }
 *
 * Diary photos are uploaded first through /api/v1/backups/photos (shared store,
 * each photo once). Encrypted entries: encryptedData is the JSON envelope
 * { v: 2, enc: "aes-256-gcm", kdf: "pbkdf2-sha256", iter, salt, data } where
 * data = base64(12-byte nonce || AES-GCM ciphertext+tag) of {"text","mood"}; the
 * key is PBKDF2-SHA256(diary password, salt, iter). The server can't read it.
 *
 * Read back: GET /tasks, /journal, /reels (?from=&to= yyyy-MM-dd), GET / (summary).
 */
export const syncRouter = Router();
syncRouter.use(requireAuth);

const MAX_ITEMS = 500;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,40}$/;

const bad = (message) => new HttpError(400, message, 'invalid_request');

function list(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw bad(`${field} must be a list of at most ${MAX_ITEMS}`);
  return value;
}

function day(value, field = 'day') {
  if (typeof value !== 'string' || !DAY_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw bad(`${field} must be yyyy-MM-dd`);
  }
  return value;
}

function id(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw bad(`${field} is not a valid id`);
  return value;
}

function count(value, field) {
  const n = Number(value ?? 0);
  if (!Number.isInteger(n) || n < 0 || n > 10_000_000) throw bad(`${field} must be a whole number`);
  return n;
}

/** "2026-11-10T21:00:00.000" (phone's local time) -> "2026-11-10 21:00:00". */
function localDateTime(value) {
  const m = typeof value === 'string' ? value.match(LOCAL_TIME_RE) : null;
  if (!m || Number.isNaN(Date.parse(`${m[1]}T${m[2]}Z`))) throw bad('journal date must be an ISO date-time');
  return `${m[1]} ${m[2]}`;
}

function parseTasks(raw) {
  return list(raw, 'tasks').map((d) => {
    const tasks = list(d?.tasks, 'tasks[].tasks').map((t, i) => {
      const text = typeof t?.text === 'string' ? t.text.slice(0, 1000) : null;
      if (text === null) throw bad('task text is required');
      const time = t.time ?? null;
      if (time !== null && !(typeof time === 'string' && /^\d{2}:\d{2}$/.test(time))) throw bad('task time must be HH:mm');
      return { id: id(t.id, 'task id'), position: i, text, done: !!t.done, important: !!t.important, time };
    });
    return { day: day(d?.day), tasks };
  });
}

function parseJournal(raw) {
  return list(raw, 'journal').map((e) => {
    const photos = list(e?.photos, 'photos');
    if (photos.length > 100 || !photos.every(isSha256)) throw bad('photos must be SHA-256 hashes');
    const base = { id: id(e?.id, 'entry id'), entryAt: localDateTime(e?.date), photos };
    if (e.encryptedData !== undefined) {
      if (typeof e.encryptedData !== 'string' || !e.encryptedData || e.encryptedData.length > 2_000_000) {
        throw bad('encryptedData must be a string');
      }
      return { ...base, encrypted: true, data: e.encryptedData, text: null, mood: null };
    }
    if (typeof e.text !== 'string' || e.text.length > 1_000_000) throw bad('entry text is required');
    const mood = e.mood ?? null;
    if (mood !== null && (typeof mood !== 'string' || mood.length > 16)) throw bad('mood is too long');
    return { ...base, encrypted: false, data: null, text: e.text, mood };
  });
}

function parseReels(raw) {
  return list(raw, 'reels').map((d) => {
    const apps = d?.apps && typeof d.apps === 'object' && !Array.isArray(d.apps) ? Object.entries(d.apps) : null;
    if (!apps || apps.length > 100) throw bad('reels[].apps must be an object');
    return {
      day: day(d.day),
      apps: apps.map(([app, v]) => {
        if (!/^[A-Za-z0-9_.]{1,100}$/.test(app)) throw bad('app must be a package name');
        return { app, reels: count(v?.reels, 'reels'), seconds: count(v?.seconds, 'seconds') };
      }),
    };
  });
}

/** POST /api/v1/sync -> saves what the phone sent. */
syncRouter.post('/', ah(async (req, res) => {
  const body = req.body ?? {};
  const tasks = parseTasks(body.tasks);
  const journal = parseJournal(body.journal);
  const journalDeleted = list(body.journalDeleted, 'journalDeleted').map((x) => id(x, 'journalDeleted id'));
  const reels = parseReels(body.reels);
  const userId = req.user.id;

  // Diary photos must already be uploaded (same rule as backups).
  const hashes = [...new Set(journal.flatMap((e) => e.photos))];
  if (hashes.length) {
    const have = new Set();
    for (let i = 0; i < hashes.length; i += 500) {
      const rows = await query('SELECT sha256 FROM backup_photos WHERE user_id = ? AND sha256 IN (?)', [userId, hashes.slice(i, i + 500)]);
      rows.forEach((r) => have.add(r.sha256));
    }
    const missing = hashes.filter((h) => !have.has(h));
    if (missing.length) {
      return res.status(409).json({ error: { code: 'photos_missing', message: 'Upload these photos first', missing } });
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const d of tasks) {
      await conn.query('DELETE FROM user_tasks WHERE user_id = ? AND day = ?', [userId, d.day]);
      if (d.tasks.length) {
        await conn.query(
          'INSERT INTO user_tasks (user_id, day, task_id, position, text, done, important, time, updated_at) VALUES ?',
          [d.tasks.map((t) => [userId, d.day, t.id, t.position, t.text, t.done, t.important, t.time, new Date()])],
        );
      }
    }
    for (const e of journal) {
      await conn.query(
        `INSERT INTO journal_entries (user_id, entry_id, entry_at, encrypted, text, mood, encrypted_data, photo_hashes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE entry_at = VALUES(entry_at), encrypted = VALUES(encrypted), text = VALUES(text),
           mood = VALUES(mood), encrypted_data = VALUES(encrypted_data), photo_hashes = VALUES(photo_hashes),
           updated_at = VALUES(updated_at)`,
        [userId, e.id, e.entryAt, e.encrypted, e.text, e.mood, e.data, JSON.stringify(e.photos)],
      );
    }
    if (journalDeleted.length) {
      await conn.query('DELETE FROM journal_entries WHERE user_id = ? AND entry_id IN (?)', [userId, journalDeleted]);
    }
    for (const d of reels) {
      await conn.query('DELETE FROM reel_stats WHERE user_id = ? AND day = ?', [userId, d.day]);
      const rows = d.apps.filter((a) => a.reels || a.seconds);
      if (rows.length) {
        await conn.query(
          'INSERT INTO reel_stats (user_id, day, app, reels, seconds, updated_at) VALUES ?',
          [rows.map((a) => [userId, d.day, a.app, a.reels, a.seconds, new Date()])],
        );
      }
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
  res.json({
    ok: true,
    saved: { taskDays: tasks.length, entries: journal.length, entriesDeleted: journalDeleted.length, reelDays: reels.length },
  });
}));

/** ?from=&to= (yyyy-MM-dd, both optional) -> SQL condition on a DATE column. */
function range(req, column) {
  const where = [];
  const params = [];
  if (req.query.from) { where.push(`${column} >= ?`); params.push(day(String(req.query.from), 'from')); }
  if (req.query.to) { where.push(`${column} <= ?`); params.push(day(String(req.query.to), 'to')); }
  return { sql: where.length ? ` AND ${where.join(' AND ')}` : '', params };
}

const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** GET /api/v1/sync -> what is stored (counts + last change). */
syncRouter.get('/', ah(async (req, res) => {
  const [row] = await query(
    `SELECT
       (SELECT COUNT(*) FROM user_tasks WHERE user_id = ?) AS tasks,
       (SELECT MAX(updated_at) FROM user_tasks WHERE user_id = ?) AS tasksUpdatedAt,
       (SELECT COUNT(*) FROM journal_entries WHERE user_id = ?) AS entries,
       (SELECT MAX(updated_at) FROM journal_entries WHERE user_id = ?) AS entriesUpdatedAt,
       (SELECT COUNT(DISTINCT day) FROM reel_stats WHERE user_id = ?) AS reelDays,
       (SELECT MAX(updated_at) FROM reel_stats WHERE user_id = ?) AS reelsUpdatedAt`,
    Array(6).fill(req.user.id),
  );
  res.json({
    tasks: Number(row.tasks),
    entries: Number(row.entries),
    reelDays: Number(row.reelDays),
    updatedAt: { tasks: row.tasksUpdatedAt, entries: row.entriesUpdatedAt, reels: row.reelsUpdatedAt },
  });
}));

/** GET /api/v1/sync/tasks -> { days: [{ day, tasks: [...] }] } (oldest first) */
syncRouter.get('/tasks', ah(async (req, res) => {
  const r = range(req, 'day');
  const rows = await query(
    `SELECT day, task_id, text, done, important, time FROM user_tasks WHERE user_id = ?${r.sql}
     ORDER BY day, position`,
    [req.user.id, ...r.params],
  );
  const days = new Map();
  for (const t of rows) {
    const k = ymd(t.day);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push({ id: t.task_id, text: t.text, done: !!t.done, important: !!t.important, time: t.time });
  }
  res.json({ days: [...days].map(([d, tasks]) => ({ day: d, tasks })) });
}));

/** GET /api/v1/sync/journal -> { entries } (newest first; photos via /api/v1/backups/photos/:sha256) */
syncRouter.get('/journal', ah(async (req, res) => {
  const r = range(req, 'DATE(entry_at)');
  const rows = await query(
    `SELECT entry_id, DATE_FORMAT(entry_at, '%Y-%m-%dT%H:%i:%s') AS entry_at, encrypted, text, mood,
            encrypted_data, photo_hashes, updated_at
     FROM journal_entries WHERE user_id = ?${r.sql} ORDER BY entry_at DESC`,
    [req.user.id, ...r.params],
  );
  res.json({
    entries: rows.map((e) => ({
      id: e.entry_id,
      date: e.entry_at,
      encrypted: !!e.encrypted,
      ...(e.encrypted ? { encryptedData: e.encrypted_data } : { text: e.text, mood: e.mood }),
      photos: (typeof e.photo_hashes === 'string' ? JSON.parse(e.photo_hashes) : e.photo_hashes) ?? [],
      updatedAt: e.updated_at,
    })),
  });
}));

/** GET /api/v1/sync/reels -> { days: [{ day, apps: { pkg: { reels, seconds } } }] } (oldest first) */
syncRouter.get('/reels', ah(async (req, res) => {
  const r = range(req, 'day');
  const rows = await query(
    `SELECT day, app, reels, seconds FROM reel_stats WHERE user_id = ?${r.sql} ORDER BY day, app`,
    [req.user.id, ...r.params],
  );
  const days = new Map();
  for (const x of rows) {
    const k = ymd(x.day);
    if (!days.has(k)) days.set(k, {});
    days.get(k)[x.app] = { reels: x.reels, seconds: x.seconds };
  }
  res.json({ days: [...days].map(([d, apps]) => ({ day: d, apps })) });
}));
