import dayjs from 'dayjs'
import type { BudgetPeriod } from '@shared/types'

export interface Period {
  /** inclusive, YYYY-MM-DD */
  start: string
  /** exclusive, YYYY-MM-DD */
  end: string
  totalDays: number
  elapsedDays: number
  daysLeft: number
}

/**
 * Compute the current budget period containing `today`.
 * weekStart: 0 = Sunday … 6 = Saturday.
 */
export function currentPeriod(period: BudgetPeriod, weekStart: number, today = dayjs()): Period {
  const t = today.startOf('day')
  if (period === 'monthly') {
    const start = t.startOf('month')
    const end = start.add(1, 'month')
    return build(start, end, t)
  }
  const diff = (t.day() - weekStart + 7) % 7
  const start = t.subtract(diff, 'day')
  const end = start.add(7, 'day')
  return build(start, end, t)
}

function build(start: dayjs.Dayjs, end: dayjs.Dayjs, today: dayjs.Dayjs): Period {
  const totalDays = end.diff(start, 'day')
  const elapsedDays = today.diff(start, 'day') + 1 // today counts as elapsed
  return {
    start: start.format('YYYY-MM-DD'),
    end: end.format('YYYY-MM-DD'),
    totalDays,
    elapsedDays,
    daysLeft: totalDays - elapsedDays + 1 // today is still spendable
  }
}

/** Expected spend by now if the limit were spread evenly across the period. */
export function pacePaise(limitPaise: number, p: Period): number {
  return Math.round((limitPaise * p.elapsedDays) / p.totalDays)
}

/** How much can be spent per remaining day (including today) to stay within the limit. */
export function safeToSpendTodayPaise(limitPaise: number, spentPaise: number, p: Period): number {
  const remaining = limitPaise - spentPaise
  if (remaining <= 0) return 0
  return Math.floor(remaining / Math.max(1, p.daysLeft))
}
