// Thin re-export so tests can open/close the database without importing Electron.
export { openDatabase, closeDatabase, getDb } from './db/connection'
