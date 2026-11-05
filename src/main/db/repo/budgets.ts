import dayjs from 'dayjs'
import { getDb } from '../connection'
import { toBudget, type BudgetRow } from '../mappers'
import { currentPeriod, safeToSpendTodayPaise } from '../../core/periods'
import type { Budget, BudgetStatus } from '@shared/types'

const COLS = 'id, scope, category_id, period, week_start, limit_paise, warn_pct'

export function listBudgets(): Budget[] {
  const rows = getDb().prepare(`SELECT ${COLS} FROM budgets ORDER BY scope DESC, id`).all() as BudgetRow[]
  return rows.map(toBudget)
}

export function getBudget(id: number): Budget {
  const row = getDb().prepare(`SELECT ${COLS} FROM budgets WHERE id = ?`).get(id) as BudgetRow | undefined
  if (!row) throw new Error(`Budget ${id} not found`)
  return toBudget(row)
}

export function createBudget(input: Omit<Budget, 'id'>): Budget {
  const r = getDb()
    .prepare(
      `INSERT INTO budgets (scope, category_id, period, week_start, limit_paise, warn_pct) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.scope,
      input.scope === 'category' ? input.categoryId : null,
      input.period,
      input.weekStart ?? 1,
      input.limitPaise,
      input.warnPct ?? 80
    )
  return getBudget(Number(r.lastInsertRowid))
}

export function updateBudget(id: number, patch: Partial<Omit<Budget, 'id'>>): Budget {
  const next = { ...getBudget(id), ...patch }
  getDb()
    .prepare(
      `UPDATE budgets SET scope = ?, category_id = ?, period = ?, week_start = ?, limit_paise = ?, warn_pct = ? WHERE id = ?`
    )
    .run(
      next.scope,
      next.scope === 'category' ? next.categoryId : null,
      next.period,
      next.weekStart,
      next.limitPaise,
      next.warnPct,
      id
    )
  return getBudget(id)
}

export function deleteBudget(id: number): void {
  getDb().prepare('DELETE FROM budgets WHERE id = ?').run(id)
}

export function budgetStatuses(today = dayjs()): BudgetStatus[] {
  const db = getDb()
  // Like every other figure: categorized expenses only, and a split expense counts each part in its category.
  const overall = db.prepare(`SELECT IFNULL(SUM(spend_paise), 0) AS s FROM expense_lines WHERE posted_at >= ? AND posted_at < ?`)
  const byCat = db.prepare(`SELECT IFNULL(SUM(spend_paise), 0) AS s FROM expense_lines WHERE category_id = ? AND posted_at >= ? AND posted_at < ?`)
  return listBudgets().map((b) => {
    const p = currentPeriod(b.period, b.weekStart, today)
    const spent =
      b.scope === 'overall'
        ? (overall.get(p.start, p.end) as { s: number }).s
        : (byCat.get(b.categoryId, p.start, p.end) as { s: number }).s
    const pct = Math.round((spent / b.limitPaise) * 100)
    const state: BudgetStatus['state'] = pct >= 100 ? 'over' : pct >= b.warnPct ? 'warn' : 'ok'
    return {
      ...b,
      periodStart: p.start,
      periodEnd: p.end,
      spentPaise: spent,
      pct,
      state,
      daysLeft: p.daysLeft,
      safeToSpendTodayPaise: safeToSpendTodayPaise(b.limitPaise, spent, p)
    }
  })
}
