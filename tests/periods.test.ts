import { describe, expect, it } from 'vitest'
import dayjs from 'dayjs'
import { currentPeriod, pacePaise, safeToSpendTodayPaise } from '../src/main/core/periods'

describe('currentPeriod', () => {
  it('monthly period spans the calendar month', () => {
    const p = currentPeriod('monthly', 1, dayjs('2026-10-10'))
    expect(p.start).toBe('2026-10-01')
    expect(p.end).toBe('2026-11-01')
    expect(p.totalDays).toBe(31)
    expect(p.elapsedDays).toBe(10)
    expect(p.daysLeft).toBe(22)
  })

  it('weekly period starting Monday', () => {
    // 2026-10-10 is a Saturday
    const p = currentPeriod('weekly', 1, dayjs('2026-10-10'))
    expect(p.start).toBe('2026-10-05')
    expect(p.end).toBe('2026-10-12')
    expect(p.elapsedDays).toBe(6)
    expect(p.daysLeft).toBe(2)
  })

  it('weekly period starting Sunday', () => {
    const p = currentPeriod('weekly', 0, dayjs('2026-10-10'))
    expect(p.start).toBe('2026-10-04')
    expect(p.end).toBe('2026-10-11')
  })

  it('on the week start day the period begins today', () => {
    const p = currentPeriod('weekly', 1, dayjs('2026-10-12')) // Monday
    expect(p.start).toBe('2026-10-12')
    expect(p.elapsedDays).toBe(1)
    expect(p.daysLeft).toBe(7)
  })
})

describe('pace and safe-to-spend', () => {
  it('spreads the limit evenly', () => {
    const p = currentPeriod('monthly', 1, dayjs('2026-10-10'))
    expect(pacePaise(3100_00, p)).toBe(1000_00)
  })
  it('divides remaining budget across remaining days including today', () => {
    const p = currentPeriod('monthly', 1, dayjs('2026-10-10'))
    expect(safeToSpendTodayPaise(3100_00, 1000_00, p)).toBe(Math.floor(2100_00 / 22))
    expect(safeToSpendTodayPaise(3100_00, 4000_00, p)).toBe(0)
  })
})
