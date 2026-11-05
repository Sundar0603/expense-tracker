import Database from 'better-sqlite3'
import { migrate } from './schema'

let db: Database.Database | null = null

export function openDatabase(filePath: string): Database.Database {
  if (db) return db
  db = new Database(filePath)
  // Rollback journal (not WAL) so deleted pages don't linger in a WAL file, and
  // secure_delete so freed content is overwritten with zeros inside the database file.
  db.pragma('journal_mode = DELETE')
  db.pragma('secure_delete = ON')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = FULL')
  migrate(db)
  return db
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not opened')
  return db
}

export function closeDatabase(): void {
  db?.close()
  db = null
}
