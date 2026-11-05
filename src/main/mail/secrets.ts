import { safeStorage } from 'electron'
import { getSetting, setSetting } from '../db/repo/settings'
import { getDb } from '../db/connection'

/**
 * Secrets (Gmail app password, AI keys) are encrypted with Electron's safeStorage, which on
 * macOS uses the login Keychain, and the ciphertext is stored in the settings table under a
 * `secret:` key. getAllSettings() never returns `secret:` keys.
 */
export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

export function setSecret(name: string, value: string): void {
  if (!encryptionAvailable()) throw new Error('Keychain encryption is not available on this Mac')
  const blob = safeStorage.encryptString(value).toString('base64')
  setSetting(`secret:${name}`, blob)
}

export function getSecret(name: string): string | null {
  const blob = getSetting(`secret:${name}`)
  if (!blob) return null
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'))
  } catch {
    return null
  }
}

export function deleteSecret(name: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(`secret:${name}`)
}
