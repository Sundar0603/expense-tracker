import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDatabase, openDatabase } from '../src/main/core-db'

let dir: string
let dbPath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'et-test-'))
  dbPath = join(dir, 'test.sqlite')
  openDatabase(dbPath)
})
afterAll(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('database', () => {
  it('seeds accounts, categories and starter rules', async () => {
    const { listCategories } = await import('../src/main/db/repo/categories')
    const { listRules } = await import('../src/main/db/repo/rules')
    const { listAccounts } = await import('../src/main/db/repo/accounts')
    expect(listAccounts().map((a) => a.bank)).toEqual(['HDFC', 'CASH'])
    expect(listCategories().length).toBeGreaterThan(5)
    expect(listRules().some((r) => r.pattern === 'zerodha' && r.action === 'ignore')).toBe(true)
  })

  it('applies rules on insert and dedupes by fingerprint', async () => {
    const { insertTransaction } = await import('../src/main/db/repo/transactions')
    const zerodha = insertTransaction({
      accountId: 1, postedAt: '2026-10-04T13:00:00', amountPaise: 1500000, direction: 'debit',
      payee: 'ZERODHA BROKING LTD', vpa: 'zerodha@hdfcbank', narration: 'UPI-ZERODHA', refNo: '528304', channel: 'upi', source: 'email'
    })
    expect(zerodha.status).toBe('inserted')
    if (zerodha.status === 'inserted') expect(zerodha.txn.kind).toBe('ignored')

    const again = insertTransaction({
      accountId: 1, postedAt: '2026-10-04T13:00:00', amountPaise: 1500000, direction: 'debit',
      payee: 'Zerodha', vpa: null, narration: 'UPI-ZERODHA BROKING-528304', refNo: '528304', channel: 'upi', source: 'statement'
    })
    expect(again.status).toBe('duplicate')

    const salary = insertTransaction({
      accountId: 1, postedAt: '2026-10-10T10:00:00', amountPaise: 12500000, direction: 'credit',
      payee: 'EMPLOYER', narration: 'NEFT CR SALARY', refNo: 'N2026', channel: 'neft', source: 'email'
    })
    if (salary.status === 'inserted') expect(salary.txn.kind).toBe('income')
  })

  it('clears needs review when a new rule categorizes the row', async () => {
    const { insertTransaction, reapplyRules, listTransactions } = await import('../src/main/db/repo/transactions')
    const { createRule } = await import('../src/main/db/repo/rules')
    const { listCategories } = await import('../src/main/db/repo/categories')
    const base = { accountId: 1, direction: 'debit' as const, channel: 'upi' as const, source: 'email' as const, needsReview: true }
    insertTransaction({ ...base, postedAt: '2026-10-10T20:55:00', amountPaise: 8600, payee: 'swiggydinein', vpa: 'swiggydinein@icici', narration: 'x', refNo: 'R1' })
    insertTransaction({ ...base, postedAt: '2026-10-11T17:03:00', amountPaise: 21566, payee: 'paytmqr123', vpa: 'paytmqr123@paytm', narration: 'y', refNo: 'R2' })
    const food = listCategories()[0]!
    createRule({ field: 'vpa', match: 'contains', pattern: 'swiggydinein', action: 'categorize', categoryId: food.id, priority: 100, enabled: true })
    reapplyRules()
    const rows = listTransactions({})
    const swiggy = rows.find((t) => t.payee === 'swiggydinein')!
    expect(swiggy.categoryId).toBe(food.id)
    expect(swiggy.needsReview).toBe(false)
    expect(rows.find((t) => t.payee === 'paytmqr123')!.needsReview).toBe(true)
  })

  it('re-applying rules keeps a type or category the user picked', async () => {
    const { insertTransaction, updateTransaction, reapplyRules, getTransaction } = await import('../src/main/db/repo/transactions')
    const { createRule } = await import('../src/main/db/repo/rules')
    const { listCategories } = await import('../src/main/db/repo/categories')
    const [food, groceries] = listCategories()
    const t = insertTransaction({
      accountId: 1, postedAt: '2026-10-12T09:00:00', amountPaise: 50000, direction: 'debit', payee: 'MYSELF HDFC',
      vpa: 'me@okhdfc', narration: 'z', refNo: 'R3', channel: 'upi', source: 'email'
    })
    const id = t.status === 'inserted' ? t.txn.id : -1
    updateTransaction(id, { kind: 'transfer', categoryId: groceries!.id })
    createRule({ field: 'vpa', match: 'contains', pattern: 'me@okhdfc', action: 'categorize', categoryId: food!.id, priority: 100, enabled: true })
    reapplyRules()
    expect(getTransaction(id)).toMatchObject({ kind: 'transfer', categoryId: groceries!.id })
  })

  it('deletes without trace and blocks re-import', async () => {
    const { insertTransaction, deleteTransaction, listTransactions } = await import('../src/main/db/repo/transactions')
    const secret = 'VERYSECRETPAYEEXYZ'
    const out = insertTransaction({
      accountId: 1, postedAt: '2026-10-09T22:00:00', amountPaise: 35000, direction: 'debit',
      payee: secret, vpa: 'xyz123@okaxis', narration: `UPI-${secret}`, refNo: '528309', channel: 'upi', source: 'email', emailUid: 4242
    })
    expect(out.status).toBe('inserted')
    const id = out.status === 'inserted' ? out.txn.id : -1
    expect(readFileSync(dbPath, 'latin1')).toContain(secret)

    const { emailUid } = deleteTransaction(id)
    expect(emailUid).toBe(4242)
    expect(listTransactions({ search: secret })).toHaveLength(0)

    // secure_delete: the payee string is overwritten in the file
    expect(readFileSync(dbPath, 'latin1')).not.toContain(secret)

    const retry = insertTransaction({
      accountId: 1, postedAt: '2026-10-09T22:00:00', amountPaise: 35000, direction: 'debit',
      payee: secret, vpa: 'xyz123@okaxis', narration: `UPI-${secret}`, refNo: '528309', channel: 'upi', source: 'email'
    })
    expect(retry.status).toBe('suppressed')
    expect(readFileSync(dbPath, 'latin1')).not.toContain(secret)
  })

  it('computes budget status over the current period', async () => {
    const { createBudget, budgetStatuses } = await import('../src/main/db/repo/budgets')
    const { insertTransaction } = await import('../src/main/db/repo/transactions')
    const dayjs = (await import('dayjs')).default
    const today = dayjs('2026-10-10')
    insertTransaction({
      accountId: 1, postedAt: '2026-10-08T09:00:00', amountPaise: 90000, direction: 'debit',
      payee: 'Petrol Pump', narration: 'UPI-HP', refNo: '700001', channel: 'upi', source: 'email', categoryId: 4, kind: 'expense'
    })
    createBudget({ scope: 'category', categoryId: 4, period: 'monthly', weekStart: 1, limitPaise: 100000, warnPct: 80 })
    const [s] = budgetStatuses(today)
    expect(s?.spentPaise).toBe(90000)
    expect(s?.pct).toBe(90)
    expect(s?.state).toBe('warn')
    expect(s?.periodStart).toBe('2026-10-01')
  })
})
