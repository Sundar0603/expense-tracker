import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import type { Channel, Direction } from '@shared/types'

dayjs.extend(customParseFormat)

/**
 * Parser for HDFC Bank InstaAlert emails. HDFC uses several templates (UPI, debit card,
 * NEFT/IMPS, ACH/standing instruction, ATM, credits, generic "Account update"). Rather than
 * one regex per template, we extract each field with a ranked list of patterns and report a
 * confidence so the app can route uncertain parses to "Needs review" instead of dropping them.
 *
 * Expect to tune the pattern lists against real samples in docs/samples/.
 */
export interface ParsedAlert {
  amountPaise: number
  direction: Direction
  /** local time, YYYY-MM-DDTHH:mm:ss */
  postedAt: string
  payee: string
  vpa: string | null
  narration: string
  refNo: string | null
  channel: Channel
  accountLast4: string | null
  confidence: 'high' | 'low'
}

export interface AlertInput {
  subject?: string | null
  text?: string | null
  html?: string | null
  /** Email Date header or IMAP internal date, used when the body has no date. */
  date?: Date | null
}

const NON_TXN_SUBJECT = /\b(OTP|one time password|statement|e-?statement|offer|reward|cashback|invitation|KYC|password|welcome|survey|feedback|newsletter|promo)\b/i
const DEBIT_WORDS = /\b(debited|spent|withdrawn|paid|purchase|sent|debit of|has been debited|is debited)\b/i
const CREDIT_WORDS = /\b(credited|received|deposited|credit of|has been credited|is credited|refund)\b/i
const AMOUNT = /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{1,2})?)/i

export function normalizeBody(input: AlertInput): string {
  let text = (input.text ?? '').trim()
  if (!text && input.html) text = stripHtml(input.html)
  return text.replace(/ /g, ' ').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
}

export function parseHdfcAlert(input: AlertInput): ParsedAlert | null {
  const subject = input.subject ?? ''
  const body = normalizeBody(input)
  if (!body) return null
  if (NON_TXN_SUBJECT.test(subject) && !AMOUNT.test(body)) return null
  if (/one time password|OTP for/i.test(body) && !DEBIT_WORDS.test(body)) return null

  const flat = body.replace(/\n/g, ' ')
  const amountPaise = extractAmount(flat)
  if (amountPaise === null) return null

  const direction = extractDirection(flat)
  if (!direction) return null

  const narration = extractNarration(flat)
  const vpa = vpaFromNarration(narration) ?? extractVpa(flat)
  const refNo = extractRef(flat, narration)
  const channel = detectChannel(flat, vpa, narration)
  const { payee, confident } = extractPayee(flat, narration, vpa, channel, direction)
  const postedAt = extractDate(flat, input.date ?? null)
  const accountLast4 = extractLast4(flat)

  return {
    amountPaise,
    direction,
    postedAt,
    payee,
    vpa,
    narration: narration ?? flat.slice(0, 200),
    refNo,
    channel,
    accountLast4,
    confidence: confident ? 'high' : 'low'
  }
}

function extractAmount(flat: string): number | null {
  // Prefer the amount nearest a direction keyword; fall back to the first amount.
  const m = flat.match(AMOUNT)
  if (!m) return null
  const idxAvl = flat.search(/avl(?:\.|ailable)? bal/i)
  let candidate = m
  if (idxAvl >= 0 && m.index !== undefined && m.index > idxAvl) {
    // first amount is after "Avl bal" -> unusual; keep anyway
    candidate = m
  }
  const n = Number(candidate[1]!.replace(/,/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100)
}

function extractDirection(flat: string): Direction | null {
  const d = flat.search(DEBIT_WORDS)
  const c = flat.search(CREDIT_WORDS)
  if (d < 0 && c < 0) {
    // Card templates: "Thank you for using HDFC Bank Debit Card XX1234 for Rs 899.00 at MERCHANT on ..."
    if (/\b(using|used)\b[^.]*\bcard\b[^.]*\b(for|at)\b/i.test(flat)) return 'debit'
    return null
  }
  if (d < 0) return 'credit'
  if (c < 0) return 'debit'
  return d <= c ? 'debit' : 'credit'
}

function extractNarration(flat: string): string | null {
  const m = flat.match(/\bInfo:?\s*([^.]+?)(?=\.\s|\. ?Avl|\s+Avl\b|$)/i)
  if (m) return m[1]!.trim()
  return null
}

/** In "UPI-NAME-handle@psp-IFSC-ref-remark" the VPA is the dash-separated part containing '@'. */
function vpaFromNarration(narration: string | null): string | null {
  if (!narration) return null
  const part = narration.split('-').find((p) => /^[a-z0-9._]+@[a-z][a-z0-9]+$/i.test(p.trim()))
  return part ? part.trim().toLowerCase() : null
}

function extractVpa(s: string): string | null {
  // VPA handle@psp — the PSP part has no dot, which excludes ordinary email addresses.
  const re = /\b([a-z0-9][a-z0-9._-]{1,}@[a-z][a-z0-9]{1,})(?![a-z0-9.])/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const v = m[1]!.toLowerCase()
    if (v.endsWith('@hdfcbank') && /^(alerts|info|noreply|no-reply)/.test(v)) continue
    return v
  }
  return null
}

function extractRef(flat: string, narration: string | null): string | null {
  const patterns = [
    /reference (?:number|no\.?) is[:\s]*([A-Z0-9]{6,})/i,
    /UPI (?:Ref(?:erence)? No\.?|txn (?:ref|id))[:\s]*([A-Z0-9]{6,})/i,
    /IMPS Ref(?:erence)? No\.?[:\s]*([A-Z0-9]{6,})/i,
    /NEFT (?:Ref(?:erence)?|UTR)(?: No\.?)?[:\s]*([A-Z0-9]{6,})/i,
    /\bUTR[:\s]*([A-Z0-9]{6,})/i,
    /\bRef(?:erence)?(?: No\.?| number| #)?[:\s]*([A-Z0-9]{8,})/i,
    /transaction (?:id|number)[:\s]*([A-Z0-9]{6,})/i
  ]
  for (const p of patterns) {
    const m = flat.match(p)
    if (m) return m[1]!
  }
  if (narration) {
    // UPI-NAME-vpa@bank-IFSC-123456789012-remark  -> the 12-digit numeric part
    const m = narration.match(/-(\d{12})(?:-|$)/)
    if (m) return m[1]!
    const n = narration.match(/\b(\d{12,})\b/)
    if (n) return n[1]!
  }
  return null
}

function detectChannel(flat: string, vpa: string | null, narration: string | null): Channel {
  const s = `${flat} ${narration ?? ''}`
  if (/\bATM\b|withdrawn/i.test(s)) return 'atm'
  if (/\bUPI\b/i.test(s) || vpa) return 'upi'
  if (/\bIMPS\b/i.test(s)) return 'imps'
  if (/\bNEFT\b|\bRTGS\b/i.test(s)) return 'neft'
  if (/\b(ACH|NACH|SI|standing instruction|mandate|auto ?pay|autodebit|e-?mandate|EMI)\b/i.test(s)) return 'ach'
  if (/\bcard\b/i.test(s)) return 'card'
  return 'other'
}

function extractPayee(
  flat: string,
  narration: string | null,
  vpa: string | null,
  channel: Channel,
  direction: Direction
): { payee: string; confident: boolean } {
  const tryPatterns = (patterns: RegExp[]): string | null => {
    for (const p of patterns) {
      const m = flat.match(p)
      if (m && m[1] && m[1].trim().length >= 2) return clean(m[1])
    }
    return null
  }

  if (channel === 'atm') return { payee: 'ATM withdrawal', confident: true }

  // 2026 template: "... towards VPA paytm.s2t668h@pty (Suresh Kumar) on 11-10-26." The bracketed
  // name is the merchant or person as registered with UPI, which beats anything derived from the ID.
  const vpaName = tryPatterns([
    direction === 'debit'
      ? /\b(?:to|towards)\s+VPA\s+[a-z0-9._-]+@[a-z0-9.]+\s*\(([^)]+)\)/i
      : /\b(?:by|from)\s+(?:a\/c linked to\s+)?VPA\s+[a-z0-9._-]+@[a-z0-9.]+\s*\(([^)]+)\)/i,
    /\bVPA\s+[a-z0-9._-]+@[a-z0-9.]+\s*\(([^)]+)\)/i
  ])
  if (vpaName) return { payee: vpaName, confident: true }

  if (direction === 'debit') {
    const direct = tryPatterns([
      /to VPA [a-z0-9._-]+@[a-z0-9]+\s+([A-Z][^.]*?)\s+on\s+\d/i,
      /to VPA [a-z0-9._-]+@[a-z0-9]+\s*\(([^)]+)\)/i,
      /\bto\s+([A-Z][A-Za-z0-9&'.,\- ]{1,60}?)\s+on\s+\d/,
      /\bat\s+([A-Z][A-Za-z0-9&'.,\- ]{1,60}?)\s+on\s+\d/,
      /\bfor\s+(?:a |an )?(?:purchase|txn|transaction)?\s*(?:at|to)\s+([A-Z][A-Za-z0-9&'.,\- ]{1,60}?)\s+on\s+\d/i,
      // Not "towards VPA x": without the bracketed name that would capture the raw UPI ID.
      /\btowards\s+(?!VPA\b)([A-Z][A-Za-z0-9&'.,\- ]{1,60}?)(?:\s+on\s+\d|\.|,)/i
    ])
    if (direct) return { payee: direct, confident: true }
  } else {
    const direct = tryPatterns([
      /by\s+(?:a\/c linked to )?VPA [a-z0-9._-]+@[a-z0-9]+\s*\(?([A-Z][^.)]*?)\)?\s*(?:on\s+\d|\.|$)/i,
      /\bfrom\s+([A-Z][A-Za-z0-9&'.,\- ]{1,60}?)\s+(?:on\s+\d|\.|,)/,
      /\bby\s+([A-Z][A-Za-z0-9&'.,\- ]{1,60}?)\s+(?:on\s+\d|\.|,)/
    ])
    if (direct) return { payee: direct, confident: true }
  }

  if (narration) {
    const fromNarration = payeeFromNarration(narration)
    if (fromNarration) return { payee: fromNarration, confident: true }
  }
  if (vpa) return { payee: vpa.split('@')[0]!, confident: false }
  return { payee: 'Unknown', confident: false }
}

/** "UPI-SWIGGY-swiggy@axisbank-UTIB0000001-528301-Payment" -> "SWIGGY"; "NEFT CR-ICIC0001-ZOHO CORP-..." -> "ZOHO CORP" */
/**
 * Re-derive the payee from the alert text stored on an email transaction, so rows imported with
 * an older parser can be repaired without fetching the mail again.
 */
export function payeeFromStoredAlert(text: string, direction: Direction, vpa: string | null, channel: Channel): { payee: string; confident: boolean } {
  const flat = text.replace(/\n/g, ' ')
  return extractPayee(flat, extractNarration(flat), vpa, channel, direction)
}

export function payeeFromNarration(narration: string): string | null {
  const n = narration.trim()
  let m = n.match(/^UPI[-\/]([^-]+)-/i)
  if (m) return clean(m[1]!)
  m = n.match(/^(?:IMPS|NEFT|RTGS)[-\s](?:CR|DR)?[-\s]*(?:[A-Z]{4}0[A-Z0-9]{6}[-\s]+)?([A-Za-z][^-]{1,60})/i)
  if (m) return clean(m[1]!)
  m = n.match(/^POS\s+\d*\s*([A-Za-z][^-]{1,60})/i)
  if (m) return clean(m[1]!)
  m = n.match(/^(?:ACH|NACH)\s*[-\/]?\s*(?:D|DR|DEBIT)?[-\s]*([A-Za-z][^-]{1,60})/i)
  if (m) return clean(m[1]!)
  m = n.match(/^([A-Za-z][A-Za-z0-9&'. ]{2,60})/)
  if (m) return clean(m[1]!)
  return null
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/[\s.,;:\-]+$/g, '').trim()
}

function extractDate(flat: string, fallback: Date | null): string {
  const months = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec'
  const timeRe = /(\d{1,2}):(\d{2})(?::(\d{2}))?/
  const candidates: { re: RegExp; fmt: (m: RegExpMatchArray) => dayjs.Dayjs }[] = [
    {
      re: new RegExp(`\\b(\\d{1,2})-(${months})-(\\d{2,4})\\b`, 'i'),
      fmt: (m) => dayjs(`${pad(m[1]!)} ${mon(m[2]!)} ${year(m[3]!)}`, 'DD MMM YYYY', true)
    },
    {
      re: /\b(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})\b/,
      fmt: (m) => dayjs(`${pad(m[1]!)}/${pad(m[2]!)}/${year(m[3]!)}`, 'DD/MM/YYYY', true)
    },
    {
      re: new RegExp(`\\b(\\d{1,2})\\s+(${months})[a-z]*,?\\s+(\\d{4})\\b`, 'i'),
      fmt: (m) => dayjs(`${pad(m[1]!)} ${mon(m[2]!)} ${m[3]}`, 'DD MMM YYYY', true)
    }
  ]
  for (const c of candidates) {
    const m = flat.match(c.re)
    if (!m) continue
    const d = c.fmt(m)
    if (!d.isValid()) continue
    // time, if it appears shortly after the date
    const tail = flat.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 20)
    const t = tail.match(timeRe)
    const withTime = t ? d.hour(Number(t[1])).minute(Number(t[2])).second(Number(t[3] ?? 0)) : fallbackTime(d, fallback)
    return withTime.format('YYYY-MM-DDTHH:mm:ss')
  }
  return (fallback ? dayjs(fallback) : dayjs()).format('YYYY-MM-DDTHH:mm:ss')
}

function fallbackTime(d: dayjs.Dayjs, fallback: Date | null): dayjs.Dayjs {
  if (fallback) {
    const f = dayjs(fallback)
    if (f.format('YYYY-MM-DD') === d.format('YYYY-MM-DD')) return d.hour(f.hour()).minute(f.minute()).second(f.second())
  }
  return d.hour(12).minute(0).second(0)
}

function year(y: string): string {
  return y.length === 2 ? `20${y}` : y
}
function pad(n: string): string {
  return n.padStart(2, '0')
}
function mon(m: string): string {
  const t = m.slice(0, 3).toLowerCase()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

function extractLast4(flat: string): string | null {
  const m = flat.match(/(?:A\/c|account|Card|XX|\*\*)\s*(?:no\.?|number)?\s*[Xx*]*(\d{4})\b/i)
  return m ? m[1]! : null
}
