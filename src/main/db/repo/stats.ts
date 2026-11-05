import dayjs from 'dayjs'
import { getDb } from '../connection'
import type { DashboardStats, UncategorizedTotal } from '@shared/types'

// Every figure reads expense_lines (schema v4): categorized expenses only, the user's share of a
// bill split with friends, and an expense split across categories once per part. A transaction
// count is COUNT(DISTINCT txn_id), since a split expense has several lines.

export function dashboardStats(month: string): DashboardStats {
  const db = getDb()
  const start = dayjs(`${month}-01`)
  const end = start.add(1, 'month')
  const prevStart = start.subtract(1, 'month')
  const s = start.format('YYYY-MM-DD')
  const e = end.format('YYYY-MM-DD')

  const sum = db.prepare(`SELECT IFNULL(SUM(spend_paise), 0) AS s, COUNT(DISTINCT txn_id) AS n FROM expense_lines WHERE posted_at >= ? AND posted_at < ?`)
  const cur = sum.get(s, e) as { s: number; n: number }
  const prevMonthTotalPaise = (sum.get(prevStart.format('YYYY-MM-DD'), s) as { s: number }).s

  const byCategory = db
    .prepare(
      `SELECT l.category_id AS categoryId, c.name, c.color, SUM(l.spend_paise) AS totalPaise, COUNT(*) AS count
       FROM expense_lines l JOIN categories c ON c.id = l.category_id
       WHERE l.posted_at >= ? AND l.posted_at < ?
       GROUP BY l.category_id ORDER BY totalPaise DESC`
    )
    .all(s, e) as DashboardStats['byCategory']

  const daily = db
    .prepare(
      `SELECT substr(posted_at, 1, 10) AS day, SUM(spend_paise) AS totalPaise FROM expense_lines
       WHERE posted_at >= ? AND posted_at < ? GROUP BY day ORDER BY day`
    )
    .all(s, e) as DashboardStats['daily']

  const monthly = db
    .prepare(
      `SELECT substr(posted_at, 1, 7) AS month, SUM(spend_paise) AS totalPaise FROM expense_lines
       WHERE posted_at >= ? AND posted_at < ? GROUP BY month ORDER BY month`
    )
    .all(end.subtract(12, 'month').format('YYYY-MM-DD'), e) as DashboardStats['monthly']

  const topPayees = db
    .prepare(
      `SELECT payee, SUM(spend_paise) AS totalPaise, COUNT(DISTINCT txn_id) AS count FROM expense_lines
       WHERE posted_at >= ? AND posted_at < ? GROUP BY payee ORDER BY totalPaise DESC LIMIT 8`
    )
    .all(s, e) as DashboardStats['topPayees']

  const needsReviewCount = (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE needs_review = 1').get() as { n: number }).n

  return {
    monthTotalPaise: cur.s,
    monthCount: cur.n,
    prevMonthTotalPaise,
    byCategory,
    daily,
    monthly,
    topPayees,
    needsReviewCount,
    uncategorized: uncategorizedExpenses(s, e)
  }
}

/** What the figures leave out: expenses in [from, to) that have no category yet. */
export function uncategorizedExpenses(from: string, to: string): UncategorizedTotal {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS count, IFNULL(SUM(spend_paise), 0) AS totalPaise FROM transactions
       WHERE kind = 'expense' AND direction = 'debit' AND category_id IS NULL AND posted_at >= ? AND posted_at < ?`
    )
    .get(from, to) as UncategorizedTotal
}
