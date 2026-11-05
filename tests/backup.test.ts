import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'et-backup-test-'))
const backupFile = join(dir, 'out.etbk')
const tempDir = join(dir, 'temp')

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'temp' ? tempDir : dir) },
  dialog: {
    showSaveDialog: async () => ({ canceled: false, filePath: backupFile }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [backupFile] }),
    showMessageBox: async () => ({ response: 0 })
  }
}))

const dbPath = join(dir, 'expenses.sqlite')

beforeAll(async () => {
  const { mkdirSync } = await import('node:fs')
  mkdirSync(tempDir)
  const { openDatabase } = await import('../src/main/core-db')
  openDatabase(dbPath)
})
afterAll(async () => {
  const { closeDatabase } = await import('../src/main/core-db')
  closeDatabase()
  rmSync(dir, { recursive: true, force: true })
})

describe('backup and restore', () => {
  it('keeps deletions made after the backup and leaves no plaintext behind', async () => {
    const { insertTransaction, deleteTransaction, listTransactions } = await import('../src/main/db/repo/transactions')
    const { backupDatabase, restoreDatabase } = await import('../src/main/backup')
    const { setSetting, getSetting } = await import('../src/main/db/repo/settings')
    const base = { accountId: 1, direction: 'debit' as const, channel: 'upi' as const, source: 'email' as const, narration: 'x' }
    const a = insertTransaction({ ...base, postedAt: '2026-10-05T10:00:00', amountPaise: 1000, payee: 'KEEP', refNo: 'REF000001' })
    const b = insertTransaction({ ...base, postedAt: '2026-10-06T10:00:00', amountPaise: 2000, payee: 'DELETEDLATER', refNo: 'REF000002' })
    expect(a.status).toBe('inserted')
    setSetting('gmail_user', 'me@gmail.com')

    expect(await backupDatabase('correct horse')).toBe(backupFile)
    expect(readdirSync(tempDir)).toEqual([]) // plaintext snapshot scrubbed

    if (b.status === 'inserted') deleteTransaction(b.txn.id)
    setSetting('gmail_user', 'me@gmail.com')
    expect(await restoreDatabase('correct horse', dbPath)).toBe(true)

    const payees = listTransactions({ kind: 'all' }).map((t) => t.payee)
    expect(payees).toContain('KEEP')
    expect(payees).not.toContain('DELETEDLATER')
    // And a re-sync still can't bring it back.
    const again = insertTransaction({ ...base, postedAt: '2026-10-06T10:00:00', amountPaise: 2000, payee: 'DELETEDLATER', refNo: 'REF000002' })
    expect(again.status).toBe('suppressed')
    expect(getSetting('gmail_user')).toBe('me@gmail.com')
    expect(existsSync(`${dbPath}.before-restore`)).toBe(false)
    expect(existsSync(`${dbPath}.before-restore.etbk`)).toBe(true)
  })

  it('rejects a wrong passphrase', async () => {
    const { restoreDatabase } = await import('../src/main/backup')
    await expect(restoreDatabase('wrong passphrase', dbPath)).rejects.toThrow(/Wrong passphrase/)
  })
})
