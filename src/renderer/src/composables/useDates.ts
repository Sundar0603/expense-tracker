import dayjs from 'dayjs'

export const todayISO = (): string => dayjs().format('YYYY-MM-DD')
export const nowLocalISO = (): string => dayjs().format('YYYY-MM-DDTHH:mm:ss')
export const thisMonth = (): string => dayjs().format('YYYY-MM')
export const monthLabel = (m: string): string => dayjs(`${m}-01`).format('MMMM YYYY')
export const shiftMonth = (m: string, delta: number): string => dayjs(`${m}-01`).add(delta, 'month').format('YYYY-MM')
export const fmtDate = (iso: string): string => dayjs(iso).format('DD MMM YYYY')
export const fmtDateTime = (iso: string): string => dayjs(iso).format('DD MMM YYYY, HH:mm')
export const fmtShort = (iso: string): string => dayjs(iso).format('DD MMM')
