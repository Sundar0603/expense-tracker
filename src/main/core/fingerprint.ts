import { createHash } from 'node:crypto'

/**
 * A stable identity for a bank transaction so that the same transaction seen via
 * email alert and via statement import collapses to one row.
 *
 * Preference order:
 *  1. A bank reference number (UPI/IMPS/NEFT ref) - globally unique per transaction.
 *  2. Otherwise date + amount + normalized narration.
 */
export function computeFingerprint(input: {
  refNo?: string | null
  postedDate: string // YYYY-MM-DD
  amountPaise: number
  direction: 'debit' | 'credit'
  narration: string
}): string {
  const ref = (input.refNo ?? '').trim()
  if (ref.length >= 6) {
    return `ref:${ref}:${input.direction}:${input.amountPaise}`
  }
  const norm = input.narration.toUpperCase().replace(/[^A-Z0-9@]+/g, ' ').trim()
  return `h:${sha256(`${input.postedDate}|${input.amountPaise}|${input.direction}|${norm}`)}`
}

/**
 * What we keep after a traceless delete: a salted hash of the fingerprint. It lets
 * re-sync skip the transaction without storing anything that reveals amount, date or payee.
 */
export function suppressionHash(fingerprint: string, salt: string): string {
  return sha256(`${salt}|${fingerprint}`)
}

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}
