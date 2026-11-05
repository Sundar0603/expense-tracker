import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeDatabase, openDatabase } from '../src/main/core-db'
import { createCategory, deleteCategory, listCategories, updateCategory } from '../src/main/db/repo/categories'
import { deleteRule, listRules } from '../src/main/db/repo/rules'

let dir: string
let dbPath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'et-cat-test-'))
  dbPath = join(dir, 'test.sqlite')
  openDatabase(dbPath)
})
afterAll(() => {
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('categories', () => {
  it('keeps deleted starter categories deleted across restarts', () => {
    for (const c of listCategories()) deleteCategory(c.id)
    closeDatabase()
    openDatabase(dbPath)
    expect(listCategories()).toEqual([])
  })

  it('keeps user-added categories across restarts', () => {
    createCategory({ name: 'Petrol', icon: '⛽', color: '#eab308', sortOrder: 0 })
    closeDatabase()
    openDatabase(dbPath)
    expect(listCategories().map((c) => c.name)).toEqual(['Petrol'])
  })

  it('rejects duplicate names with a readable error', () => {
    expect(() => createCategory({ name: 'petrol', icon: '⛽', color: '#eab308', sortOrder: 1 })).toThrow('A category named "petrol" already exists')
    const kids = createCategory({ name: 'Kids', icon: '🧸', color: '#ec4899', sortOrder: 1 })
    expect(() => updateCategory(kids.id, { name: 'PETROL' })).toThrow('already exists')
  })
})

describe('starter rules', () => {
  it('keeps deleted starter rules deleted across restarts', () => {
    expect(listRules().length).toBeGreaterThan(0)
    for (const r of listRules()) deleteRule(r.id)
    closeDatabase()
    openDatabase(dbPath)
    expect(listRules()).toEqual([])
  })
})
