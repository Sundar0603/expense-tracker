import { randomUUID } from 'node:crypto'
import { getDb } from '../connection'
import { toTransaction, type TxnRow } from '../mappers'
import { computeFingerprint, suppressionHash } from '../../core/fingerprint'
import { applyRules } from '../../core/rules'
import { listRules } from './rules'
import { getSetting } from './settings'
import { friendBalance, friendForVpa, learnVpa } from './friends'
import type { NewTransaction, Transaction, TransactionFilter, TransactionPatch } from '@shared/types'

const COLS = `id, account_id, posted_at, amount_paise, direction, payee, vpa, narration, ref_no, channel,
  source, fingerprint, category_id, note, kind, needs_review, email_uid, created_at, my_share_paise, friend_id`

function buildWhere(f: TransactionFilter): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (f.from) {
    clauses.push('posted_at >= ?')
    params.push(f.from)
  }
  if (f.to) {
    clauses.push('posted_at < ?')
    params.push(f.to)
  }
  if (f.categoryId !== undefined) {
    if (f.categoryId === null) clauses.push('category_id IS NULL')
    else {
      // A split expense shows under each of its categories, as it does in the category totals.
      clauses.push('(category_id = ? OR id IN (SELECT txn_id FROM category_parts WHERE category_id = ?))')
      params.push(f.categoryId, f.categoryId)
    }
  }
  if (f.categorized) clauses.push('category_id IS NOT NULL')
  if (f.kind && f.kind !== 'all') {
    clauses.push('kind = ?')
    params.push(f.kind)
  }
  if (f.source) {
    clauses.push('source = ?')
    params.push(f.source)
  }
  if (f.needsReview !== undefined) {
    clauses.push('needs_review = ?')
    params.push(f.needsReview ? 1 : 0)
  }
  if (f.search && f.search.trim()) {
    const like = `%${f.search.trim()}%`
    clauses.push("(payee LIKE ? OR narration LIKE ? OR IFNULL(vpa, '') LIKE ? OR IFNULL(note, '') LIKE ?)")
    params.push(like, like, like, like)
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export function listTransactions(f: TransactionFilter): Transaction[] {
  const { sql, params } = buildWhere(f)
  const limit = Math.min(f.limit ?? 200, 1000)
  const offset = f.offset ?? 0
  const rows = getDb()
    .prepare(`SELECT ${COLS} FROM transactions ${sql} ORDER BY posted_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as TxnRow[]
  return withParts(rows.map(toTransaction))
}

/** Fill in categoryParts for transactions split across categories. */
function withParts(txns: Transaction[]): Transaction[] {
  if (!txns.length) return txns
  const parts = getDb()
    .prepare(`SELECT txn_id, category_id, amount_paise FROM category_parts WHERE txn_id IN (${txns.map(() => '?').join(',')}) ORDER BY amount_paise DESC, id`)
    .all(...txns.map((t) => t.id)) as { txn_id: number; category_id: number; amount_paise: number }[]
  const byTxn = new Map(txns.map((t) => [t.id, t]))
  for (const p of parts) byTxn.get(p.txn_id)!.categoryParts.push({ categoryId: p.category_id, amountPaise: p.amount_paise })
  return txns
}

/**
 * Catch-all categories (needs_note, e.g. "Other") need a description of what the expense was, so
 * it can be recategorized later. Enforced on the user's own choices; a rule may still file an
 * expense there, and the Transactions page then asks for the description.
 */
export function requireNote(categoryIds: (number | null)[], note: string | null | undefined): void {
  if (note?.trim()) return
  const ids = categoryIds.filter((id): id is number => id !== null)
  if (!ids.length) return
  const row = getDb()
    .prepare(`SELECT name FROM categories WHERE needs_note = 1 AND id IN (${ids.map(() => '?').join(',')}) LIMIT 1`)
    .get(...ids) as { name: string } | undefined
  if (row) throw new Error(`Add a description of what this was. It is required for ${row.name}.`)
}

/**
 * Category parts must add up to what the user spent on an expense they paid. When a change breaks
 * that (new amount, new friends' shares, no longer an expense), the parts go and the transaction
 * keeps its main category.
 */
export function dropStaleParts(txnId: number): void {
  getDb()
    .prepare(
      `DELETE FROM category_parts WHERE txn_id = ? AND NOT EXISTS (
         SELECT 1 FROM transactions t WHERE t.id = ? AND t.kind = 'expense' AND t.direction = 'debit'
           AND t.spend_paise = (SELECT SUM(amount_paise) FROM category_parts WHERE txn_id = ?))`
    )
    .run(txnId, txnId, txnId)
}

export function countTransactions(f: TransactionFilter): number {
  const { sql, params } = buildWhere(f)
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM transactions ${sql}`).get(...params) as { n: number }
  return row.n
}

export function getTransaction(id: number): Transaction | null {
  const row = getDb().prepare(`SELECT ${COLS} FROM transactions WHERE id = ?`).get(id) as TxnRow | undefined
  return row ? withParts([toTransaction(row)])[0]! : null
}

export type InsertOutcome =
  | { status: 'inserted'; txn: Transaction }
  | { status: 'duplicate' }
  | { status: 'suppressed' }

/**
 * Insert a transaction, applying rules for category/kind unless the caller already decided.
 * Returns 'duplicate' if the fingerprint exists and 'suppressed' if the user deleted it earlier.
 */
export function insertTransaction(input: NewTransaction, opts: { fingerprint?: string } = {}): InsertOutcome {
  const db = getDb()
  const postedDate = input.postedAt.slice(0, 10)
  const narration = input.narration ?? ''
  const fingerprint =
    opts.fingerprint ??
    (input.source === 'manual'
      ? `manual:${randomUUID()}`
      : computeFingerprint({
          refNo: input.refNo,
          postedDate,
          amountPaise: input.amountPaise,
          direction: input.direction,
          narration
        }))

  const salt = getSetting('suppression_salt') ?? ''
  const suppressed = db
    .prepare('SELECT 1 FROM suppressed WHERE fingerprint_hash = ?')
    .get(suppressionHash(fingerprint, salt))
  if (suppressed) return { status: 'suppressed' }

  const exists = db.prepare('SELECT 1 FROM transactions WHERE fingerprint = ?').get(fingerprint)
  if (exists) return { status: 'duplicate' }

  let kind = input.kind
  let categoryId = input.categoryId
  if (kind === undefined || categoryId === undefined) {
    const outcome = applyRules(listRules(), { payee: input.payee, vpa: input.vpa ?? null, narration })
    if (input.direction === 'credit' && outcome.kind === 'expense') {
      kind = kind ?? 'income'
    } else {
      kind = kind ?? outcome.kind
    }
    categoryId = categoryId ?? outcome.categoryId
  }

  if (input.source === 'manual' && kind === 'expense') requireNote([categoryId ?? null], input.note)

  let friendId = input.friendId ?? null
  let needsReview = input.needsReview ?? false
  if (kind === 'settlement') {
    if (input.direction !== 'credit') throw new Error('Only money coming in can be a settlement')
    if (friendId === null) throw new Error('Pick the friend who paid you back')
  } else if (input.kind === undefined && kind === 'income' && input.vpa) {
    // Money from a UPI ID a friend has paid back from before, while they still owe the user:
    // most likely another payback. Suggest it and leave it for review.
    const f = friendForVpa(input.vpa)
    if (f !== null && friendBalance(f) > 0) {
      kind = 'settlement'
      friendId = f
      needsReview = true
    }
  }

  const result = db
    .prepare(
      `INSERT INTO transactions (account_id, posted_at, amount_paise, direction, payee, vpa, narration, ref_no,
         channel, source, fingerprint, category_id, note, kind, needs_review, email_uid, friend_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.accountId,
      input.postedAt,
      input.amountPaise,
      input.direction,
      input.payee,
      input.vpa ?? null,
      narration,
      input.refNo ?? null,
      input.channel,
      input.source,
      fingerprint,
      categoryId ?? null,
      input.note ?? null,
      kind,
      needsReview ? 1 : 0,
      input.emailUid ?? null,
      kind === 'settlement' ? friendId : null
    )
  return { status: 'inserted', txn: getTransaction(Number(result.lastInsertRowid))! }
}

export function updateTransaction(id: number, patch: TransactionPatch): Transaction {
  const sets: string[] = []
  const params: unknown[] = []
  const map: Record<Exclude<keyof TransactionPatch, 'friendId'>, string> = {
    postedAt: 'posted_at',
    amountPaise: 'amount_paise',
    payee: 'payee',
    categoryId: 'category_id',
    note: 'note',
    kind: 'kind',
    direction: 'direction',
    needsReview: 'needs_review',
    accountId: 'account_id'
  }
  for (const [k, col] of Object.entries(map) as [Exclude<keyof TransactionPatch, 'friendId'>, string][]) {
    if (patch[k] === undefined) continue
    sets.push(`${col} = ?`)
    const v = patch[k]
    params.push(typeof v === 'boolean' ? (v ? 1 : 0) : v)
  }
  const before = getTransaction(id)
  if (!before) throw new Error(`Transaction ${id} not found`)
  // A hand-picked category or type outranks rules from now on (the edit dialog always sends both,
  // so only an actual change counts).
  if ((patch.categoryId !== undefined && patch.categoryId !== before.categoryId) || (patch.kind !== undefined && patch.kind !== before.kind)) {
    sets.push('user_set = 1')
  }

  const kind = patch.kind ?? before.kind
  const direction = patch.direction ?? before.direction
  if (kind === 'expense' && (patch.categoryId !== undefined || patch.note !== undefined || patch.kind !== undefined)) {
    const categoryId = patch.categoryId !== undefined ? patch.categoryId : before.categoryId
    // Parts survive only when the category stays the same (see below).
    const parts = categoryId === before.categoryId ? before.categoryParts.map((p) => p.categoryId) : []
    requireNote([categoryId, ...parts], patch.note !== undefined ? patch.note : before.note)
  }
  const friendId = patch.friendId !== undefined ? patch.friendId : before.friendId
  if (kind === 'settlement') {
    if (direction !== 'credit') throw new Error('Only money coming in can be a settlement')
    if (friendId === null) throw new Error('Pick the friend who paid you back')
    sets.push('friend_id = ?')
    params.push(friendId)
  } else if (before.friendId !== null) {
    sets.push('friend_id = NULL')
  }

  // Keep a split consistent: it only applies to an expense the user paid, and the friends' shares
  // stay fixed when the amount of a manual entry changes.
  const unsplit = before.mySharePaise !== null && (kind !== 'expense' || direction !== 'debit')
  if (unsplit) {
    sets.push('my_share_paise = NULL')
  } else if (before.mySharePaise !== null && patch.amountPaise !== undefined && patch.amountPaise !== before.amountPaise) {
    const owed = before.amountPaise - before.mySharePaise
    if (owed > patch.amountPaise) throw new Error("Friends' shares add up to more than the new amount")
    sets.push('my_share_paise = ?')
    params.push(patch.amountPaise - owed)
  }

  const db = getDb()
  db.transaction(() => {
    if (unsplit) db.prepare('DELETE FROM split_shares WHERE txn_id = ?').run(id)
    if (sets.length) db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
    // Picking one category for a split expense means all of it belongs there.
    if (patch.categoryId !== undefined && patch.categoryId !== before.categoryId) db.prepare('DELETE FROM category_parts WHERE txn_id = ?').run(id)
    dropStaleParts(id)
    // Remember where this friend pays from, so their next payback is recognised.
    if (kind === 'settlement' && friendId !== null && before.vpa) learnVpa(friendId, before.vpa)
  })()
  return getTransaction(id)!
}

/**
 * Traceless delete: remove the row and remember only a salted hash of its fingerprint so a
 * future sync cannot bring it back. Returns the email UID (if any) so the caller may trash the mail.
 */
export function deleteTransaction(id: number): { emailUid: number | null } {
  const db = getDb()
  const run = db.transaction((txnId: number) => {
    const row = db
      .prepare('SELECT fingerprint, source, email_uid FROM transactions WHERE id = ?')
      .get(txnId) as { fingerprint: string; source: string; email_uid: number | null } | undefined
    if (!row) return { emailUid: null }
    if (row.source !== 'manual') {
      const salt = getSetting('suppression_salt') ?? ''
      db.prepare('INSERT OR IGNORE INTO suppressed (fingerprint_hash) VALUES (?)').run(
        suppressionHash(row.fingerprint, salt)
      )
    }
    db.prepare('DELETE FROM transactions WHERE id = ?').run(txnId)
    return { emailUid: row.email_uid }
  })
  return run(id)
}

export function payeeSuggestions(prefix: string): string[] {
  const rows = getDb()
    .prepare(
      `SELECT payee, COUNT(*) AS n FROM transactions WHERE payee LIKE ? GROUP BY payee ORDER BY n DESC LIMIT 10`
    )
    .all(`${prefix}%`) as { payee: string }[]
  return rows.map((r) => r.payee)
}

/**
 * Re-apply rules to bank transactions, except rows whose category or type the user picked by hand
 * and settlements (a friend's payback is not something a rule decides).
 */
export function reapplyRules(): { updated: number } {
  const db = getDb()
  const rules = listRules()
  const rows = db
    .prepare(`SELECT ${COLS} FROM transactions WHERE source != 'manual' AND user_set = 0 AND kind != 'settlement'`)
    .all() as TxnRow[]
  const upd = db.prepare('UPDATE transactions SET category_id = ?, kind = ?, needs_review = ? WHERE id = ?')
  let updated = 0
  const run = db.transaction(() => {
    for (const r of rows) {
      const outcome = applyRules(rules, { payee: r.payee, vpa: r.vpa, narration: r.narration })
      let kind = outcome.kind as string
      if (r.direction === 'credit' && kind === 'expense') kind = 'income'
      // Keep a user-assigned category when the rules have no opinion.
      const categoryId = outcome.categoryId ?? r.category_id
      // A rule the user wrote has now decided this row, which is what reviewing it would have done.
      const needsReview = r.needs_review === 1 && outcome.categoryId === null ? 1 : 0
      if (kind !== r.kind || categoryId !== r.category_id || needsReview !== r.needs_review) {
        upd.run(categoryId, kind, needsReview, r.id)
        updated++
      }
    }
  })
  run()
  return { updated }
}
