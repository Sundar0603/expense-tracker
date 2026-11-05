import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import * as XLSX from 'xlsx'
import { parseStatementRows, parseStatementText, type StatementTxn } from '../parsers/hdfc-statement'

export interface ReadResult {
  txns: StatementTxn[]
  skipped: number
  error?: string
  /** PDF only: the file is encrypted and no/incorrect password was given. */
  needsPassword?: boolean
}

export async function readStatementFile(path: string, password?: string): Promise<ReadResult> {
  const ext = extname(path).toLowerCase()
  const buf = readFileSync(path)
  if (ext === '.pdf') return readPdf(buf, password)
  if (['.xls', '.xlsx', '.csv', '.txt', '.xlsm'].includes(ext)) return readSheet(buf)
  return { txns: [], skipped: 0, error: `Unsupported file type ${ext}. Use the Excel/CSV or PDF statement from HDFC.` }
}

function readSheet(buf: Buffer): ReadResult {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true, raw: true })
  let best: ReadResult = { txns: [], skipped: 0, error: 'No sheet with transactions found' }
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name]
    if (!ws) continue
    const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: '' })
    const r = parseStatementRows(rows)
    if (!r.error && r.txns.length > best.txns.length) best = r
    else if (r.error && best.error && best.txns.length === 0) best = { ...best, error: r.error }
  }
  return best
}

async function readPdf(buf: Buffer, password?: string): Promise<ReadResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    password: password || undefined,
    useSystemFonts: true,
    disableFontFace: true
  })
  let doc
  try {
    doc = await task.promise
  } catch (e) {
    const err = e as { name?: string; code?: number; message?: string }
    if (err?.name === 'PasswordException') {
      return {
        txns: [],
        skipped: 0,
        needsPassword: true,
        error: err.code === 2 ? 'Incorrect password. HDFC PDF statements open with your numeric Customer ID.' : 'This PDF is password protected. HDFC statements open with your numeric Customer ID.'
      }
    }
    return { txns: [], skipped: 0, error: `Could not open PDF: ${err?.message ?? String(e)}` }
  }
  const lines: string[] = []
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const content = await page.getTextContent()
      lines.push(...linesFromTextItems(content.items as { str: string; transform: number[] }[]))
    }
  } finally {
    await doc.destroy()
  }
  return parseStatementText(lines)
}

/** Group text items by their y coordinate (rounded) into lines, left to right. */
export function linesFromTextItems(items: { str: string; transform: number[] }[]): string[] {
  const rows = new Map<number, { x: number; str: string }[]>()
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue
    const x = it.transform[4] ?? 0
    const y = Math.round((it.transform[5] ?? 0) / 2) * 2 // 2pt tolerance
    if (!rows.has(y)) rows.set(y, [])
    rows.get(y)!.push({ x, str: it.str })
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // top of page first (PDF y grows upwards)
    .map(([, cells]) => cells.sort((a, b) => a.x - b.x).map((c) => c.str).join(' ').replace(/\s+/g, ' ').trim())
}
