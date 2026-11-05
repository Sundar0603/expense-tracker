import dayjs from 'dayjs'
import { getDb } from '../connection'
import { listBudgets } from './budgets'
import { uncategorizedExpenses } from './stats'
import type { InsightsData, MonthlyTotal } from '@shared/types'

// Spending figures read expense_lines (schema v4); see stats.ts.

export function insightsData(month: string): InsightsData {
  const db = getDb()
  const start = dayjs(`${month}-01`)
  const end = start.add(1, 'month')
  const s = start.format('YYYY-MM-DD')
  const e = end.format('YYYY-MM-DD')
  const prevS = start.subtract(1, 'month').format('YYYY-MM-DD')
  const avgS = start.subtract(3, 'month').format('YYYY-MM-DD')

  const catRows = db
    .prepare(
      `SELECT c.id AS categoryId, c.name, c.color,
         IFNULL(SUM(CASE WHEN l.posted_at >= ? AND l.posted_at < ? THEN l.spend_paise END), 0) AS currentPaise,
         IFNULL(SUM(CASE WHEN l.posted_at >= ? AND l.posted_at < ? THEN 1 END), 0) AS count,
         IFNULL(SUM(CASE WHEN l.posted_at >= ? AND l.posted_at < ? THEN l.spend_paise END), 0) AS previousPaise,
         IFNULL(SUM(CASE WHEN l.posted_at >= ? AND l.posted_at < ? THEN l.spend_paise END), 0) / 3 AS avg3Paise
       FROM expense_lines l JOIN categories c ON c.id = l.category_id
       WHERE l.posted_at >= ? AND l.posted_at < ?
       GROUP BY l.category_id ORDER BY currentPaise DESC`
    )
    .all(s, e, s, e, prevS, s, avgS, s, avgS, e) as InsightsData['comparison']

  const weekdayRows = db
    .prepare(
      `SELECT CAST(strftime('%w', posted_at) AS INTEGER) AS weekday, SUM(spend_paise) AS totalPaise, COUNT(DISTINCT txn_id) AS count
       FROM expense_lines WHERE posted_at >= ? AND posted_at < ? GROUP BY weekday`
    )
    .all(avgS, e) as InsightsData['weekdays']
  const weekdays = Array.from({ length: 7 }, (_, i) => weekdayRows.find((w) => w.weekday === i) ?? { weekday: i, totalPaise: 0, count: 0 })

  const daily = db
    .prepare(`SELECT substr(posted_at, 1, 10) AS day, SUM(spend_paise) AS t FROM expense_lines WHERE posted_at >= ? AND posted_at < ? GROUP BY day ORDER BY day`)
    .all(s, e) as { day: string; t: number }[]
  const dailyMap = new Map(daily.map((d) => [d.day, d.t]))
  const daysInMonth = end.diff(start, 'day')
  const lastDay = month === dayjs().format('YYYY-MM') ? dayjs().date() : daysInMonth
  let running = 0
  const cumulative: InsightsData['cumulative'] = []
  for (let d = 1; d <= lastDay; d++) {
    const day = start.date(d).format('YYYY-MM-DD')
    running += dailyMap.get(day) ?? 0
    cumulative.push({ day, cumulativePaise: running })
  }

  const twelveStart = end.subtract(12, 'month').format('YYYY-MM-DD')
  const monthlyByCategory = db
    .prepare(
      `SELECT substr(l.posted_at, 1, 7) AS month, l.category_id AS categoryId, c.name, c.color, SUM(l.spend_paise) AS totalPaise
       FROM expense_lines l JOIN categories c ON c.id = l.category_id
       WHERE l.posted_at >= ? AND l.posted_at < ? GROUP BY month, l.category_id ORDER BY month`
    )
    .all(twelveStart, e) as InsightsData['monthlyByCategory']
  const monthTotals = db
    .prepare(`SELECT substr(posted_at, 1, 7) AS month, SUM(spend_paise) AS totalPaise FROM expense_lines WHERE posted_at >= ? AND posted_at < ? GROUP BY month ORDER BY month`)
    .all(twelveStart, e) as MonthlyTotal[]

  const overall = listBudgets().find((b) => b.scope === 'overall' && b.period === 'monthly')
  // One direction per kind: a transfer out and the same money coming back is not ₹2x moved.
  const sumKind = db.prepare(`SELECT IFNULL(SUM(amount_paise), 0) AS t FROM transactions WHERE kind = ? AND direction = ? AND posted_at >= ? AND posted_at < ?`)
  const incomePaise = (sumKind.get('income', 'credit', s, e) as { t: number }).t
  const transferPaise = (sumKind.get('transfer', 'debit', s, e) as { t: number }).t
  const ignoredPaise = (sumKind.get('ignored', 'debit', s, e) as { t: number }).t
  const expenseCount = (db.prepare(`SELECT COUNT(DISTINCT txn_id) AS n FROM expense_lines WHERE posted_at >= ? AND posted_at < ?`).get(s, e) as { n: number }).n
  // Whole expenses; a split one is labelled with all its categories.
  const largest = db
    .prepare(
      `SELECT l.payee, SUM(l.spend_paise) AS amountPaise, l.posted_at AS postedAt, group_concat(c.name, ' + ') AS category
       FROM expense_lines l JOIN categories c ON c.id = l.category_id
       WHERE l.posted_at >= ? AND l.posted_at < ? GROUP BY l.txn_id ORDER BY amountPaise DESC LIMIT 5`
    )
    .all(s, e) as InsightsData['largest']

  return {
    month,
    comparison: catRows,
    weekdays,
    cumulative,
    monthlyByCategory,
    monthTotals,
    overallMonthlyBudgetPaise: overall?.limitPaise ?? null,
    incomePaise,
    transferPaise,
    ignoredPaise,
    expenseCount,
    largest,
    uncategorized: uncategorizedExpenses(s, e)
  }
}
