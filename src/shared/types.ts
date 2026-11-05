// Types shared between the Electron main process and the Vue renderer.

export type Direction = 'debit' | 'credit'
export type Channel = 'upi' | 'card' | 'neft' | 'imps' | 'ach' | 'atm' | 'cash' | 'manual' | 'other'
export type Source = 'email' | 'statement' | 'manual'
/** settlement: a friend paying back their share of a split bill. Neither income nor expense. */
export type TxnKind = 'expense' | 'transfer' | 'income' | 'ignored' | 'settlement'

export interface Account {
  id: number
  name: string
  bank: string
  last4: string | null
}

export interface Transaction {
  id: number
  accountId: number
  /** ISO date-time in local (IST) time, e.g. 2026-10-10T14:05:00 */
  postedAt: string
  amountPaise: number
  direction: Direction
  payee: string
  vpa: string | null
  narration: string
  refNo: string | null
  channel: Channel
  source: Source
  fingerprint: string
  categoryId: number | null
  note: string | null
  kind: TxnKind
  needsReview: boolean
  emailUid: number | null
  createdAt: string
  /** Set when the bill was split with friends: the user's own part, which is what spending totals count. */
  mySharePaise: number | null
  /** On settlements, the friend paying back. */
  friendId: number | null
  /** Set when the expense is split across categories; the parts add up to what the user spent. Empty otherwise. */
  categoryParts: CategoryPart[]
}

export interface CategoryPart {
  categoryId: number
  amountPaise: number
}

export interface NewTransaction {
  accountId: number
  postedAt: string
  amountPaise: number
  direction: Direction
  payee: string
  vpa?: string | null
  narration?: string
  refNo?: string | null
  channel: Channel
  source: Source
  categoryId?: number | null
  note?: string | null
  kind?: TxnKind
  needsReview?: boolean
  emailUid?: number | null
  friendId?: number | null
}

export interface TransactionPatch {
  postedAt?: string
  amountPaise?: number
  payee?: string
  categoryId?: number | null
  note?: string | null
  kind?: TxnKind
  /** Manual entries only: bank rows keep the direction the bank reported. */
  direction?: Direction
  needsReview?: boolean
  accountId?: number
  /** Settlements only. */
  friendId?: number | null
}

export interface TransactionFilter {
  from?: string
  to?: string
  categoryId?: number | null
  /** Only transactions that have a category. */
  categorized?: boolean
  kind?: TxnKind | 'all'
  search?: string
  source?: Source
  needsReview?: boolean
  limit?: number
  offset?: number
}

export interface Category {
  id: number
  name: string
  icon: string
  color: string
  sortOrder: number
  /** Expenses filed here need a description (their note), e.g. "Other". */
  needsNote: boolean
}

export type NewCategory = Omit<Category, 'id' | 'needsNote'> & { needsNote?: boolean }

export type RuleField = 'payee' | 'vpa' | 'narration' | 'any'
export type RuleMatch = 'contains' | 'regex'
export type RuleAction = 'ignore' | 'categorize' | 'transfer'

export interface Rule {
  id: number
  priority: number
  field: RuleField
  match: RuleMatch
  pattern: string
  action: RuleAction
  categoryId: number | null
  enabled: boolean
}

export type BudgetPeriod = 'weekly' | 'monthly'

export interface Budget {
  id: number
  scope: 'overall' | 'category'
  categoryId: number | null
  period: BudgetPeriod
  /** 0 = Sunday … 6 = Saturday; only used for weekly budgets */
  weekStart: number
  limitPaise: number
  warnPct: number
}

export interface BudgetStatus extends Budget {
  periodStart: string
  periodEnd: string
  spentPaise: number
  pct: number
  /** 'ok' | 'warn' | 'over' */
  state: 'ok' | 'warn' | 'over'
  daysLeft: number
  safeToSpendTodayPaise: number
}

export interface CategoryTotal {
  categoryId: number | null
  name: string
  color: string
  totalPaise: number
  count: number
}

export interface DailyTotal {
  /** YYYY-MM-DD */
  day: string
  totalPaise: number
}

export interface MonthlyTotal {
  /** YYYY-MM */
  month: string
  totalPaise: number
}

export interface DashboardStats {
  monthTotalPaise: number
  /** Expenses this month; a split expense counts once. */
  monthCount: number
  prevMonthTotalPaise: number
  byCategory: CategoryTotal[]
  daily: DailyTotal[]
  monthly: MonthlyTotal[]
  topPayees: { payee: string; totalPaise: number; count: number }[]
  needsReviewCount: number
  /** Expenses this month that are left out of every figure until they get a category. */
  uncategorized: UncategorizedTotal
}

export interface UncategorizedTotal {
  count: number
  totalPaise: number
}

export interface SyncResult {
  fetched: number
  inserted: number
  skippedDuplicate: number
  skippedSuppressed: number
  skippedNonTransaction: number
  /** Alerts posted before the tracking start date. */
  skippedBeforeStart: number
  needsReview: number
  errors: string[]
  /** Human-readable budget alerts newly triggered by this sync. */
  budgetAlerts: string[]
  finishedAt: string
}

export interface GmailStatus {
  configured: boolean
  /** How the saved account signs in; null when not configured. */
  auth: 'oauth' | 'password' | null
  user: string | null
  /** The Google Cloud OAuth client used for "Sign in with Google", kept across disconnects. */
  oauthClientId: string | null
  oauthClientSaved: boolean
  lastSyncAt: string | null
  lastUid: number
  encryptionAvailable: boolean
  sender: string
}

export interface ImportPreviewRow {
  postedAt: string
  narration: string
  refNo: string | null
  amountPaise: number
  direction: Direction
  closingBalancePaise: number | null
  payee: string
  vpa: string | null
  channel: Channel
  fingerprint: string
  status: 'new' | 'duplicate' | 'suppressed' | 'before_start'
  /** Debit/credit was guessed; imported as needs review. */
  uncertain?: boolean
}

export interface ImportPreview {
  fileName: string
  path: string
  rows: ImportPreviewRow[]
  skipped: number
  error?: string
  needsPassword: boolean
  counts: { new: number; duplicate: number; suppressed: number; beforeStart: number }
}

export interface ImportCommitResult {
  inserted: number
  duplicate: number
  suppressed: number
  budgetAlerts: string[]
}

// ---------- AI ----------
export type AiPreset = 'ollama' | 'lmstudio' | 'openrouter' | 'groq' | 'openai' | 'anthropic' | 'custom'

export interface AiProfile {
  id: string
  name: string
  preset: AiPreset
  /** OpenAI-compatible base URL (ignored for openai/anthropic presets). */
  baseUrl: string
  model: string
  hasKey: boolean
  /** null = not probed yet */
  supportsTools: boolean | null
}

export type AiPrivacy = 'aggregates' | 'rows'

export interface AiSettings {
  profiles: AiProfile[]
  activeId: string | null
  privacy: AiPrivacy
}

export interface AiTestResult {
  ok: boolean
  message: string
  supportsTools: boolean | null
  models: string[]
}

export interface AiAnswer {
  text: string
  mode: 'tool' | 'briefing'
  model: string
}

export interface AiChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface CategorySuggestion {
  payee: string
  count: number
  totalPaise: number
  categoryId: number | null
  categoryName: string
  confidence: number
}

// ---------- Insights ----------
export interface CategoryComparison {
  categoryId: number | null
  name: string
  color: string
  currentPaise: number
  previousPaise: number
  avg3Paise: number
  count: number
}

export interface WeekdayTotal {
  /** 0 = Sunday … 6 = Saturday */
  weekday: number
  totalPaise: number
  count: number
}

export interface MonthlyCategoryTotal {
  month: string
  categoryId: number | null
  name: string
  color: string
  totalPaise: number
}

export interface InsightsData {
  month: string
  comparison: CategoryComparison[]
  weekdays: WeekdayTotal[]
  cumulative: { day: string; cumulativePaise: number }[]
  monthlyByCategory: MonthlyCategoryTotal[]
  monthTotals: MonthlyTotal[]
  overallMonthlyBudgetPaise: number | null
  incomePaise: number
  transferPaise: number
  ignoredPaise: number
  expenseCount: number
  largest: { payee: string; amountPaise: number; postedAt: string; category: string }[]
  /** Expenses this month that are left out of every figure until they get a category. */
  uncategorized: UncategorizedTotal
}

export interface Friend {
  id: number
  name: string
  /** UPI IDs this friend has paid back from. */
  vpas: string[]
  /** Their shares of bills the user paid. */
  sharedPaise: number
  /** What they have paid back. */
  settledPaise: number
  /** sharedPaise - settledPaise: positive means they owe the user, negative means the user owes them. */
  balancePaise: number
}

export interface SplitShare {
  friendId: number
  friendName: string
  amountPaise: number
}

/** A friend's share as entered in the split form; a new name creates the friend. */
export interface SplitShareInput {
  friendName: string
  amountPaise: number
}

export interface FriendActivity {
  txnId: number
  postedAt: string
  payee: string
  /** share: their part of a bill the user paid; settlement: money they paid back. */
  type: 'share' | 'settlement'
  amountPaise: number
  /** Full bill amount, for shares. */
  billPaise: number | null
}
