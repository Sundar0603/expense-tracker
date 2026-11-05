import { describe, expect, it } from 'vitest'
import { computeFingerprint, suppressionHash } from '../src/main/core/fingerprint'

describe('computeFingerprint', () => {
  it('uses the bank reference number when present', () => {
    const fp = computeFingerprint({
      refNo: '528312345678',
      postedDate: '2026-10-10',
      amountPaise: 50000,
      direction: 'debit',
      narration: 'UPI-SWIGGY-swiggy@axisbank'
    })
    expect(fp).toBe('ref:528312345678:debit:50000')
  })

  it('falls back to a hash of date, amount, direction and normalized narration', () => {
    const a = computeFingerprint({ postedDate: '2026-10-10', amountPaise: 1999, direction: 'debit', narration: 'POS 1234 AMAZON   PAY' })
    const b = computeFingerprint({ postedDate: '2026-10-10', amountPaise: 1999, direction: 'debit', narration: 'pos-1234 amazon pay' })
    const c = computeFingerprint({ postedDate: '2026-10-11', amountPaise: 1999, direction: 'debit', narration: 'POS 1234 AMAZON PAY' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.startsWith('h:')).toBe(true)
  })

  it('email and statement rows for the same UPI payment collapse together', () => {
    const fromEmail = computeFingerprint({ refNo: '600123456789', postedDate: '2026-10-09', amountPaise: 12000, direction: 'debit', narration: 'Paid to Zomato via UPI' })
    const fromStatement = computeFingerprint({ refNo: '600123456789', postedDate: '2026-10-09', amountPaise: 12000, direction: 'debit', narration: 'UPI-ZOMATO-zomato@paytm-600123456789' })
    expect(fromEmail).toBe(fromStatement)
  })
})

describe('suppressionHash', () => {
  it('is deterministic for a salt and reveals nothing about the fingerprint', () => {
    const h1 = suppressionHash('ref:528312345678:debit:50000', 'salt')
    const h2 = suppressionHash('ref:528312345678:debit:50000', 'salt')
    const h3 = suppressionHash('ref:528312345678:debit:50000', 'other-salt')
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    expect(h1).not.toContain('5283')
  })
})
