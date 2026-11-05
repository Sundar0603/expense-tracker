/** Format paise as Indian rupees with lakh/crore grouping, e.g. 1,23,456.00 */
export function formatINR(paise: number, opts: { compact?: boolean; sign?: boolean } = {}): string {
  const rupees = paise / 100
  if (opts.compact) {
    const abs = Math.abs(rupees)
    if (abs >= 1e7) return `${sign(rupees, opts.sign)}₹${(abs / 1e7).toFixed(2)}Cr`
    if (abs >= 1e5) return `${sign(rupees, opts.sign)}₹${(abs / 1e5).toFixed(2)}L`
    if (abs >= 1e3) return `${sign(rupees, opts.sign)}₹${(abs / 1e3).toFixed(1)}k`
  }
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Math.abs(rupees))
  return `${sign(rupees, opts.sign)}₹${formatted}`
}

function sign(v: number, show?: boolean): string {
  if (v < 0) return '-'
  return show && v > 0 ? '+' : ''
}

/** Parse a user-entered rupee string ("1,234.50", "₹ 500") into paise. */
export function parseRupees(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null
  return Math.round(parseFloat(cleaned) * 100)
}
