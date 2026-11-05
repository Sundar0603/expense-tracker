import { describe, expect, it } from 'vitest'
import { parseHdfcAlert, payeeFromNarration, payeeFromStoredAlert } from '../src/main/parsers/hdfc-email'

// Templates below are reconstructed from commonly seen HDFC InstaAlert wording.
// Replace/extend with real redacted samples from docs/samples/ when available.

describe('parseHdfcAlert', () => {
  it('parses a UPI debit alert', () => {
    const r = parseHdfcAlert({
      subject: '❗ You have done a UPI txn. Check details!',
      text: `Dear Customer,\n\nRs.450.00 has been debited from account **1234 to VPA swiggy@axisbank SWIGGY on 01-10-26.\n\nYour UPI transaction reference number is 528301234567.\n\nIf you did not authorize this transaction, please report it immediately by calling 18002586161.\n\nWarm Regards,\nHDFC Bank`,
      date: new Date('2026-10-01T09:12:30+05:30')
    })
    expect(r).not.toBeNull()
    expect(r!.amountPaise).toBe(45000)
    expect(r!.direction).toBe('debit')
    expect(r!.vpa).toBe('swiggy@axisbank')
    expect(r!.payee).toBe('SWIGGY')
    expect(r!.refNo).toBe('528301234567')
    expect(r!.channel).toBe('upi')
    expect(r!.postedAt.startsWith('2026-10-01')).toBe(true)
    expect(r!.confidence).toBe('high')
  })

  // Wording from alerts@hdfcbank.bank.in (October 2026); names and numbers are made up.
  it('parses the 2026 "towards VPA id (Name)" UPI template', () => {
    const text = (vpa: string, name: string): string =>
      `HDFC BANK --> Dear Customer, Greetings from HDFC Bank! Rs.40.00 is debited from your account ending 1234 towards VPA ${vpa} (${name}) on 11-10-26. UPI transaction reference no.: 528412345678. If you did not authorize this transaction, please report it.`
    const date = new Date('2026-10-11T20:27:00+05:30')
    const a = parseHdfcAlert({ subject: 'You have done a UPI txn. Check details!', text: text('paytm.s2t668h@pty', 'Asha Stores'), date })!
    expect(a.payee).toBe('Asha Stores')
    expect(a.vpa).toBe('paytm.s2t668h@pty')
    expect(a.confidence).toBe('high')
    expect(a.refNo).toBe('528412345678')
    expect(a.postedAt).toBe('2026-10-11T20:27:00')
    const b = parseHdfcAlert({ subject: 'You have done a UPI txn. Check details!', text: text('zudioaunitoftrentlim.42691537@hdfcbank', 'ZUDIO A UNIT OF TRENT LIMITED'), date })!
    expect(b.payee).toBe('ZUDIO A UNIT OF TRENT LIMITED')
    expect(b.vpa).toBe('zudioaunitoftrentlim.42691537@hdfcbank')
  })

  it('repairs a payee from stored alert text', () => {
    const stored = 'HDFC BANK --> Dear Customer, Greetings from HDFC Bank! Rs.86.00 is debited from your account ending 1234 towards VPA swiggydinein@icici (Swiggy Diners) on 10-10-26. UPI transaction reference no.: 5284'
    expect(payeeFromStoredAlert(stored, 'debit', 'swiggydinein@icici', 'upi')).toEqual({ payee: 'Swiggy Diners', confident: true })
  })

  it('parses the generic account update template with Info narration', () => {
    const r = parseHdfcAlert({
      subject: 'View: Account update for your HDFC Bank A/c',
      text: `Dear Customer, Update: INR 15,000.00 debited from HDFC Bank XX1234 on 04-OCT-26. Info: UPI-ZERODHA BROKING LTD-zerodha@hdfcbank-HDFC0000001-528304000111-Payment. Avl bal:INR 1,00,000.00. Not you? Call 18002586161.`,
      date: new Date('2026-10-04T13:00:00+05:30')
    })
    expect(r!.amountPaise).toBe(1500000)
    expect(r!.direction).toBe('debit')
    expect(r!.payee).toBe('ZERODHA BROKING LTD')
    expect(r!.vpa).toBe('zerodha@hdfcbank')
    expect(r!.refNo).toBe('528304000111')
    expect(r!.narration).toContain('UPI-ZERODHA BROKING LTD')
    expect(r!.postedAt).toBe('2026-10-04T13:00:00')
    expect(r!.accountLast4).toBe('1234')
  })

  it('parses a debit card spend', () => {
    const r = parseHdfcAlert({
      subject: 'Alert : Update on your HDFC Bank Debit Card',
      text: `Dear Customer, Thank you for using HDFC Bank Debit Card XX5678 for Rs 899.00 at NETFLIX.COM on 03-10-2026 21:30:15. Avl bal Rs 50,000.00`,
      date: new Date('2026-10-03T21:31:00+05:30')
    })
    expect(r!.amountPaise).toBe(89900)
    expect(r!.direction).toBe('debit')
    expect(r!.payee).toBe('NETFLIX.COM')
    expect(r!.channel).toBe('card')
    expect(r!.postedAt).toBe('2026-10-03T21:30:15')
  })

  it('parses an IMPS debit with reference', () => {
    const r = parseHdfcAlert({
      subject: 'Alert: IMPS transaction',
      text: `Dear Customer, Rs. 25000.00 is debited from A/c XXXX1234 for IMPS txn to RAJESH K on 06-10-26 11:00:02. IMPS Ref No 628012345678. Avl bal: Rs 75,000.00`,
      date: null
    })
    expect(r!.amountPaise).toBe(2500000)
    expect(r!.payee).toBe('RAJESH K')
    expect(r!.refNo).toBe('628012345678')
    expect(r!.channel).toBe('imps')
    expect(r!.postedAt).toBe('2026-10-06T11:00:02')
  })

  it('parses a salary credit', () => {
    const r = parseHdfcAlert({
      subject: 'Credit alert',
      text: `Dear Customer, Rs. 1,25,000.00 credited to a/c XXXXX1234 on 10-10-26 by a/c linked to NEFT. Info: NEFT CR-ICIC0000001-ZOHO CORPORATION PVT LTD-SUNDAR-N280261234567890. Avl bal: Rs 2,00,000.00`,
      date: null
    })
    expect(r!.amountPaise).toBe(12500000)
    expect(r!.direction).toBe('credit')
    expect(r!.payee).toBe('ZOHO CORPORATION PVT LTD')
    expect(r!.channel).toBe('neft')
  })

  it('parses an ATM withdrawal', () => {
    const r = parseHdfcAlert({
      subject: 'Alert: ATM withdrawal',
      text: `Dear Customer, Rs 5000.00 has been withdrawn from A/c XX1234 using Debit Card XX5678 at HDFC BANK ATM ANNA NAGAR on 08-10-26 12:00:00. Avl bal Rs 1000.00`,
      date: null
    })
    expect(r!.channel).toBe('atm')
    expect(r!.payee).toBe('ATM withdrawal')
    expect(r!.amountPaise).toBe(500000)
  })

  it('flags unknown payee as low confidence rather than dropping', () => {
    const r = parseHdfcAlert({
      subject: 'Account update',
      text: `Update: INR 350.00 debited from HDFC Bank XX1234 on 09-OCT-26. Avl bal: INR 999.00`,
      date: new Date('2026-10-09T22:00:00+05:30')
    })
    expect(r).not.toBeNull()
    expect(r!.confidence).toBe('low')
    expect(r!.payee).toBe('Unknown')
  })

  it('ignores OTP and promotional mails', () => {
    expect(parseHdfcAlert({ subject: 'OTP for NetBanking login', text: 'Your OTP is 123456. Valid for 5 minutes.' })).toBeNull()
    expect(parseHdfcAlert({ subject: 'Exciting offers on your card', text: 'Get 10% off at partner stores this festive season.' })).toBeNull()
  })

  it('falls back to HTML when there is no text part', () => {
    const r = parseHdfcAlert({
      subject: 'UPI txn',
      html: `<html><body><p>Dear Customer,</p><p>Rs.120.00 has been debited from account **1234 to VPA q12345@ybl TEA STALL on 08-10-26.</p><p>Your UPI transaction reference number is 528399887766.</p></body></html>`
    })
    expect(r!.amountPaise).toBe(12000)
    expect(r!.payee).toBe('TEA STALL')
  })
})

describe('payeeFromNarration', () => {
  it('handles statement-style narrations', () => {
    expect(payeeFromNarration('UPI-SWIGGY-swiggy@axisbank-UTIB0000001-528301-Payment')).toBe('SWIGGY')
    expect(payeeFromNarration('NEFT CR-ICIC0000001-ZOHO CORP-SUNDAR-N2802612345')).toBe('ZOHO CORP')
    expect(payeeFromNarration('POS 1234 AMAZON PAY INDIA')).toBe('AMAZON PAY INDIA')
    expect(payeeFromNarration('ACH D- INDIAN CLEARING CORP-1234567')).toBe('INDIAN CLEARING CORP')
  })
})
