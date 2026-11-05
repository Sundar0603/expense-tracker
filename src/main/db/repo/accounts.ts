import { getDb } from '../connection'
import { toAccount, type AccountRow } from '../mappers'
import type { Account } from '@shared/types'

export function listAccounts(): Account[] {
  const rows = getDb().prepare('SELECT id, name, bank, last4 FROM accounts ORDER BY id').all() as AccountRow[]
  return rows.map(toAccount)
}

export function accountByBank(bank: string): Account | null {
  const row = getDb().prepare('SELECT id, name, bank, last4 FROM accounts WHERE bank = ? LIMIT 1').get(bank) as
    | AccountRow
    | undefined
  return row ? toAccount(row) : null
}
