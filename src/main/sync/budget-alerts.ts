import { Notification } from 'electron'
import { budgetStatuses } from '../db/repo/budgets'
import { listCategories } from '../db/repo/categories'
import { getSetting, setSetting } from '../db/repo/settings'
import { formatINR } from '@shared/money'

/**
 * Compare budgets against spend; return messages for any budget that newly crossed its
 * warning or limit this period. Each (budget, period, state) alerts once. Shows a macOS
 * notification when the notify_budget setting is on.
 */
export function checkBudgetsAndNotify(): string[] {
  const notify = getSetting('notify_budget') === '1'
  const cats = new Map(listCategories().map((c) => [c.id, c]))
  const messages: string[] = []
  for (const s of budgetStatuses()) {
    if (s.state === 'ok') continue
    const key = `alerted:${s.id}:${s.periodStart}:${s.state}`
    if (getSetting(key)) continue
    setSetting(key, new Date().toISOString())
    const label = s.scope === 'overall' ? 'All spending' : (cats.get(s.categoryId ?? -1)?.name ?? 'Category')
    const msg =
      s.state === 'over'
        ? `${label}: over the ${s.period} limit by ${formatINR(s.spentPaise - s.limitPaise)} (${formatINR(s.spentPaise)} of ${formatINR(s.limitPaise)})`
        : `${label}: ${s.pct}% of the ${s.period} limit used (${formatINR(s.spentPaise)} of ${formatINR(s.limitPaise)})`
    messages.push(msg)
    if (notify && Notification.isSupported()) {
      new Notification({ title: s.state === 'over' ? 'Budget exceeded' : 'Budget warning', body: msg }).show()
    }
  }
  return messages
}
