import { HttpError } from '../http.js';
import { verifyAccess } from '../services/tokens.js';
import { findById } from '../services/users.js';

/**
 * Requires "Authorization: Bearer <accessToken>". Loads the user from the
 * database on every request, so disabling a user or removing admin rights
 * takes effect immediately.
 */
export async function requireAuth(req, res, next) {
  try {
    const m = (req.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!m) throw new HttpError(401, 'Please log in', 'unauthorized');
    let payload;
    try {
      payload = verifyAccess(m[1]);
    } catch {
      throw new HttpError(401, 'Session expired', 'token_expired');
    }
    const user = await findById(Number(payload.sub));
    if (!user) throw new HttpError(401, 'Account not found', 'unauthorized');
    if (user.status !== 'active') throw new HttpError(403, 'This account has been disabled', 'account_disabled');
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role !== 'admin') return next(new HttpError(403, 'Admins only', 'forbidden'));
    next();
  });
}
