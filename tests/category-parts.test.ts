import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import dayjs from 'dayjs'
import { closeDatabase, getDb, openDatabase } from '../src/main/core-db'
import { deleteTransaction, getTransaction, insertTransaction, listTransactions, updateTransaction } from '../src/main/db/repo/transactions'
import { setCategorySplit } from '../src/main/db/repo/category-parts'
import { setSplit } from '../src/main/db/repo/friends'
import { createCategory, deleteCategory } from '../src/main/db/repo/categories'
import { budgetStatuses, createBudget } from '../src/main/db/repo/budgets'
import { dashboardStats } from '../src/main/db/repo/stats'
import { insightsData } from '../src/main/db/repo/insights'
import type { NewTransaction, Transaction } from '../src/shared/types'

let dir: string
const FOOD = 1
const ENTERTAINMENT = 8

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'et-parts-test-'))
  openDatabase(join(dir, 'test.sqlite'))
})
afterAll(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function add(t: Partial<NewTransaction> & Pick<NewTransaction, 'amountPaise' | 'payee'>): Transaction {
  const out = insertTransaction({ accountId: 1, postedAt: '2026-11-01T11:14:46', direction: 'debit', channel: 'upi', source: 'email', narration: `n${++seq}`, refNo: `P${seq}`, kind: 'expense', categoryId: FOOD, ...t })
  if (out.status !== 'inserted') throw new Error(out.status)
  return out.txn
}

describe('category split', () => {
  let settle: Transaction

  it('counts each part under its own category', () => {
    settle = add({ amountPaise: 136732, payee: 'aran' })
    const t = setCategorySplit(settle.id, [
      { categoryId: ENTERTAINMENT, amountPaise: 47628 },
      { categoryId: FOOD, amountPaise: 89104 }
    ])
    // Largest part first, and it becomes the transaction's category.
    expect(t.categoryParts).toEqual([
      { categoryId: FOOD, amountPaise: 89104 },
      { categoryId: ENTERTAINMENT, amountPaise: 47628 }
    ])
    expect(t.categoryId).toBe(FOOD)

    const stats = dashboardStats('2026-11')
    expect(stats.monthTotalPaise).toBe(136732)
    expect(stats.monthCount).toBe(1)
    expect(stats.byCategory.map((c) => [c.categoryId, c.totalPaise, c.count])).toEqual([
      [FOOD, 89104, 1],
      [ENTERTAINMENT, 47628, 1]
    ])
    expect(stats.topPayees).toEqual([{ payee: 'aran', totalPaise: 136732, count: 1 }])

    const ins = insightsData('2026-11')
    expect(ins.expenseCount).toBe(1)
    expect(ins.largest).toHaveLength(1)
    expect(ins.largest[0]!.amountPaise).toBe(136732)
    expect(ins.largest[0]!.category.split(' + ').sort()).toEqual(['Entertainment', 'Food'])
  })

  it('shows under each of its categories when filtering', () => {
    expect(listTransactions({ categoryId: ENTERTAINMENT }).map((t) => t.id)).toEqual([settle.id])
    expect(listTransactions({ categoryId: FOOD }).map((t) => t.id)).toEqual([settle.id])
  })

  it('counts the part in a category budget', () => {
    createBudget({ scope: 'category', categoryId: ENTERTAINMENT, period: 'monthly', weekStart: 1, limitPaise: 100000, warnPct: 80 })
    const s = budgetStatuses(dayjs('2026-11-04')).find((b) => b.categoryId === ENTERTAINMENT)
    expect(s?.spentPaise).toBe(47628)
  })

  it('rejects parts that do not add up or repeat a category', () => {
    expect(() => setCategorySplit(settle.id, [{ categoryId: FOOD, amountPaise: 100 }, { categoryId: ENTERTAINMENT, amountPaise: 100 }])).toThrow('add up to')
    expect(() => setCategorySplit(settle.id, [{ categoryId: FOOD, amountPaise: 136632 }, { categoryId: FOOD, amountPaise: 100 }])).toThrow('listed twice')
    expect(() => setCategorySplit(settle.id, [{ categoryId: FOOD, amountPaise: 136732 }])).toThrow('at least two')
    expect(() => setCategorySplit(settle.id, [{ categoryId: 9999, amountPaise: 136632 }, { categoryId: FOOD, amountPaise: 100 }])).toThrow('needs a category')
    // The failed attempts left the split as it was.
    expect(getTransaction(settle.id)!.categoryParts).toHaveLength(2)
  })

  it('goes away when one category is picked for the whole amount', () => {
    const t = updateTransaction(settle.id, { categoryId: ENTERTAINMENT })
    expect(t.categoryParts).toEqual([])
    expect(dashboardStats('2026-11').byCategory.map((c) => [c.categoryId, c.totalPaise])).toEqual([[ENTERTAINMENT, 136732]])
  })

  it('adds up to the user share of a bill split with friends, and goes when that share changes', () => {
    const dinner = add({ amountPaise: 400000, payee: 'Golcondas' })
    setSplit(dinner.id, [{ friendName: 'Vignesh', amountPaise: 200000 }])
    expect(() => setCategorySplit(dinner.id, [{ categoryId: FOOD, amountPaise: 300000 }, { categoryId: ENTERTAINMENT, amountPaise: 100000 }])).toThrow('add up to')
    setCategorySplit(dinner.id, [{ categoryId: FOOD, amountPaise: 150000 }, { categoryId: ENTERTAINMENT, amountPaise: 50000 }])
    // A new share no longer matches the parts, so the whole share goes to the main category.
    const t = setSplit(dinner.id, [{ friendName: 'Vignesh', amountPaise: 100000 }])
    expect(t.categoryParts).toEqual([])
    expect(t.categoryId).toBe(FOOD)
  })

  it('goes when the transaction stops being an expense', () => {
    const t = add({ amountPaise: 10000, payee: 'Mixed' })
    setCategorySplit(t.id, [{ categoryId: FOOD, amountPaise: 6000 }, { categoryId: ENTERTAINMENT, amountPaise: 4000 }])
    expect(updateTransaction(t.id, { kind: 'transfer' }).categoryParts).toEqual([])
  })

  it('sends the transaction back to uncategorized when one of its categories is deleted', () => {
    const extra = createCategory({ name: 'Gifts', icon: '🎁', color: '#ff0000', sortOrder: 99 })
    const t = add({ amountPaise: 20000, payee: 'Gift shop' })
    setCategorySplit(t.id, [{ categoryId: FOOD, amountPaise: 15000 }, { categoryId: extra.id, amountPaise: 5000 }])
    deleteCategory(extra.id)
    const after = getTransaction(t.id)!
    expect(after.categoryParts).toEqual([])
    expect(after.categoryId).toBeNull()
  })

  it('is removed with its transaction', () => {
    const t = add({ amountPaise: 30000, payee: 'Temp' })
    setCategorySplit(t.id, [{ categoryId: FOOD, amountPaise: 20000 }, { categoryId: ENTERTAINMENT, amountPaise: 10000 }])
    deleteTransaction(t.id)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM category_parts WHERE txn_id = ?').get(t.id)).toEqual({ n: 0 })
  })
})
