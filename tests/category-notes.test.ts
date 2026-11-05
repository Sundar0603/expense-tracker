import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDatabase, openDatabase } from '../src/main/core-db'
import { insertTransaction, updateTransaction } from '../src/main/db/repo/transactions'
import { setCategorySplit } from '../src/main/db/repo/category-parts'
import { createCategory, listCategories, updateCategory } from '../src/main/db/repo/categories'
import type { NewTransaction, Transaction } from '../src/shared/types'

let dir: string
let OTHER: number
const FOOD = 1

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'et-notes-test-'))
  openDatabase(join(dir, 'test.sqlite'))
  OTHER = listCategories().find((c) => c.name === 'Other')!.id
})
afterAll(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function add(t: Partial<NewTransaction> = {}): Transaction {
  const out = insertTransaction({ accountId: 1, postedAt: '2026-11-02T10:00:00', amountPaise: 25000, direction: 'debit', payee: 'Shop', channel: 'upi', source: 'email', narration: `n${++seq}`, refNo: `N${seq}`, kind: 'expense', categoryId: FOOD, ...t })
  if (out.status !== 'inserted') throw new Error(out.status)
  return out.txn
}

describe('categories that need a description', () => {
  it('starts with Other only', () => {
    expect(listCategories().filter((c) => c.needsNote).map((c) => c.name)).toEqual(['Other'])
  })

  it('need a note when the user files an expense there', () => {
    const t = add()
    expect(() => updateTransaction(t.id, { categoryId: OTHER })).toThrow('required for Other')
    expect(() => updateTransaction(t.id, { categoryId: OTHER, note: '   ' })).toThrow('required for Other')
    const ok = updateTransaction(t.id, { categoryId: OTHER, note: 'Parking at the mall' })
    expect(ok.categoryId).toBe(OTHER)
    // The description can't be cleared while it is in Other, but other edits still work.
    expect(() => updateTransaction(ok.id, { note: null })).toThrow('required for Other')
    expect(updateTransaction(ok.id, { needsReview: false }).note).toBe('Parking at the mall')
  })

  it('applies to manual entries but not to what a rule or sync files there', () => {
    expect(() => add({ source: 'manual', categoryId: OTHER })).toThrow('required for Other')
    expect(add({ source: 'manual', categoryId: OTHER, note: 'Tailor' }).note).toBe('Tailor')
    expect(add({ categoryId: OTHER }).categoryId).toBe(OTHER)
  })

  it('does not apply once it is no longer an expense', () => {
    const t = add({ categoryId: OTHER, note: 'Unknown UPI' })
    expect(updateTransaction(t.id, { kind: 'transfer', note: null }).kind).toBe('transfer')
  })

  it('applies to a part of a category split', () => {
    const t = add({ amountPaise: 10000 })
    const parts = [{ categoryId: FOOD, amountPaise: 7000 }, { categoryId: OTHER, amountPaise: 3000 }]
    expect(() => setCategorySplit(t.id, parts)).toThrow('required for Other')
    updateTransaction(t.id, { note: 'Snacks and a phone cover' })
    expect(setCategorySplit(t.id, parts).categoryParts).toHaveLength(2)
    expect(() => updateTransaction(t.id, { note: '' })).toThrow('required for Other')
  })

  it('can be turned on for any category', () => {
    const misc = createCategory({ name: 'Misc', icon: '📦', color: '#999999', sortOrder: 50 })
    expect(misc.needsNote).toBe(false)
    expect(updateCategory(misc.id, { needsNote: true }).needsNote).toBe(true)
    const t = add()
    expect(() => updateTransaction(t.id, { categoryId: misc.id })).toThrow('required for Misc')
  })
})
