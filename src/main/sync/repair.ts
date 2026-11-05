import { getDb } from '../db/connection'
import { reapplyRules } from '../db/repo/transactions'
import { payeeFromStoredAlert } from '../parsers/hdfc-email'
import type { Channel, Direction } from '@shared/types'

/**
 * Sync only fetches new mail, so payees parsed by an older version of the email parser stay
 * wrong forever. Re-derive them from the alert text kept in `narration`; touches a row only when
 * the parser is now confident and disagrees. Low-confidence parses are what set needs_review, so a
 * confident one clears it. Idempotent: safe to run on every launch.
 */
export function repairEmailPayees(): number {
  const db = getDb()
  const rows = db
    .prepare(`SELECT id, payee, narration, direction, vpa, channel, needs_review FROM transactions WHERE source = 'email'`)
    .all() as { id: number; payee: string; narration: string | null; direction: Direction; vpa: string | null; channel: Channel; needs_review: number }[]
  const upd = db.prepare('UPDATE transactions SET payee = ?, needs_review = 0 WHERE id = ?')
  let repaired = 0
  db.transaction(() => {
    for (const r of rows) {
      if (!r.narration) continue
      const { payee, confident } = payeeFromStoredAlert(r.narration, r.direction, r.vpa, r.channel)
      if (!confident || payee === r.payee) continue
      upd.run(payee, r.id)
      repaired++
    }
  })()
  // Rules can match on payee, so let them see the corrected names.
  if (repaired > 0) reapplyRules()
  return repaired
}
