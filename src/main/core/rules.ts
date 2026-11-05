import type { Rule, RuleField } from '@shared/types'

export interface RuleSubject {
  payee: string
  vpa: string | null
  narration: string
}

export interface RuleOutcome {
  kind: 'expense' | 'ignored' | 'transfer'
  categoryId: number | null
  matchedRuleId: number | null
}

const regexCache = new Map<string, RegExp | null>()

function compile(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern)!
  let re: RegExp | null
  try {
    re = new RegExp(pattern, 'i')
  } catch {
    re = null
  }
  regexCache.set(pattern, re)
  return re
}

function fieldValues(subject: RuleSubject, field: RuleField): string[] {
  switch (field) {
    case 'payee':
      return [subject.payee]
    case 'vpa':
      return subject.vpa ? [subject.vpa] : []
    case 'narration':
      return [subject.narration]
    case 'any':
      return [subject.payee, subject.vpa ?? '', subject.narration]
  }
}

export function ruleMatches(rule: Rule, subject: RuleSubject): boolean {
  const values = fieldValues(subject, rule.field)
  if (rule.match === 'contains') {
    const needle = rule.pattern.toLowerCase()
    return values.some((v) => v.toLowerCase().includes(needle))
  }
  const re = compile(rule.pattern)
  if (!re) return false
  return values.some((v) => re.test(v))
}

/**
 * Apply rules in priority order (lower number = higher priority). The first matching
 * rule decides. `ignore` and `transfer` rules take the transaction out of expense totals.
 */
export function applyRules(rules: Rule[], subject: RuleSubject): RuleOutcome {
  const sorted = [...rules].filter((r) => r.enabled).sort((a, b) => a.priority - b.priority)
  for (const rule of sorted) {
    if (!ruleMatches(rule, subject)) continue
    switch (rule.action) {
      case 'ignore':
        return { kind: 'ignored', categoryId: rule.categoryId, matchedRuleId: rule.id }
      case 'transfer':
        return { kind: 'transfer', categoryId: rule.categoryId, matchedRuleId: rule.id }
      case 'categorize':
        return { kind: 'expense', categoryId: rule.categoryId, matchedRuleId: rule.id }
    }
  }
  return { kind: 'expense', categoryId: null, matchedRuleId: null }
}
