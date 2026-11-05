import { getDb } from '../connection'
import { toRule, type RuleRow } from '../mappers'
import { ruleMatches } from '../../core/rules'
import type { Rule } from '@shared/types'

const COLS = 'id, priority, field, match, pattern, action, category_id, enabled'

export function listRules(): Rule[] {
  const rows = getDb().prepare(`SELECT ${COLS} FROM rules ORDER BY priority, id`).all() as RuleRow[]
  return rows.map(toRule)
}

export function getRule(id: number): Rule {
  const row = getDb().prepare(`SELECT ${COLS} FROM rules WHERE id = ?`).get(id) as RuleRow | undefined
  if (!row) throw new Error(`Rule ${id} not found`)
  return toRule(row)
}

export function createRule(input: Omit<Rule, 'id'>): Rule {
  validatePattern(input)
  const r = getDb()
    .prepare(
      `INSERT INTO rules (priority, field, match, pattern, action, category_id, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.priority ?? 100,
      input.field,
      input.match,
      input.pattern,
      input.action,
      input.action === 'categorize' ? input.categoryId : null,
      input.enabled === false ? 0 : 1
    )
  return getRule(Number(r.lastInsertRowid))
}

export function updateRule(id: number, patch: Partial<Omit<Rule, 'id'>>): Rule {
  const current = getRule(id)
  const next: Omit<Rule, 'id'> = { ...current, ...patch }
  validatePattern(next)
  getDb()
    .prepare(
      `UPDATE rules SET priority = ?, field = ?, match = ?, pattern = ?, action = ?, category_id = ?, enabled = ? WHERE id = ?`
    )
    .run(
      next.priority,
      next.field,
      next.match,
      next.pattern,
      next.action,
      next.action === 'categorize' ? next.categoryId : null,
      next.enabled ? 1 : 0,
      id
    )
  return getRule(id)
}

export function deleteRule(id: number): void {
  getDb().prepare('DELETE FROM rules WHERE id = ?').run(id)
}

export function previewRule(rule: Omit<Rule, 'id'>): number {
  validatePattern(rule)
  const rows = getDb().prepare('SELECT payee, vpa, narration FROM transactions').all() as {
    payee: string
    vpa: string | null
    narration: string
  }[]
  const full: Rule = { id: -1, ...rule, enabled: true }
  return rows.filter((r) => ruleMatches(full, r)).length
}

function validatePattern(rule: Omit<Rule, 'id'>): void {
  if (!rule.pattern.trim()) throw new Error('Pattern cannot be empty')
  if (rule.match === 'regex') {
    try {
      new RegExp(rule.pattern, 'i')
    } catch (e) {
      throw new Error(`Invalid regular expression: ${(e as Error).message}`)
    }
  }
  if (rule.action === 'categorize' && !rule.categoryId) {
    throw new Error('A categorize rule needs a category')
  }
}
