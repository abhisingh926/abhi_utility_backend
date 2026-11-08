/**
 * Referral bonus days must come AFTER paid / granted Pro time, never overlap it.
 * A bonus is placed after the current paid period when it is earned, but an
 * auto-renewing subscription then renews over it, so the bonus would be used
 * up while the user is paying anyway. After every store update the bonus rows
 * are moved back behind the paid time (keeping the days not used yet).
 *
 * Pure function (no database), so it is unit-tested.
 *
 * @param {Date|null} paidUntil  end of the latest non-bonus Pro time (null = none)
 * @param {{id:number, startsAt:Date, expiresAt:Date}[]} bonuses  active, not ended, oldest first
 * @param {Date} now
 * @returns {{id:number, startsAt:Date, expiresAt:Date}[]} only the rows that change
 */
export function planBonusDays(paidUntil, bonuses, now = new Date()) {
  if (!paidUntil) return [];
  let cursor = paidUntil;
  const changes = [];
  for (const b of bonuses) {
    if (b.startsAt >= cursor) {
      // Already after the paid time (or after the previous bonus): keep it.
      if (b.expiresAt > cursor) cursor = b.expiresAt;
      continue;
    }
    // Overlaps paid time: what's left of it (all of it if it hasn't started) moves behind.
    const usedFrom = b.startsAt > now ? b.startsAt : now;
    const left = b.expiresAt - usedFrom;
    if (left <= 0) continue;
    const startsAt = cursor;
    const expiresAt = new Date(cursor.getTime() + left);
    changes.push({ id: b.id, startsAt, expiresAt });
    cursor = expiresAt;
  }
  return changes;
}
