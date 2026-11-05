import { getDb } from '../connection'
import { getTransaction, requireNote } from './transactions'
import type { CategoryPart, Transaction } from '@shared/types'
import { formatINR } from '@shared/money'

/**
 * Split an expense across categories. The parts must add up to what the user spent (their share
 * when the bill is split with friends). The largest part becomes the transaction's category.
 * An empty list removes the split and leaves that category on the whole amount.
 */
export function setCategorySplit(txnId: number, parts: CategoryPart[]): Transaction {
  const txn = getTransaction(txnId)
  if (!txn) throw new Error(`Transaction ${txnId} not found`)
  const db = getDb()
  if (!parts.length) {
    db.prepare('DELETE FROM category_parts WHERE txn_id = ?').run(txnId)
    return getTransaction(txnId)!
  }
  if (!(txn.kind === 'expense' && txn.direction === 'debit')) throw new Error('Only expenses you paid can be split across categories')
  if (parts.length < 2) throw new Error('Pick at least two categories, or just set one category')
  const known = new Set((db.prepare('SELECT id FROM categories').all() as { id: number }[]).map((c) => c.id))
  const seen = new Set<number>()
  let total = 0
  for (const p of parts) {
    if (!known.has(p.categoryId)) throw new Error('Every part needs a category')
    if (seen.has(p.categoryId)) throw new Error('A category is listed twice')
    seen.add(p.categoryId)
    if (!Number.isInteger(p.amountPaise) || p.amountPaise <= 0) throw new Error('Every part must be more than zero')
    total += p.amountPaise
  }
  requireNote([...seen], txn.note)
  const spend = txn.mySharePaise ?? txn.amountPaise
  if (total !== spend) throw new Error(`The parts add up to ${formatINR(total)}, not ${formatINR(spend)}`)

  const main = parts.reduce((a, b) => (b.amountPaise > a.amountPaise ? b : a))
  db.transaction(() => {
    db.prepare('DELETE FROM category_parts WHERE txn_id = ?').run(txnId)
    const ins = db.prepare('INSERT INTO category_parts (txn_id, category_id, amount_paise) VALUES (?, ?, ?)')
    for (const p of parts) ins.run(txnId, p.categoryId, p.amountPaise)
    // A hand decision, like picking a category: rules leave it alone.
    db.prepare('UPDATE transactions SET category_id = ?, user_set = 1 WHERE id = ?').run(main.categoryId, txnId)
  })()
  return getTransaction(txnId)!
}
