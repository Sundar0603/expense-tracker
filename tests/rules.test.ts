import { describe, expect, it } from 'vitest'
import { applyRules } from '../src/main/core/rules'
import type { Rule } from '../src/shared/types'

const rule = (over: Partial<Rule>): Rule => ({
  id: 1, priority: 100, field: 'any', match: 'contains', pattern: '', action: 'categorize', categoryId: null, enabled: true, ...over
})

describe('applyRules', () => {
  it('ignores Zerodha payments', () => {
    const rules = [rule({ id: 1, priority: 10, pattern: 'zerodha', action: 'ignore' })]
    const out = applyRules(rules, { payee: 'ZERODHA BROKING LTD', vpa: 'zerodha@hdfcbank', narration: 'UPI-ZERODHA' })
    expect(out.kind).toBe('ignored')
    expect(out.matchedRuleId).toBe(1)
  })

  it('categorizes by VPA with regex and respects priority', () => {
    const rules = [
      rule({ id: 2, priority: 50, field: 'vpa', match: 'regex', pattern: 'swiggy|zomato', action: 'categorize', categoryId: 7 }),
      rule({ id: 3, priority: 10, field: 'payee', match: 'contains', pattern: 'swiggy instamart', action: 'categorize', categoryId: 9 })
    ]
    expect(applyRules(rules, { payee: 'Swiggy', vpa: 'swiggy@axisbank', narration: '' }).categoryId).toBe(7)
    expect(applyRules(rules, { payee: 'Swiggy Instamart', vpa: 'swiggy@axisbank', narration: '' }).categoryId).toBe(9)
  })

  it('skips disabled rules and invalid regexes', () => {
    const rules = [
      rule({ id: 4, pattern: 'uber', action: 'ignore', enabled: false }),
      rule({ id: 5, match: 'regex', pattern: '(unclosed', action: 'ignore' })
    ]
    const out = applyRules(rules, { payee: 'Uber', vpa: null, narration: 'uber (unclosed' })
    expect(out.kind).toBe('expense')
    expect(out.matchedRuleId).toBeNull()
  })

  it('marks self transfers', () => {
    const rules = [rule({ id: 6, field: 'narration', pattern: 'SELF TRANSFER', action: 'transfer' })]
    expect(applyRules(rules, { payee: 'Me', vpa: null, narration: 'IMPS SELF TRANSFER' }).kind).toBe('transfer')
  })
})
