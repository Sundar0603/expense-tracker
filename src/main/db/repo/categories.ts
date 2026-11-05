import { getDb } from '../connection'
import { toCategory, type CategoryRow } from '../mappers'
import type { Category, NewCategory } from '@shared/types'

export function listCategories(): Category[] {
  const rows = getDb()
    .prepare('SELECT id, name, icon, color, sort_order, needs_note FROM categories ORDER BY sort_order, name')
    .all() as CategoryRow[]
  return rows.map(toCategory)
}

export function createCategory(input: NewCategory): Category {
  const name = input.name.trim()
  const r = uniqueName(name, () =>
    getDb()
      .prepare('INSERT INTO categories (name, icon, color, sort_order, needs_note) VALUES (?, ?, ?, ?, ?)')
      .run(name, input.icon || '🏷️', input.color || '#8b8b8b', input.sortOrder ?? 0, input.needsNote ? 1 : 0)
  )
  return getCategory(Number(r.lastInsertRowid))
}

/** Names are unique (case-insensitive); turn the SQLite constraint error into a readable one. */
function uniqueName<T>(name: string, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if ((e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') throw new Error(`A category named "${name}" already exists`)
    throw e
  }
}

export function getCategory(id: number): Category {
  const row = getDb()
    .prepare('SELECT id, name, icon, color, sort_order, needs_note FROM categories WHERE id = ?')
    .get(id) as CategoryRow | undefined
  if (!row) throw new Error(`Category ${id} not found`)
  return toCategory(row)
}

export function updateCategory(id: number, patch: Partial<Omit<Category, 'id'>>): Category {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    params.push(patch.name.trim())
  }
  if (patch.icon !== undefined) {
    sets.push('icon = ?')
    params.push(patch.icon)
  }
  if (patch.color !== undefined) {
    sets.push('color = ?')
    params.push(patch.color)
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = ?')
    params.push(patch.sortOrder)
  }
  if (patch.needsNote !== undefined) {
    sets.push('needs_note = ?')
    params.push(patch.needsNote ? 1 : 0)
  }
  if (sets.length) {
    params.push(id)
    uniqueName(patch.name?.trim() ?? '', () => getDb().prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`).run(...params))
  }
  return getCategory(id)
}

export function deleteCategory(id: number): void {
  // transactions.category_id -> NULL, rules.category_id -> NULL, budgets rows cascade (schema).
  // An expense split across this category loses the whole split and goes back to uncategorized,
  // rather than its other categories quietly absorbing this part.
  const db = getDb()
  db.transaction(() => {
    const split = `SELECT txn_id FROM category_parts WHERE category_id = ?`
    db.prepare(`UPDATE transactions SET category_id = NULL WHERE id IN (${split})`).run(id)
    db.prepare(`DELETE FROM category_parts WHERE txn_id IN (${split})`).run(id)
    db.prepare('DELETE FROM categories WHERE id = ?').run(id)
  })()
}
