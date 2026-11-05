import { app, dialog } from 'electron'
import Database from 'better-sqlite3'
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import dayjs from 'dayjs'
import { closeDatabase, getDb, openDatabase } from '../db/connection'
import { listTransactions } from '../db/repo/transactions'
import { listCategories } from '../db/repo/categories'
import { listFriends } from '../db/repo/friends'
import { suppressionHash } from '../core/fingerprint'
import type { Transaction } from '@shared/types'

const MAGIC = Buffer.from('ETBK1')

/** Export all transactions (every kind) to a CSV the user picks. Returns the path or null. */
export async function exportCsv(): Promise<string | null> {
  const res = await dialog.showSaveDialog({
    title: 'Export transactions as CSV',
    defaultPath: join(app.getPath('downloads'), `expenses-${dayjs().format('YYYY-MM-DD')}.csv`),
    filters: [{ name: 'CSV', extensions: ['csv'] }]
  })
  if (res.canceled || !res.filePath) return null
  const cats = new Map(listCategories().map((c) => [c.id, c.name]))
  const friends = new Map(listFriends().map((f) => [f.id, f.name]))
  // listTransactions caps a page at 1000 rows, so page through everything.
  const rows: Transaction[] = []
  for (let offset = 0; ; offset += 1000) {
    const page = listTransactions({ kind: 'all', limit: 1000, offset })
    rows.push(...page)
    if (page.length < 1000) break
  }
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const header = ['date', 'time', 'payee', 'amount', 'my_share', 'direction', 'kind', 'category', 'friend', 'channel', 'source', 'vpa', 'ref_no', 'narration', 'note']
  const lines = [header.join(',')]
  for (const t of rows) {
    lines.push(
      [
        t.postedAt.slice(0, 10),
        t.postedAt.slice(11, 19),
        t.payee,
        (t.amountPaise / 100).toFixed(2),
        t.mySharePaise === null ? '' : (t.mySharePaise / 100).toFixed(2),
        t.direction,
        t.kind,
        t.categoryParts.length
          ? t.categoryParts.map((p) => `${cats.get(p.categoryId) ?? ''} ${(p.amountPaise / 100).toFixed(2)}`).join(' + ')
          : t.categoryId === null ? '' : (cats.get(t.categoryId) ?? ''),
        t.friendId === null ? '' : (friends.get(t.friendId) ?? ''),
        t.channel,
        t.source,
        t.vpa ?? '',
        t.refNo ?? '',
        t.narration,
        t.note ?? ''
      ]
        .map(esc)
        .join(',')
    )
  }
  writeFileSync(res.filePath, lines.join('\n'), 'utf8')
  return res.filePath
}

/**
 * Encrypted backup of the whole database file (AES-256-GCM, key derived from a passphrase with scrypt).
 * Secrets stored via safeStorage are device-bound and are NOT portable; they are excluded by
 * re-encrypting a copy of the DB without `secret:` rows.
 */
export async function backupDatabase(passphrase: string): Promise<string | null> {
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters')
  const res = await dialog.showSaveDialog({
    title: 'Save encrypted backup',
    defaultPath: join(app.getPath('downloads'), `expense-tracker-backup-${dayjs().format('YYYY-MM-DD')}.etbk`),
    filters: [{ name: 'Expense Tracker backup', extensions: ['etbk'] }]
  })
  if (res.canceled || !res.filePath) return null
  // Consistent snapshot without secrets.
  const tmp = join(app.getPath('temp'), `et-backup-${Date.now()}.sqlite`)
  try {
    getDb().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`)
    const snapshot = new Database(tmp)
    snapshot.exec(`DELETE FROM settings WHERE key LIKE 'secret:%'`)
    snapshot.exec('VACUUM')
    snapshot.close()
    writeFileSync(res.filePath, encrypt(readFileSync(tmp), passphrase))
  } finally {
    // The snapshot is plaintext: never leave it behind, even if writing the backup failed.
    scrub(tmp)
  }
  return res.filePath
}

function encrypt(plain: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), enc])
}

/** Overwrite then delete a plaintext file. */
function scrub(path: string): void {
  if (!existsSync(path)) return
  try {
    writeFileSync(path, Buffer.alloc(statSync(path).size))
    unlinkSync(path)
  } catch {
    /* best effort */
  }
}

/** Settings tied to this Mac's Keychain secrets (or to how deletions are remembered), kept across a restore. */
const KEEP_ON_RESTORE = ['gmail_user', 'gmail_auth', 'gmail_oauth_client_id', 'ai_profiles', 'ai_active', 'ai_privacy']

export async function restoreDatabase(passphrase: string, dbPath: string): Promise<boolean> {
  const res = await dialog.showOpenDialog({
    title: 'Choose a backup to restore',
    properties: ['openFile'],
    filters: [{ name: 'Expense Tracker backup', extensions: ['etbk'] }]
  })
  if (res.canceled || res.filePaths.length === 0) return false
  const buf = readFileSync(res.filePaths[0]!)
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an Expense Tracker backup file')
  let o = MAGIC.length
  const salt = buf.subarray(o, (o += 16))
  const iv = buf.subarray(o, (o += 12))
  const tag = buf.subarray(o, (o += 16))
  const enc = buf.subarray(o)
  const key = scryptSync(passphrase, salt, 32)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  let plain: Buffer
  try {
    plain = Buffer.concat([decipher.update(enc), decipher.final()])
  } catch {
    throw new Error('Wrong passphrase or corrupted backup')
  }
  if (plain.subarray(0, 15).toString() !== 'SQLite format 3') throw new Error('Backup does not contain a database')
  const confirm = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Replace', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'Replace your current data with this backup?',
    detail:
      'The current data is saved next to it as a .before-restore.etbk backup, encrypted with the same passphrase. ' +
      'Gmail and AI connections stay as they are, and anything you deleted stays deleted.'
  })
  if (confirm.response !== 0) return false

  const cur = getDb()
  // Preserve current secrets and the settings that go with them so nothing has to be re-entered.
  const keep = cur
    .prepare(`SELECT key, value FROM settings WHERE key LIKE 'secret:%' OR key IN (${KEEP_ON_RESTORE.map(() => '?').join(',')})`)
    .all(...KEEP_ON_RESTORE) as { key: string; value: string }[]
  const curSalt = (cur.prepare(`SELECT value FROM settings WHERE key = 'suppression_salt'`).get() as { value: string } | undefined)?.value ?? ''
  const curSuppressed = new Set((cur.prepare('SELECT fingerprint_hash AS h FROM suppressed').all() as { h: string }[]).map((r) => r.h))
  const curUser = (cur.prepare(`SELECT value FROM settings WHERE key = 'gmail_user'`).get() as { value: string } | undefined)?.value ?? ''

  // Encrypted safety copy instead of a plaintext one that later deletes would never reach.
  writeFileSync(`${dbPath}.before-restore.etbk`, encrypt(readFileSync(dbPath), passphrase))
  scrub(`${dbPath}.before-restore`) // plaintext copy left by older versions
  closeDatabase()
  writeFileSync(dbPath, plain)
  const db = openDatabase(dbPath)

  db.transaction(() => {
    const backupSalt = (db.prepare(`SELECT value FROM settings WHERE key = 'suppression_salt'`).get() as { value: string } | undefined)?.value ?? ''
    const backupUser = (db.prepare(`SELECT value FROM settings WHERE key = 'gmail_user'`).get() as { value: string } | undefined)?.value ?? ''
    const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    for (const k of keep) set.run(k.key, k.value)
    // A different mailbox's sync cursor means nothing for the current one.
    if (backupUser !== curUser) for (const k of ['gmail_last_uid', 'gmail_uidvalidity', 'gmail_last_sync_at']) set.run(k, '')

    // Deletions made after the backup must survive it: drop restored rows the current list
    // suppresses, then keep the current list (hashes only mean something under their own salt).
    const rows = db.prepare(`SELECT id, fingerprint FROM transactions WHERE source != 'manual'`).all() as { id: number; fingerprint: string }[]
    const del = db.prepare('DELETE FROM transactions WHERE id = ?')
    for (const r of rows) if (curSuppressed.has(suppressionHash(r.fingerprint, curSalt))) del.run(r.id)
    if (backupSalt !== curSalt) {
      db.prepare('DELETE FROM suppressed').run()
      set.run('suppression_salt', curSalt)
    }
    const sup = db.prepare('INSERT OR IGNORE INTO suppressed (fingerprint_hash) VALUES (?)')
    for (const h of curSuppressed) sup.run(h)
  })()
  return true
}
