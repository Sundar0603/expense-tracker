import dayjs from 'dayjs'
import { getSetting } from '../db/repo/settings'

/**
 * The date (YYYY-MM-DD) from which bank data is tracked. Email alerts and
 * statement rows posted before this day are skipped. Defaults to the first
 * day of the current month so a fresh install starts clean.
 */
export function trackingStart(): string {
  const stored = getSetting('tracking_start')
  if (stored && /^\d{4}-\d{2}-\d{2}$/.test(stored)) return stored
  return dayjs().startOf('month').format('YYYY-MM-DD')
}

export function isBeforeTrackingStart(postedAt: string): boolean {
  return postedAt.slice(0, 10) < trackingStart()
}
