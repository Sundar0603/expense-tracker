import { describe, expect, it } from 'vitest'
import { parseStatementRows, parseStatementText } from '../src/main/parsers/hdfc-statement'

describe('parseStatementRows (CSV/XLS)', () => {
  it('finds the header below account details and parses rows', () => {
    const rows: unknown[][] = [
      ['HDFC BANK Ltd.'],
      ['Account No :', 'XXXXXXXX1234'],
      [],
      ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
      ['01/10/26', 'UPI-SWIGGY-swiggy@axisbank-UTIB0000001-528301234567-Payment from Ph', '0000528301234567', '01/10/26', '450.00', '', '99,550.00'],
      ['', 'one', '', '', '', '', ''],
      ['04/10/26', 'UPI-ZERODHA BROKING LTD-zerodha@hdfcbank-HDFC0000001-528304000111-Pay', '0000528304000111', '04/10/26', '15,000.00', '', '84,550.00'],
      ['10/10/26', 'NEFT CR-ICIC0000001-ZOHO CORP-SUNDAR-N280261234567890', 'N280261234567890', '10/10/26', '', '1,25,000.00', '2,09,550.00'],
      ['08/10/26', 'ATW-512967XXXXXX1234-S1ACNA01-CHENNAI', '0000000000001234', '08/10/26', '5000.00', '', '2,04,550.00'],
      ['*', 'STATEMENT SUMMARY'],
      ['Opening Balance', 'Dr Count', 'Cr Count', 'Debits', 'Credits', 'Closing Bal']
    ]
    const { txns, skipped, error } = parseStatementRows(rows)
    expect(error).toBeUndefined()
    expect(txns).toHaveLength(4)
    expect(txns[0]).toMatchObject({ postedAt: '2026-10-01T12:00:00', amountPaise: 45000, direction: 'debit', payee: 'SWIGGY', vpa: 'swiggy@axisbank', refNo: '528301234567', channel: 'upi' })
    // continuation line appended to narration
    expect(txns[0]!.narration.endsWith('Payment from Ph one')).toBe(true)
    expect(txns[2]).toMatchObject({ direction: 'credit', amountPaise: 12500000, payee: 'ZOHO CORP', channel: 'neft' })
    expect(txns[3]!.channel).toBe('atm')
    expect(skipped).toBeGreaterThanOrEqual(1)
  })

  it('reports when no header is found', () => {
    expect(parseStatementRows([['a', 'b'], ['c', 'd']]).error).toBeDefined()
  })

  it('accepts Excel numeric cells', () => {
    const rows: unknown[][] = [
      ['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
      ['02/10/2026', 'POS 5678 AMAZON PAY INDIA', '', '02/10/2026', 1299, null, 98251]
    ]
    const { txns } = parseStatementRows(rows)
    expect(txns[0]).toMatchObject({ amountPaise: 129900, direction: 'debit', payee: 'AMAZON PAY INDIA', channel: 'card' })
  })
})

describe('parseStatementText (PDF)', () => {
  it('derives direction from the balance delta and handles wrapped lines', () => {
    const lines = [
      'Statement of account',
      'Opening Balance 1,00,000.00',
      '01/10/26 UPI-SWIGGY-swiggy@axisbank-UTIB0000001-528301234567-Payment',
      'from Ph one 0000528301234567 01/10/26 450.00 99,550.00',
      '10/10/26 NEFT CR-ICIC0000001-ZOHO CORP-SUNDAR-N280261234567890 N280261234567890 10/10/26 1,25,000.00 2,24,550.00',
      'Page 1 of 1'
    ]
    const { txns, error } = parseStatementText(lines)
    expect(error).toBeUndefined()
    expect(txns).toHaveLength(2)
    expect(txns[0]).toMatchObject({ amountPaise: 45000, direction: 'debit', payee: 'SWIGGY', refNo: '528301234567' })
    expect(txns[1]).toMatchObject({ amountPaise: 12500000, direction: 'credit', payee: 'ZOHO CORP' })
  })

  it('stops at the statement summary and takes the opening balance from it', () => {
    const lines = [
      '10/10/26 NEFT CR-ICIC0000001-ZOHO CORP-SUNDAR-N280261234567890 N280261234567890 10/10/26 1,25,000.00 2,25,000.00',
      '11/10/26 UPI-SWIGGY-swiggy@axisbank-UTIB0000001-528301234567-Payment 0000528301234567 11/10/26 450.00 2,24,550.00',
      'Page 1 of 2',
      'STATEMENT SUMMARY :-',
      'Opening Balance Dr Count Cr Count Debits Credits Closing Bal',
      '1,00,000.00 1 1 450.00 1,25,000.00 2,24,550.00'
    ]
    const { txns } = parseStatementText(lines)
    expect(txns).toHaveLength(2)
    expect(txns[0]).toMatchObject({ direction: 'credit', amountPaise: 12500000, uncertain: false })
    expect(txns[1]).toMatchObject({ direction: 'debit', amountPaise: 45000 })
    expect(txns[1]!.narration).not.toMatch(/Opening|1,25,000/)
  })

  it('flags the first row when no opening balance exists anywhere', () => {
    const { txns } = parseStatementText(['10/10/26 NEFT CR-ICIC0000001-ZOHO CORP-X N2802612345 10/10/26 1,25,000.00 2,25,000.00'])
    expect(txns[0]!.uncertain).toBe(true)
  })
})
