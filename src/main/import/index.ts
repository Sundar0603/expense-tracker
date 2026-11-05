import { dialog } from 'electron'
import { basename } from 'node:path'
import { readStatementFile } from './readers'
import { computeFingerprint, suppressionHash } from '../core/fingerprint'
import { getDb } from '../db/connection'
import { getSetting } from '../db/repo/settings'
import { insertTransaction } from '../db/repo/transactions'
import { accountByBank } from '../db/repo/accounts'
import { checkBudgetsAndNotify } from '../sync/budget-alerts'
import type { ImportCommitResult, ImportPreview, ImportPreviewRow } from '@shared/types'
import { isBeforeTrackingStart } from '../core/tracking-start'

export async function pickStatementFile(): Promise<string | null> {
  // Development aid: scripted UI runs can't click through a native dialog.
  if (process.env['ET_PICK_FILE']) return process.env['ET_PICK_FILE']
  const res = await dialog.showOpenDialog({
    title: 'Choose an HDFC Bank statement',
    properties: ['openFile'],
    filters: [
      { name: 'Statements', extensions: ['xls', 'xlsx', 'csv', 'txt', 'pdf'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  if (res.canceled || res.filePaths.length === 0) return null
  return res.filePaths[0]!
}

export async function previewStatement(path: string, password?: string): Promise<ImportPreview> {
  const read = await readStatementFile(path, password)
  const db = getDb()
  const salt = getSetting('suppression_salt') ?? ''
  const existsStmt = db.prepare('SELECT 1 FROM transactions WHERE fingerprint = ?')
  const suppStmt = db.prepare('SELECT 1 FROM suppressed WHERE fingerprint_hash = ?')
  const seen = new Set<string>()
  const rows: ImportPreviewRow[] = read.txns.map((t) => {
    const fingerprint = computeFingerprint({
      refNo: t.refNo,
      postedDate: t.postedAt.slice(0, 10),
      amountPaise: t.amountPaise,
      direction: t.direction,
      narration: t.narration
    })
    let status: ImportPreviewRow['status'] = 'new'
    if (isBeforeTrackingStart(t.postedAt)) status = 'before_start'
    else if (seen.has(fingerprint)) status = 'duplicate'
    else if (existsStmt.get(fingerprint)) status = 'duplicate'
    else if (suppStmt.get(suppressionHash(fingerprint, salt))) status = 'suppressed'
    seen.add(fingerprint)
    return { ...t, fingerprint, status }
  })
  return {
    fileName: basename(path),
    path,
    rows,
    skipped: read.skipped,
    error: read.error,
    needsPassword: read.needsPassword ?? false,
    counts: {
      new: rows.filter((r) => r.status === 'new').length,
      duplicate: rows.filter((r) => r.status === 'duplicate').length,
      suppressed: rows.filter((r) => r.status === 'suppressed').length,
      beforeStart: rows.filter((r) => r.status === 'before_start').length
    }
  }
}

export function commitImport(rows: ImportPreviewRow[]): ImportCommitResult {
  const account = accountByBank('HDFC')
  if (!account) throw new Error('HDFC account row is missing')
  const result: ImportCommitResult = { inserted: 0, duplicate: 0, suppressed: 0, budgetAlerts: [] }
  const run = getDb().transaction(() => {
    for (const r of rows) {
      if (r.status !== 'new') continue
      const out = insertTransaction(
        {
          accountId: account.id,
          postedAt: r.postedAt,
          amountPaise: r.amountPaise,
          direction: r.direction,
          payee: r.payee,
          vpa: r.vpa,
          narration: r.narration,
          refNo: r.refNo,
          channel: r.channel,
          source: 'statement',
          needsReview: r.uncertain === true
        },
        { fingerprint: r.fingerprint }
      )
      if (out.status === 'inserted') result.inserted++
      else if (out.status === 'duplicate') result.duplicate++
      else result.suppressed++
    }
  })
  run()
  result.budgetAlerts = checkBudgetsAndNotify()
  return result
}
