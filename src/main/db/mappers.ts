import type { Transaction, Category, Rule, Budget, Account } from '@shared/types'

// Row shapes as they come out of SQLite (snake_case, ints for booleans).
export interface TxnRow {
  id: number
  account_id: number
  posted_at: string
  amount_paise: number
  direction: 'debit' | 'credit'
  payee: string
  vpa: string | null
  narration: string
  ref_no: string | null
  channel: Transaction['channel']
  source: Transaction['source']
  fingerprint: string
  category_id: number | null
  note: string | null
  kind: Transaction['kind']
  needs_review: number
  email_uid: number | null
  created_at: string
  my_share_paise: number | null
  friend_id: number | null
}

export function toTransaction(r: TxnRow): Transaction {
  return {
    id: r.id,
    accountId: r.account_id,
    postedAt: r.posted_at,
    amountPaise: r.amount_paise,
    direction: r.direction,
    payee: r.payee,
    vpa: r.vpa,
    narration: r.narration,
    refNo: r.ref_no,
    channel: r.channel,
    source: r.source,
    fingerprint: r.fingerprint,
    categoryId: r.category_id,
    note: r.note,
    kind: r.kind,
    needsReview: r.needs_review === 1,
    emailUid: r.email_uid,
    createdAt: r.created_at,
    mySharePaise: r.my_share_paise,
    friendId: r.friend_id,
    categoryParts: []
  }
}

export interface CategoryRow {
  id: number
  name: string
  icon: string
  color: string
  sort_order: number
  needs_note: number
}
export function toCategory(r: CategoryRow): Category {
  return { id: r.id, name: r.name, icon: r.icon, color: r.color, sortOrder: r.sort_order, needsNote: r.needs_note === 1 }
}

export interface RuleRow {
  id: number
  priority: number
  field: Rule['field']
  match: Rule['match']
  pattern: string
  action: Rule['action']
  category_id: number | null
  enabled: number
}
export function toRule(r: RuleRow): Rule {
  return {
    id: r.id,
    priority: r.priority,
    field: r.field,
    match: r.match,
    pattern: r.pattern,
    action: r.action,
    categoryId: r.category_id,
    enabled: r.enabled === 1
  }
}

export interface BudgetRow {
  id: number
  scope: Budget['scope']
  category_id: number | null
  period: Budget['period']
  week_start: number
  limit_paise: number
  warn_pct: number
}
export function toBudget(r: BudgetRow): Budget {
  return {
    id: r.id,
    scope: r.scope,
    categoryId: r.category_id,
    period: r.period,
    weekStart: r.week_start,
    limitPaise: r.limit_paise,
    warnPct: r.warn_pct
  }
}

export interface AccountRow {
  id: number
  name: string
  bank: string
  last4: string | null
}
export function toAccount(r: AccountRow): Account {
  return { id: r.id, name: r.name, bank: r.bank, last4: r.last4 }
}
