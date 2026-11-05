import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDatabase, openDatabase } from '../src/main/core-db'
import { deleteTransaction, insertTransaction, reapplyRules, updateTransaction } from '../src/main/db/repo/transactions'
import { deleteFriend, ensureFriend, friendActivity, getSplit, listFriends, setSplit } from '../src/main/db/repo/friends'
import { dashboardStats } from '../src/main/db/repo/stats'
import { insightsData } from '../src/main/db/repo/insights'
import type { NewTransaction, Transaction } from '../src/shared/types'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'et-split-test-'))
  openDatabase(join(dir, 'test.sqlite'))
})
afterAll(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function add(t: Partial<NewTransaction> & Pick<NewTransaction, 'amountPaise' | 'direction' | 'payee'>): Transaction {
  const out = insertTransaction({ accountId: 1, postedAt: '2026-09-10T20:00:00', channel: 'upi', source: 'email', narration: `n${++seq}`, refNo: `R${seq}`, categoryId: 1, ...t })
  if (out.status !== 'inserted') throw new Error(out.status)
  return out.txn
}
const balance = (name: string): number | undefined => listFriends().find((f) => f.name === name)?.balancePaise

describe('split bills', () => {
  let dinner: Transaction

  it('counts only the user share in spending totals', () => {
    dinner = add({ amountPaise: 1000000, direction: 'debit', payee: 'Hotel Saravana' })
    expect(dashboardStats('2026-09').monthTotalPaise).toBe(1000000)
    const t = setSplit(dinner.id, [
      { friendName: 'Arun', amountPaise: 250000 },
      { friendName: 'Priya', amountPaise: 250000 },
      { friendName: 'Kiran', amountPaise: 250000 }
    ])
    expect(t.amountPaise).toBe(1000000)
    expect(t.mySharePaise).toBe(250000)
    expect(dashboardStats('2026-09').monthTotalPaise).toBe(250000)
    expect(insightsData('2026-09').largest[0]!.amountPaise).toBe(250000)
    expect(balance('Arun')).toBe(250000)
    expect(getSplit(dinner.id).map((s) => s.friendName)).toEqual(['Arun', 'Priya', 'Kiran'])
  })

  it('rejects shares that do not fit the bill', () => {
    expect(() => setSplit(dinner.id, [{ friendName: 'Arun', amountPaise: 1000001 }])).toThrow('more than the bill')
    expect(() => setSplit(dinner.id, [{ friendName: 'Arun', amountPaise: 1 }, { friendName: 'arun', amountPaise: 1 }])).toThrow('listed twice')
    const credit = add({ amountPaise: 5000, direction: 'credit', payee: 'someone' })
    expect(() => setSplit(credit.id, [{ friendName: 'Arun', amountPaise: 100 }])).toThrow('Only expenses')
    // The failed attempts left the split as it was.
    expect(getSplit(dinner.id)).toHaveLength(3)
  })

  it('treats a payback as neither income nor expense and learns the UPI ID', () => {
    const credit = add({ amountPaise: 250000, direction: 'credit', payee: 'ARUN K', vpa: 'arun@okaxis' })
    expect(credit.kind).toBe('income')
    const s = updateTransaction(credit.id, { kind: 'settlement', friendId: ensureFriend('arun') })
    expect(s.kind).toBe('settlement')
    expect(balance('Arun')).toBe(0)
    expect(listFriends().find((f) => f.name === 'Arun')!.vpas).toEqual(['arun@okaxis'])
    expect(insightsData('2026-09').incomePaise).toBe(5000)
    expect(dashboardStats('2026-09').monthTotalPaise).toBe(250000)
    expect(() => updateTransaction(dinner.id, { kind: 'settlement', friendId: 1 })).toThrow('money coming in')
  })

  it('suggests a settlement only while that friend still owes money', () => {
    const first = add({ amountPaise: 100000, direction: 'credit', payee: 'PRIYA', vpa: 'priya@okhdfcbank' })
    updateTransaction(first.id, { kind: 'settlement', friendId: ensureFriend('Priya') })
    expect(balance('Priya')).toBe(150000)
    const next = add({ amountPaise: 150000, direction: 'credit', payee: 'PRIYA', vpa: 'priya@okhdfcbank' })
    expect(next.kind).toBe('settlement')
    expect(next.friendId).toBe(ensureFriend('Priya'))
    expect(next.needsReview).toBe(true)
    // Arun is settled up, so more money from him is not assumed to be a payback.
    expect(add({ amountPaise: 9900, direction: 'credit', payee: 'ARUN K', vpa: 'arun@okaxis' }).kind).toBe('income')
    // Re-applying rules does not undo settlements.
    reapplyRules()
    expect(balance('Priya')).toBe(0)
  })

  it('drops the split when the expense stops being an expense, and on delete', () => {
    const cab = add({ amountPaise: 60000, direction: 'debit', payee: 'Uber' })
    setSplit(cab.id, [{ friendName: 'Kiran', amountPaise: 30000 }])
    expect(balance('Kiran')).toBe(280000)
    const ignored = updateTransaction(cab.id, { kind: 'ignored' })
    expect(ignored.mySharePaise).toBeNull()
    expect(balance('Kiran')).toBe(250000)

    deleteTransaction(dinner.id)
    expect(balance('Kiran')).toBe(0)
    expect(friendActivity(ensureFriend('Kiran'))).toEqual([])
  })

  it('keeps friends shares fixed when a manual amount changes', () => {
    const out = insertTransaction({ accountId: 2, postedAt: '2026-09-12T13:00:00', amountPaise: 90000, direction: 'debit', payee: 'Lunch', channel: 'cash', source: 'manual' })
    if (out.status !== 'inserted') throw new Error(out.status)
    setSplit(out.txn.id, [{ friendName: 'Kiran', amountPaise: 30000 }])
    expect(updateTransaction(out.txn.id, { amountPaise: 120000 }).mySharePaise).toBe(90000)
    expect(() => updateTransaction(out.txn.id, { amountPaise: 20000 })).toThrow('more than the new amount')
    setSplit(out.txn.id, [])
    expect(balance('Kiran')).toBe(0)
  })

  it('only deletes friends with nothing recorded', () => {
    expect(() => deleteFriend(ensureFriend('Priya'))).toThrow('Remove those first')
    deleteFriend(ensureFriend('Kiran'))
    expect(listFriends().map((f) => f.name)).toEqual(['Arun', 'Priya'])
  })
})
