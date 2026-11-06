import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { one, query } from '../db.js';
import { HttpError } from '../http.js';

const BCRYPT_ROUNDS = 11;

export const findById = (id) => one('SELECT * FROM users WHERE id = ?', [id]);
export const findByEmail = (email) => one('SELECT * FROM users WHERE email = ?', [email]);
export const findByUuid = (uuid) => one('SELECT * FROM users WHERE uuid = ?', [uuid]);

export const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);
export const checkPassword = (password, hash) => bcrypt.compare(password, hash);

// Compared against when the email doesn't exist, so login takes the same time
// either way (doesn't reveal which emails are registered).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);
export const dummyCheck = (password) => bcrypt.compare(password, DUMMY_HASH);

export async function createUser({ email, password, name = null, role = 'user', createdByAdmin = false }) {
  if (await findByEmail(email)) {
    throw new HttpError(409, 'An account with this email already exists', 'email_taken');
  }
  const result = await query(
    'INSERT INTO users (uuid, email, password_hash, name, role, created_by_admin) VALUES (?, ?, ?, ?, ?, ?)',
    [crypto.randomUUID(), email, await hashPassword(password), name, role, createdByAdmin ? 1 : 0],
  );
  return findById(result.insertId);
}

/** What the app / admin panel may see about a user. */
export function publicUser(u) {
  return {
    id: u.id,
    // Passed to Google Play (obfuscatedAccountId) and Apple (appAccountToken) at
    // purchase time, so store notifications can be matched to this account.
    accountToken: u.uuid,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}
