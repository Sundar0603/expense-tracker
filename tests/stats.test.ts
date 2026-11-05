import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import dayjs from 'dayjs'
import { closeDatabase, openDatabase } from '../src/main/core-db'
import { insertTransaction, updateTransaction } from '../src/main/db/repo/transactions'
import { dashboardStats } from '../src/main/db/repo/stats'
import { insightsData } from '../src/main/db/repo/insights'
import { budgetStatuses, createBudget } from '../src/main/db/repo/budgets'
import type { NewTransaction, Transaction } from '../src/shared/types'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'et-stats-test-'))
  openDatabase(join(dir, 'test.sqlite'))
})
afterAll(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function add(t: Partial<NewTransaction> & Pick<NewTransaction, 'amountPaise' | 'payee'>): Transaction {
  const out = insertTransaction({ accountId: 1, postedAt: '2026-09-10T20:00:00', direction: 'debit', channel: 'upi', source: 'email', narration: `n${++seq}`, refNo: `S${seq}`, kind: 'expense', ...t })
  if (out.status !== 'inserted') throw new Error(out.status)
  return out.txn
}

describe('uncategorized expenses', () => {
  let pending: Transaction

  it('stay out of dashboard and insights figures', () => {
    add({ amountPaise: 40000, payee: 'Reviewed Cafe', categoryId: 1 })
    pending = add({ amountPaise: 99000, payee: 'Unknown Merchant', categoryId: null })
    expect(pending.categoryId).toBeNull()

    const stats = dashboardStats('2026-09')
    expect(stats.monthTotalPaise).toBe(40000)
    expect(stats.byCategory.map((c) => c.categoryId)).toEqual([1])
    expect(stats.topPayees.map((p) => p.payee)).toEqual(['Reviewed Cafe'])
    expect(stats.daily.reduce((n, d) => n + d.totalPaise, 0)).toBe(40000)
    expect(stats.uncategorized).toEqual({ count: 1, totalPaise: 99000 })

    const ins = insightsData('2026-09')
    expect(ins.comparison.map((c) => c.categoryId)).toEqual([1])
    expect(ins.largest.map((l) => l.payee)).toEqual(['Reviewed Cafe'])
    expect(ins.expenseCount).toBe(1)
    expect(ins.monthTotals).toEqual([{ month: '2026-09', totalPaise: 40000 }])
    expect(ins.uncategorized).toEqual({ count: 1, totalPaise: 99000 })
  })

  it('count once they get a category', () => {
    updateTransaction(pending.id, { categoryId: 2 })
    expect(dashboardStats('2026-09').monthTotalPaise).toBe(139000)
    expect(dashboardStats('2026-09').uncategorized).toEqual({ count: 0, totalPaise: 0 })
  })

  it('stay out of the overall budget', () => {
    add({ amountPaise: 55000, payee: 'Another Unknown', categoryId: null, postedAt: '2026-10-08T09:00:00' })
    add({ amountPaise: 20000, payee: 'Reviewed Store', categoryId: 1, postedAt: '2026-10-08T10:00:00' })
    createBudget({ scope: 'overall', categoryId: null, period: 'monthly', weekStart: 1, limitPaise: 100000, warnPct: 80 })
    const [s] = budgetStatuses(dayjs('2026-10-10'))
    expect(s?.spentPaise).toBe(20000)
  })
})
