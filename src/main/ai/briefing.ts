import dayjs from 'dayjs'
import { formatINR } from '@shared/money'
import { dashboardStats } from '../db/repo/stats'
import { insightsData } from '../db/repo/insights'
import { budgetStatuses } from '../db/repo/budgets'
import { listCategories } from '../db/repo/categories'
import { listTransactions } from '../db/repo/transactions'
import { categoryLabel } from './tools'
import type { AiPrivacy } from '@shared/types'

/**
 * Deterministic statistics the app computes itself. In briefing mode this is all the model sees;
 * in tool mode it is the opening context so the model knows the shape of the data.
 */
export function buildBriefing(month: string, privacy: AiPrivacy, opts: { rowsFrom?: string; rowsTo?: string; maxRows?: number } = {}): string {
  const stats = dashboardStats(month)
  const ins = insightsData(month)
  const budgets = budgetStatuses()
  const cats = listCategories()
  const lines: string[] = []
  const label = dayjs(`${month}-01`).format('MMMM YYYY')
  lines.push(`# Spending briefing for ${label} (today is ${dayjs().format('YYYY-MM-DD')})`)
  const diff = stats.monthTotalPaise - stats.prevMonthTotalPaise
  lines.push(`Total expenses: ${formatINR(stats.monthTotalPaise)} across ${ins.expenseCount} transactions. Previous month: ${formatINR(stats.prevMonthTotalPaise)} (${diff >= 0 ? 'up' : 'down'} ${formatINR(Math.abs(diff))}${stats.prevMonthTotalPaise ? `, ${Math.round((Math.abs(diff) / stats.prevMonthTotalPaise) * 100)}%` : ''}).`)
  if (stats.uncategorized.count) lines.push(`Not included anywhere below: ${stats.uncategorized.count} uncategorized expenses (${formatINR(stats.uncategorized.totalPaise)}) the user has not reviewed yet.`)
  lines.push('All amounts below are exact; quote them verbatim and do not recompute.')
  if (ins.incomePaise) lines.push(`Income received: ${formatINR(ins.incomePaise)}. Transfers (not expenses): ${formatINR(ins.transferPaise)}. Ignored (investments etc.): ${formatINR(ins.ignoredPaise)}.`)
  if (ins.overallMonthlyBudgetPaise) lines.push(`Overall monthly budget: ${formatINR(ins.overallMonthlyBudgetPaise)}.`)
  lines.push('')
  lines.push('## By category (this month | last month | 3-month average)')
  for (const c of ins.comparison) {
    if (!c.currentPaise && !c.previousPaise) continue
    const delta = c.avg3Paise ? Math.round(((c.currentPaise - c.avg3Paise) / c.avg3Paise) * 100) : null
    lines.push(`- ${c.name}: ${formatINR(c.currentPaise)} (${c.count} txns) | ${formatINR(c.previousPaise)} | ${formatINR(c.avg3Paise)}${delta !== null ? ` | ${delta >= 0 ? '+' : ''}${delta}% vs avg` : ''}`)
  }
  lines.push('')
  lines.push('## Top payees this month')
  for (const p of stats.topPayees) lines.push(`- ${p.payee}: ${formatINR(p.totalPaise)} (${p.count})`)
  lines.push('')
  // Single transactions (date + payee + amount) are rows, so only in rows mode.
  if (privacy === 'rows') {
    lines.push('## Largest single expenses')
    for (const l of ins.largest) lines.push(`- ${dayjs(l.postedAt).format('DD MMM')}: ${l.payee} ${formatINR(l.amountPaise)} [${l.category}]`)
    lines.push('')
  }
  lines.push('## Spend by weekday (last 3 months)')
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  lines.push(ins.weekdays.map((w) => `${names[w.weekday]} ${formatINR(w.totalPaise)}`).join(', '))
  lines.push('')
  lines.push('## Monthly totals (last 12 months)')
  lines.push(ins.monthTotals.map((m) => `${m.month}: ${formatINR(m.totalPaise)}`).join('; '))
  if (budgets.length) {
    lines.push('')
    lines.push('## Budgets')
    for (const b of budgets) {
      const name = b.scope === 'overall' ? 'All spending' : (cats.find((c) => c.id === b.categoryId)?.name ?? 'Category')
      const remaining = b.limitPaise - b.spentPaise
      lines.push(`- ${name} (${b.period}): spent ${formatINR(b.spentPaise)} of ${formatINR(b.limitPaise)} (${b.pct}%), ${remaining >= 0 ? `${formatINR(remaining)} remaining` : `over by ${formatINR(-remaining)}`}, ${b.daysLeft} days left, safe to spend today ${formatINR(b.safeToSpendTodayPaise)}`)
    }
  }
  if (privacy === 'rows') {
    const from = opts.rowsFrom ?? dayjs(`${month}-01`).format('YYYY-MM-DD')
    const to = opts.rowsTo ?? dayjs(`${month}-01`).add(1, 'month').format('YYYY-MM-DD')
    const rows = listTransactions({ from, to, kind: 'expense', categorized: true, limit: opts.maxRows ?? 300 })
    lines.push('')
    lines.push(`## Transactions ${from} to ${to} (${rows.length} shown, newest first)`)
    for (const r of rows) {
      lines.push(`${r.postedAt.slice(0, 10)} | ${r.payee} | ${formatINR(r.mySharePaise ?? r.amountPaise)}${r.mySharePaise !== null ? ` (my share of a ${formatINR(r.amountPaise)} bill split with friends)` : ''} | ${categoryLabel(r, cats)}${r.note ? ` | ${r.note}` : ''}`)
    }
  } else {
    lines.push('')
    lines.push('(Individual transactions are not shared with the model; privacy mode is aggregates only.)')
  }
  return lines.join('\n')
}
