import { HttpError } from './http.js';

export function email(value) {
  const e = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!e || e.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
    throw new HttpError(400, 'Please enter a valid email address', 'invalid_email');
  }
  return e;
}

export function password(value, field = 'Password') {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new HttpError(400, `${field} must be 8–128 characters`, 'weak_password');
  }
  return value;
}

export function optionalName(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > 100) {
    throw new HttpError(400, 'Name must be at most 100 characters', 'invalid_name');
  }
  return value.trim();
}

export function requiredString(value, field, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpError(400, `${field} is required`, 'invalid_request');
  }
  return value.trim();
}

export function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new HttpError(400, `${field} must be one of: ${allowed.join(', ')}`, 'invalid_request');
  }
  return value;
}

export function intInRange(value, min, max, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field} must be a whole number from ${min} to ${max}`, 'invalid_request');
  }
  return n;
}
