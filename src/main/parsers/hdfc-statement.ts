import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import type { Channel, Direction } from '@shared/types'
import { payeeFromNarration } from './hdfc-email'

dayjs.extend(customParseFormat)

/**
 * HDFC Bank account statement parsing. Two inputs:
 *  - tabular rows (from CSV / XLS via SheetJS): columns Date, Narration, Chq./Ref.No., Value Dt,
 *    Withdrawal Amt., Deposit Amt., Closing Balance. Header row position varies (account details
 *    sit above it), so we locate it by name.
 *  - text lines (from PDF): each transaction is a line starting with a date; whether the amount is a
 *    withdrawal or a deposit is decided from the change in closing balance.
 */
export interface StatementTxn {
  postedAt: string // YYYY-MM-DDT12:00:00 (statements carry no time)
  narration: string
  refNo: string | null
  amountPaise: number
  direction: Direction
  closingBalancePaise: number | null
  payee: string
  vpa: string | null
  channel: Channel
  /** Direction was a guess (first PDF row with no opening balance anywhere). */
  uncertain?: boolean
}

const DATE_FORMATS = ['DD/MM/YY', 'DD/MM/YYYY', 'DD-MM-YY', 'DD-MM-YYYY', 'DD-MMM-YY', 'DD-MMM-YYYY', 'YYYY-MM-DD']

export function parseStatementDate(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) return dayjs(v).format('YYYY-MM-DD')
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Excel serial date
    // Excel serials are day counts from 1899-12-30 in local time; avoid UTC shifting the day.
    const d = new Date(1899, 11, 30)
    d.setDate(d.getDate() + Math.floor(v))
    return dayjs(d).format('YYYY-MM-DD')
  }
  const s = String(v ?? '').trim()
  if (!s) return null
  for (const f of DATE_FORMATS) {
    const d = dayjs(s, f, true)
    if (d.isValid()) return d.format('YYYY-MM-DD')
  }
  return null
}

export function parseAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null
  const s = String(v ?? '').replace(/[,\s₹]/g, '').replace(/^Rs\.?/i, '')
  if (!s || s === '-' ) return null
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  return Math.round(Number(s) * 100)
}

interface ColumnMap {
  date: number
  narration: number
  ref: number | null
  withdrawal: number
  deposit: number
  balance: number | null
}

function findHeader(rows: unknown[][]): { index: number; map: ColumnMap } | null {
  for (let i = 0; i < Math.min(rows.length, 60); i++) {
    const cells = (rows[i] ?? []).map((c) => String(c ?? '').toLowerCase().trim())
    const date = cells.findIndex((c) => /^(txn |transaction )?date$/.test(c) || c === 'date')
    const narration = cells.findIndex((c) => /narration|description|particulars/.test(c))
    const withdrawal = cells.findIndex((c) => /withdrawal|debit/.test(c))
    const deposit = cells.findIndex((c) => /deposit|credit/.test(c))
    if (date >= 0 && narration >= 0 && withdrawal >= 0 && deposit >= 0) {
      const ref = cells.findIndex((c) => /chq|ref|cheque/.test(c))
      const balance = cells.findIndex((c) => /balance/.test(c))
      return { index: i, map: { date, narration, ref: ref >= 0 ? ref : null, withdrawal, deposit, balance: balance >= 0 ? balance : null } }
    }
  }
  return null
}

export function parseStatementRows(rows: unknown[][]): { txns: StatementTxn[]; skipped: number; error?: string } {
  const header = findHeader(rows)
  if (!header) return { txns: [], skipped: 0, error: 'Could not find the header row (Date, Narration, Withdrawal, Deposit). Is this an HDFC statement export?' }
  const { map } = header
  const txns: StatementTxn[] = []
  let skipped = 0
  for (let i = header.index + 1; i < rows.length; i++) {
    const r = rows[i] ?? []
    const date = parseStatementDate(r[map.date])
    if (!date) {
      // continuation lines of a wrapped narration are appended to the previous txn
      const text = String(r[map.narration] ?? '').trim()
      const last = txns[txns.length - 1]
      if (text && last && r.every((c, idx) => idx === map.narration || String(c ?? '').trim() === '')) {
        last.narration = `${last.narration} ${text}`.trim()
        last.payee = payeeFromNarration(last.narration) ?? last.payee
        continue
      }
      if (r.some((c) => String(c ?? '').trim() !== '')) skipped++
      continue
    }
    const narration = String(r[map.narration] ?? '').trim()
    const w = parseAmount(r[map.withdrawal])
    const d = parseAmount(r[map.deposit])
    const amountPaise = w && w > 0 ? w : d && d > 0 ? d : null
    if (!amountPaise) {
      skipped++
      continue
    }
    const direction: Direction = w && w > 0 ? 'debit' : 'credit'
    const refRaw = map.ref !== null ? String(r[map.ref] ?? '').trim() : ''
    txns.push(buildTxn(date, narration, refRaw, amountPaise, direction, map.balance !== null ? parseAmount(r[map.balance]) : null))
  }
  return { txns, skipped }
}

/**
 * PDF statements come as text lines. A transaction line looks like:
 *   01/10/26 UPI-SWIGGY-swiggy@axisbank-UTIB0000001-528301-Payment 0000528301234567 01/10/26 450.00 12,345.00
 * Wrapped narrations spill onto following lines without a date. Direction comes from the balance delta.
 */
export function parseStatementText(lines: string[], openingBalancePaise: number | null = null): { txns: StatementTxn[]; skipped: number; error?: string } {
  const dateRe = /^(\d{2}\/\d{2}\/\d{2,4})\s+(.*)$/
  const txns: StatementTxn[] = []
  let prevBalance = openingBalancePaise
  let skipped = 0
  let pending: { date: string; rest: string } | null = null
  // HDFC prints the opening balance in the STATEMENT SUMMARY at the end, on the line after its label.
  let summaryOpening: number | null = null
  let expectOpening = false
  let ended = false

  const flush = (): void => {
    if (!pending) return
    const parsed = parsePdfLine(pending.date, pending.rest, prevBalance)
    if (parsed) {
      txns.push(parsed)
      prevBalance = parsed.closingBalancePaise
    } else skipped++
    pending = null
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (!line) continue
    if (expectOpening) {
      const n = line.match(/-?[\d,]*\d\.\d{2}/)
      if (n) {
        summaryOpening = parseAmount(n[0])
        expectOpening = false
      }
    }
    if (/opening balance/i.test(line)) {
      const ob = line.match(/opening balance[^\d-]*(-?[\d,]+\.\d{2})/i)
      if (ob) {
        if (prevBalance === null && txns.length === 0 && !pending) prevBalance = parseAmount(ob[1])
        else summaryOpening ??= parseAmount(ob[1])
      } else expectOpening = true
    }
    // Everything after the summary is totals, not narration; page footers are noise.
    if (/statement summary/i.test(line)) {
      flush()
      ended = true
    }
    if (ended || /^page \d+ of \d+$/i.test(line)) continue
    const m = line.match(dateRe)
    if (m) {
      flush()
      pending = { date: m[1]!, rest: m[2]! }
    } else if (pending) {
      // continuation: narration wrapped, or trailing numbers on next line
      pending.rest = `${pending.rest} ${line}`
    }
  }
  flush()
  if (txns.length === 0) return { txns, skipped, error: 'No transaction lines found in the PDF text.' }
  const first = txns[0]!
  if (first.uncertain && summaryOpening !== null && first.closingBalancePaise !== null) {
    first.direction = first.closingBalancePaise < summaryOpening ? 'debit' : 'credit'
    first.uncertain = false
  }
  return { txns, skipped }
}

function parsePdfLine(dateStr: string, rest: string, prevBalance: number | null): StatementTxn | null {
  const date = parseStatementDate(dateStr)
  if (!date) return null
  // Trailing numbers: [amount] [balance], possibly preceded by a value date and a ref number.
  const nums = [...rest.matchAll(/(-?[\d,]*\d\.\d{2})(?=\s|$)/g)].map((x) => ({ text: x[1]!, index: x.index! }))
  if (nums.length < 1) return null
  const balanceTok = nums[nums.length - 1]!
  const amountTok = nums.length >= 2 ? nums[nums.length - 2]! : null
  const closing = parseAmount(balanceTok.text)
  const amountPaise = amountTok ? parseAmount(amountTok.text) : null
  if (!amountPaise || amountPaise <= 0 || closing === null) return null
  let direction: Direction
  let uncertain = false
  if (prevBalance !== null) direction = closing < prevBalance ? 'debit' : 'credit'
  else {
    // First row and no opening balance seen yet: the summary may supply it later (see caller).
    direction = 'debit'
    uncertain = true
  }
  let head = rest.slice(0, amountTok!.index).trim()
  // strip trailing value date and ref number
  head = head.replace(/\s+\d{2}\/\d{2}\/\d{2,4}$/, '')
  let refNo: string | null = null
  const refM = head.match(/\s+(\d{6,}|[A-Z0-9]{10,})$/)
  if (refM) {
    refNo = refM[1]!.replace(/^0+/, '') || refM[1]!
    head = head.slice(0, refM.index).trim()
  }
  const txn = buildTxn(date, head, refNo ?? '', amountPaise, direction, closing)
  if (uncertain) txn.uncertain = true
  return txn
}

function buildTxn(date: string, narration: string, refRaw: string, amountPaise: number, direction: Direction, closing: number | null): StatementTxn {
  const vpaPart = narration.split('-').find((p) => /^[a-z0-9._]+@[a-z][a-z0-9]+$/i.test(p.trim()))
  const vpa = vpaPart ? vpaPart.trim().toLowerCase() : null
  let refNo: string | null = refRaw.replace(/^0+/, '') || null
  if (!refNo) {
    const m = narration.match(/-(\d{12})(?:-|$)/)
    if (m) refNo = m[1]!
  }
  return {
    postedAt: `${date}T12:00:00`,
    narration,
    refNo,
    amountPaise,
    direction,
    closingBalancePaise: closing,
    payee: payeeFromNarration(narration) ?? narration.slice(0, 40) ?? 'Unknown',
    vpa,
    channel: detectChannel(narration, vpa)
  }
}

function detectChannel(narration: string, vpa: string | null): Channel {
  const n = narration.toUpperCase()
  if (n.startsWith('UPI') || vpa) return 'upi'
  if (/^(ATW|ATM|NWD|EAW)/.test(n) || /ATM/.test(n)) return 'atm'
  if (n.startsWith('POS') || /\bPOS\b|\bECOM\b|\bCARD\b/.test(n)) return 'card'
  if (n.startsWith('IMPS')) return 'imps'
  if (n.startsWith('NEFT') || n.startsWith('RTGS')) return 'neft'
  if (/^(ACH|NACH|SI\b|EMI|MANDATE)/.test(n) || /\bACH\b|\bNACH\b/.test(n)) return 'ach'
  return 'other'
}
