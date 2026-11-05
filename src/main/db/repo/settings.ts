import { getDb } from '../connection'

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

/** Everything except secrets and internal salts. */
export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const out: Record<string, string> = {}
  for (const r of rows) {
    if (r.key === 'suppression_salt') continue
    if (r.key.startsWith('secret:')) continue
    out[r.key] = r.value
  }
  return out
}
