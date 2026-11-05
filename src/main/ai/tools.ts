import { tool, zodSchema } from 'ai'
import { z } from 'zod'
import dayjs from 'dayjs'
import { getDb } from '../db/connection'
import { listCategories } from '../db/repo/categories'
import { budgetStatuses } from '../db/repo/budgets'
import { listTransactions } from '../db/repo/transactions'
import type { AiPrivacy, Category, Transaction } from '@shared/types'
import { formatINR } from '@shared/money'

/** Amounts go to the model both as a number and pre-formatted, so small models don't have to do Indian digit grouping themselves. */
const money = (paise: number) => ({ rupees: paise / 100, formatted: formatINR(paise) })

// Spending figures read expense_lines (schema v4): categorized expenses only (uncategorized ones are
// not reviewed yet, so the model never sees them), the user's share of a bill split with friends, and
// an expense split across categories once per part.

/** "Food", or "Food ₹891.04 + Entertainment ₹476.28" for an expense split across categories. */
export function categoryLabel(t: Transaction, cats: Category[]): string {
  const name = (id: number | null) => cats.find((c) => c.id === id)?.name ?? 'Uncategorized'
  if (!t.categoryParts.length) return name(t.categoryId)
  return t.categoryParts.map((p) => `${name(p.categoryId)} ${formatINR(p.amountPaise)}`).join(' + ')
}
const dateRange = {
  from: z.string().describe('inclusive start date YYYY-MM-DD'),
  to: z.string().describe('exclusive end date YYYY-MM-DD')
}

function categoryId(name?: string | null): number | null | undefined {
  if (!name) return undefined
  const c = listCategories().find((x) => x.name.toLowerCase() === name.toLowerCase())
  if (!c) throw new Error(`Unknown category "${name}". Known: ${listCategories().map((x) => x.name).join(', ')}`)
  return c.id
}

/** Read-only, parameterised queries. The model never writes SQL. */
export function makeTools(privacy: AiPrivacy) {
  const db = getDb()
  return {
    list_categories: tool({
      description: 'List the user-defined expense categories.',
      inputSchema: zodSchema(z.object({})),
      execute: async () => listCategories().map((c) => c.name)
    }),
    sum_expenses: tool({
      description: 'Total expenses (in rupees) in a date range, optionally for one category and/or payees whose name contains a text.',
      inputSchema: zodSchema(z.object({ ...dateRange, category: z.string().nullable().default(null).describe('exact category name, or null for all'), payeeContains: z.string().nullable().default(null) })),
      execute: async ({ from, to, category, payeeContains }) => {
        const cid = categoryId(category)
        const clauses = ['posted_at >= ?', 'posted_at < ?']
        const params: unknown[] = [from, to]
        if (cid !== undefined) {
          clauses.push('category_id = ?')
          params.push(cid)
        }
        if (payeeContains) {
          clauses.push('payee LIKE ?')
          params.push(`%${payeeContains}%`)
        }
        const r = db.prepare(`SELECT IFNULL(SUM(spend_paise), 0) AS t, COUNT(DISTINCT txn_id) AS n FROM expense_lines WHERE ${clauses.join(' AND ')}`).get(...params) as { t: number; n: number }
        return { total: money(r.t), count: r.n, from, to }
      }
    }),
    breakdown_by_category: tool({
      description: 'Expenses per category (rupees) in a date range.',
      inputSchema: zodSchema(z.object(dateRange)),
      execute: async ({ from, to }) => {
        const rows = db
          .prepare(
            `SELECT c.name AS category, SUM(l.spend_paise) AS t, COUNT(*) AS n FROM expense_lines l
             JOIN categories c ON c.id = l.category_id WHERE l.posted_at >= ? AND l.posted_at < ? GROUP BY l.category_id ORDER BY t DESC`
          )
          .all(from, to) as { category: string; t: number; n: number }[]
        return rows.map((r) => ({ category: r.category, total: money(r.t), count: r.n }))
      }
    }),
    breakdown_by_month: tool({
      description: 'Monthly expense totals (rupees) in a date range, optionally for one category.',
      inputSchema: zodSchema(z.object({ ...dateRange, category: z.string().nullable().default(null).describe('exact category name, or null for all') })),
      execute: async ({ from, to, category }) => {
        const cid = categoryId(category)
        const rows = db
          .prepare(
            `SELECT substr(posted_at, 1, 7) AS month, SUM(spend_paise) AS t, COUNT(DISTINCT txn_id) AS n FROM expense_lines
             WHERE posted_at >= ? AND posted_at < ? ${cid !== undefined ? 'AND category_id = ?' : ''} GROUP BY month ORDER BY month`
          )
          .all(...(cid !== undefined ? [from, to, cid] : [from, to])) as { month: string; t: number; n: number }[]
        return rows.map((r) => ({ month: r.month, total: money(r.t), count: r.n }))
      }
    }),
    top_payees: tool({
      description: 'Payees ranked by total spend (rupees) in a date range.',
      inputSchema: zodSchema(z.object({ ...dateRange, limit: z.number().int().min(1).max(50).default(10), category: z.string().nullable().default(null).describe('exact category name, or null for all') })),
      execute: async ({ from, to, limit, category }) => {
        const cid = categoryId(category)
        const rows = db
          .prepare(
            `SELECT payee, SUM(spend_paise) AS t, COUNT(DISTINCT txn_id) AS n FROM expense_lines WHERE posted_at >= ? AND posted_at < ?
             ${cid !== undefined ? 'AND category_id = ?' : ''} GROUP BY payee ORDER BY t DESC LIMIT ?`
          )
          .all(...(cid !== undefined ? [from, to, cid, limit] : [from, to, limit])) as { payee: string; t: number; n: number }[]
        return rows.map((r) => ({ payee: r.payee, total: money(r.t), count: r.n }))
      }
    }),
    largest_expenses: tool({
      description:
        privacy === 'rows'
          ? 'The largest individual expenses in a date range (date, payee, amount, category).'
          : 'Not available in aggregates-only privacy mode; use top_payees for payee totals instead.',
      inputSchema: zodSchema(z.object({ ...dateRange, limit: z.number().int().min(1).max(20).default(5) })),
      execute: async ({ from, to, limit }) => {
        if (privacy !== 'rows') return { error: 'Individual transactions are not shared in aggregates-only privacy mode. You can report payee totals via top_payees.' }
        const rows = db
          .prepare(
            `SELECT l.posted_at, l.payee, SUM(l.spend_paise) AS spend_paise, group_concat(c.name, ' + ') AS category
             FROM expense_lines l JOIN categories c ON c.id = l.category_id
             WHERE l.posted_at >= ? AND l.posted_at < ? GROUP BY l.txn_id ORDER BY spend_paise DESC LIMIT ?`
          )
          .all(from, to, limit) as { posted_at: string; payee: string; spend_paise: number; category: string }[]
        return rows.map((r) => ({ date: r.posted_at.slice(0, 10), payee: r.payee, amount: money(r.spend_paise), category: r.category }))
      }
    }),
    budget_status: tool({
      description: 'Current status of every budget: limit, spent, percent, days left.',
      inputSchema: zodSchema(z.object({})),
      execute: async () => {
        const cats = listCategories()
        return budgetStatuses().map((b) => ({
          name: b.scope === 'overall' ? 'All spending' : (cats.find((c) => c.id === b.categoryId)?.name ?? 'Category'),
          period: b.period,
          limit: money(b.limitPaise),
          spent: money(b.spentPaise),
          remaining: money(Math.max(0, b.limitPaise - b.spentPaise)),
          percent: b.pct,
          daysLeft: b.daysLeft,
          state: b.state,
          safeToSpendToday: money(b.safeToSpendTodayPaise)
        }))
      }
    }),
    list_transactions: tool({
      description:
        privacy === 'rows'
          ? 'List individual expense transactions in a date range, optionally filtered by category or payee text. Max 200.'
          : 'Not available: the user has restricted sharing to aggregates. Use the sum/breakdown tools instead.',
      inputSchema: zodSchema(z.object({ ...dateRange, category: z.string().nullable().default(null).describe('exact category name, or null for all'), payeeContains: z.string().nullable().default(null), limit: z.number().int().min(1).max(200).default(50) })),
      execute: async ({ from, to, category, payeeContains, limit }) => {
        if (privacy !== 'rows') return { error: 'Individual transactions are not shared in aggregates-only privacy mode. Answer with totals instead.' }
        const cid = categoryId(category)
        const cats = listCategories()
        const rows = listTransactions({ from, to, kind: 'expense', categoryId: cid === undefined ? undefined : cid, categorized: true, search: payeeContains, limit })
        return rows.map((r) => ({ date: r.postedAt.slice(0, 10), payee: r.payee, amount: money(r.mySharePaise ?? r.amountPaise), splitBillTotal: r.mySharePaise !== null ? money(r.amountPaise) : undefined, category: categoryLabel(r, cats), note: r.note ?? undefined }))
      }
    })
  }
}

export function systemPrompt(privacy: AiPrivacy): string {
  return [
    'You are a personal-finance assistant inside a local expense tracker for one person in India.',
    'Tool results include each amount as `formatted` (e.g. ₹1,430.00). Copy formatted amounts verbatim; never re-format or recompute them, and never do arithmetic you can get from a tool.',
    `Today is ${dayjs().format('dddd, D MMMM YYYY')}. "This month" means ${dayjs().startOf('month').format('YYYY-MM-DD')} to ${dayjs().add(1, 'month').startOf('month').format('YYYY-MM-DD')} (exclusive); "last month" means ${dayjs().subtract(1, 'month').startOf('month').format('YYYY-MM-DD')} to ${dayjs().startOf('month').format('YYYY-MM-DD')}. Weeks start on Monday unless told otherwise.`,
    'Use the tools to get numbers; never guess figures. When a question is ambiguous about the period, assume the current month and say so.',
    'Be concise and concrete: lead with the number, then one or two useful observations. Avoid moralising.',
    privacy === 'rows' ? 'You may quote individual transactions when useful.' : 'You only have aggregate statistics; do not claim to know individual transactions.'
  ].join(' ')
}
