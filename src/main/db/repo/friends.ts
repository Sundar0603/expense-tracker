import { getDb } from '../connection'
import { dropStaleParts, getTransaction } from './transactions'
import type { Friend, FriendActivity, SplitShare, SplitShareInput, Transaction } from '@shared/types'

export function listFriends(): Friend[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT f.id, f.name,
         IFNULL((SELECT SUM(amount_paise) FROM split_shares s WHERE s.friend_id = f.id), 0) AS shared,
         IFNULL((SELECT SUM(amount_paise) FROM transactions t WHERE t.friend_id = f.id AND t.kind = 'settlement'), 0) AS settled
       FROM friends f ORDER BY f.name`
    )
    .all() as { id: number; name: string; shared: number; settled: number }[]
  const vpas = db.prepare('SELECT vpa, friend_id FROM friend_vpas ORDER BY vpa').all() as { vpa: string; friend_id: number }[]
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    vpas: vpas.filter((v) => v.friend_id === r.id).map((v) => v.vpa),
    sharedPaise: r.shared,
    settledPaise: r.settled,
    balancePaise: r.shared - r.settled
  }))
}

/** Positive: the friend owes the user. */
export function friendBalance(id: number): number {
  return listFriends().find((f) => f.id === id)?.balancePaise ?? 0
}

/** Friend ids are what transactions store; the UI deals in names, so look one up or add it. */
export function ensureFriend(name: string): number {
  const clean = name.trim()
  if (!clean) throw new Error('Friend name is empty')
  const db = getDb()
  const row = db.prepare('SELECT id FROM friends WHERE name = ?').get(clean) as { id: number } | undefined
  if (row) return row.id
  return Number(db.prepare('INSERT INTO friends (name) VALUES (?)').run(clean).lastInsertRowid)
}

export function renameFriend(id: number, name: string): void {
  const clean = name.trim()
  if (!clean) throw new Error('Friend name is empty')
  try {
    getDb().prepare('UPDATE friends SET name = ? WHERE id = ?').run(clean, id)
  } catch (e) {
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error(`A friend named "${clean}" already exists`)
    throw e
  }
}

/** Only friends with nothing recorded can go; otherwise balances would silently change. */
export function deleteFriend(id: number): void {
  const db = getDb()
  const used =
    db.prepare('SELECT 1 FROM split_shares WHERE friend_id = ? LIMIT 1').get(id) ??
    db.prepare('SELECT 1 FROM transactions WHERE friend_id = ? LIMIT 1').get(id)
  if (used) throw new Error('This friend has split bills or paybacks recorded. Remove those first.')
  db.prepare('DELETE FROM friends WHERE id = ?').run(id)
}

export function friendActivity(id: number): FriendActivity[] {
  return getDb()
    .prepare(
      `SELECT t.id AS txnId, t.posted_at AS postedAt, t.payee, 'share' AS type, s.amount_paise AS amountPaise, t.amount_paise AS billPaise
       FROM split_shares s JOIN transactions t ON t.id = s.txn_id WHERE s.friend_id = ?
       UNION ALL
       SELECT id, posted_at, payee, 'settlement', amount_paise, NULL FROM transactions WHERE friend_id = ? AND kind = 'settlement'
       ORDER BY postedAt DESC`
    )
    .all(id, id) as FriendActivity[]
}

export function friendForVpa(vpa: string): number | null {
  const row = getDb().prepare('SELECT friend_id FROM friend_vpas WHERE vpa = ?').get(vpa) as { friend_id: number } | undefined
  return row?.friend_id ?? null
}

export function learnVpa(friendId: number, vpa: string): void {
  getDb()
    .prepare('INSERT INTO friend_vpas (vpa, friend_id) VALUES (?, ?) ON CONFLICT(vpa) DO UPDATE SET friend_id = excluded.friend_id')
    .run(vpa, friendId)
}

export function getSplit(txnId: number): SplitShare[] {
  return getDb()
    .prepare(
      `SELECT s.friend_id AS friendId, f.name AS friendName, s.amount_paise AS amountPaise
       FROM split_shares s JOIN friends f ON f.id = s.friend_id WHERE s.txn_id = ? ORDER BY s.id`
    )
    .all(txnId) as SplitShare[]
}

/**
 * Replace the friends' shares of an expense. The user's share is what's left, and that is what
 * spending totals count. An empty list removes the split.
 */
export function setSplit(txnId: number, shares: SplitShareInput[]): Transaction {
  const txn = getTransaction(txnId)
  if (!txn) throw new Error(`Transaction ${txnId} not found`)
  if (shares.length && !(txn.kind === 'expense' && txn.direction === 'debit')) throw new Error('Only expenses you paid can be split')
  const names = new Set<string>()
  let owed = 0
  for (const s of shares) {
    const key = s.friendName.trim().toLowerCase()
    if (!key) throw new Error('Every share needs a friend name')
    if (names.has(key)) throw new Error(`${s.friendName.trim()} is listed twice`)
    names.add(key)
    if (!Number.isInteger(s.amountPaise) || s.amountPaise <= 0) throw new Error(`${s.friendName.trim()}'s share must be more than zero`)
    owed += s.amountPaise
  }
  if (owed > txn.amountPaise) throw new Error("Friends' shares add up to more than the bill")

  const db = getDb()
  db.transaction(() => {
    db.prepare('DELETE FROM split_shares WHERE txn_id = ?').run(txnId)
    const ins = db.prepare('INSERT INTO split_shares (txn_id, friend_id, amount_paise) VALUES (?, ?, ?)')
    for (const s of shares) ins.run(txnId, ensureFriend(s.friendName), s.amountPaise)
    // Splitting is a hand decision that this is the user's expense, so rules leave it alone.
    if (shares.length) db.prepare('UPDATE transactions SET my_share_paise = ?, user_set = 1 WHERE id = ?').run(txn.amountPaise - owed, txnId)
    else db.prepare('UPDATE transactions SET my_share_paise = NULL WHERE id = ?').run(txnId)
    dropStaleParts(txnId)
  })()
  return getTransaction(txnId)!
}
