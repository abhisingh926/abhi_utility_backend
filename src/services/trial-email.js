const GMAIL = new Set(['gmail.com', 'googlemail.com']);

/**
 * The address a free trial is counted against, so aliases of one mailbox share
 * a trial: "A.B+x@Gmail.com" and "ab@gmail.com" are the same person.
 * (Pure function: no database, so it is unit-tested.)
 */
export function trialEmailKey(email) {
  const e = String(email).trim().toLowerCase();
  const at = e.lastIndexOf('@');
  let user = at < 0 ? e : e.slice(0, at);
  let host = at < 0 ? '' : e.slice(at + 1);
  user = user.split('+')[0];
  if (GMAIL.has(host)) {
    user = user.replace(/\./g, '');
    host = 'gmail.com';
  }
  return `${user}@${host}`;
}
