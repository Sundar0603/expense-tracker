import type {
  Account,
  AiAnswer,
  AiChatMessage,
  AiPrivacy,
  AiProfile,
  AiSettings,
  AiTestResult,
  CategoryPart,
  CategorySuggestion,
  InsightsData,
  Budget,
  BudgetStatus,
  Category,
  DashboardStats,
  Friend,
  FriendActivity,
  GmailStatus,
  ImportCommitResult,
  ImportPreview,
  ImportPreviewRow,
  NewCategory,
  NewTransaction,
  Rule,
  SplitShare,
  SplitShareInput,
  SyncResult,
  Transaction,
  TransactionFilter,
  TransactionPatch
} from './types'

/**
 * The contract between renderer and main. Every method here is one IPC channel named
 * `<group>.<method>`; the preload exposes it as `window.api.<group>.<method>`.
 */
export interface Api {
  app: {
    info(): Promise<{ version: string; dbPath: string; platform: string }>
  }
  accounts: {
    list(): Promise<Account[]>
  }
  txn: {
    list(filter: TransactionFilter): Promise<Transaction[]>
    count(filter: TransactionFilter): Promise<number>
    get(id: number): Promise<Transaction | null>
    create(input: NewTransaction): Promise<Transaction>
    update(id: number, patch: TransactionPatch): Promise<Transaction>
    /** Traceless delete. */
    delete(id: number): Promise<void>
    payeeSuggestions(prefix: string): Promise<string[]>
  }
  categories: {
    list(): Promise<Category[]>
    create(input: NewCategory): Promise<Category>
    update(id: number, patch: Partial<Omit<Category, 'id'>>): Promise<Category>
    delete(id: number): Promise<void>
  }
  rules: {
    list(): Promise<Rule[]>
    create(input: Omit<Rule, 'id'>): Promise<Rule>
    update(id: number, patch: Partial<Omit<Rule, 'id'>>): Promise<Rule>
    delete(id: number): Promise<void>
    /** How many existing transactions a rule would match. */
    preview(rule: Omit<Rule, 'id'>): Promise<number>
    /** Re-run all rules over transactions that were never manually categorized. */
    applyAll(): Promise<{ updated: number }>
  }
  friends: {
    /** With balances: positive means the friend owes the user. */
    list(): Promise<Friend[]>
    /** Id of the friend with this name, adding them if new. */
    ensure(name: string): Promise<number>
    rename(id: number, name: string): Promise<void>
    /** Only for friends with no split bills or paybacks. */
    delete(id: number): Promise<void>
    activity(id: number): Promise<FriendActivity[]>
  }
  splits: {
    get(txnId: number): Promise<SplitShare[]>
    /** Replace the friends' shares of an expense; an empty list removes the split. */
    set(txnId: number, shares: SplitShareInput[]): Promise<Transaction>
  }
  categorySplits: {
    /** Split an expense across categories; the parts must add up to what the user spent. An empty list removes the split. */
    set(txnId: number, parts: CategoryPart[]): Promise<Transaction>
  }
  budgets: {
    list(): Promise<Budget[]>
    create(input: Omit<Budget, 'id'>): Promise<Budget>
    update(id: number, patch: Partial<Omit<Budget, 'id'>>): Promise<Budget>
    delete(id: number): Promise<void>
    status(): Promise<BudgetStatus[]>
  }
  stats: {
    /** month: YYYY-MM */
    dashboard(month: string): Promise<DashboardStats>
    insights(month: string): Promise<InsightsData>
  }
  ai: {
    getSettings(): Promise<AiSettings>
    saveProfile(input: { profile: Omit<AiProfile, 'hasKey' | 'supportsTools'>; apiKey?: string }): Promise<AiSettings>
    deleteProfile(id: string): Promise<AiSettings>
    setActive(id: string): Promise<AiSettings>
    setPrivacy(mode: AiPrivacy): Promise<AiSettings>
    /** Connects, lists models where possible, and probes tool-calling support. */
    test(id: string): Promise<AiTestResult>
    summarize(month: string): Promise<AiAnswer>
    /** Streams chunks over the 'ai:chunk' event with the given requestId, then resolves. */
    ask(input: { requestId: string; question: string; history: AiChatMessage[] }): Promise<AiAnswer>
    suggestCategories(): Promise<CategorySuggestion[]>
  }
  settings: {
    getAll(): Promise<Record<string, string>>
    set(key: string, value: string): Promise<void>
  }
  data: {
    /** Save all transactions as CSV via a save dialog; returns the path or null if cancelled. */
    exportCsv(): Promise<string | null>
    backup(passphrase: string): Promise<string | null>
    /** Replaces the database after confirmation; the app reloads data afterwards. */
    restore(passphrase: string): Promise<boolean>
    setOpenAtLogin(enabled: boolean): Promise<boolean>
    getOpenAtLogin(): Promise<boolean>
  }
  gmail: {
    status(): Promise<GmailStatus>
    configure(input: { user: string; appPassword: string }): Promise<GmailStatus>
    /** Opens Google's consent page in the browser and resolves once sign-in finishes. Empty fields reuse the saved client. */
    signInWithGoogle(input: { clientId: string; clientSecret: string }): Promise<GmailStatus>
    cancelSignIn(): Promise<void>
    test(): Promise<{ ok: boolean; message: string }>
    clear(): Promise<GmailStatus>
  }
  import: {
    /** Opens the macOS file picker; null when cancelled. */
    pickFile(): Promise<string | null>
    preview(input: { path: string; password?: string }): Promise<ImportPreview>
    commit(rows: ImportPreviewRow[]): Promise<ImportCommitResult>
  }
  sync: {
    run(): Promise<SyncResult>
    /** Re-check budgets and fire notifications if enabled (used after manual adds). */
    checkBudgets(): Promise<string[]>
  }
}

export const API_GROUPS: { [G in keyof Api]: (keyof Api[G])[] } = {
  app: ['info'],
  accounts: ['list'],
  txn: ['list', 'count', 'get', 'create', 'update', 'delete', 'payeeSuggestions'],
  categories: ['list', 'create', 'update', 'delete'],
  rules: ['list', 'create', 'update', 'delete', 'preview', 'applyAll'],
  friends: ['list', 'ensure', 'rename', 'delete', 'activity'],
  splits: ['get', 'set'],
  categorySplits: ['set'],
  budgets: ['list', 'create', 'update', 'delete', 'status'],
  stats: ['dashboard', 'insights'],
  ai: ['getSettings', 'saveProfile', 'deleteProfile', 'setActive', 'setPrivacy', 'test', 'summarize', 'ask', 'suggestCategories'],
  settings: ['getAll', 'set'],
  data: ['exportCsv', 'backup', 'restore', 'setOpenAtLogin', 'getOpenAtLogin'],
  gmail: ['status', 'configure', 'signInWithGoogle', 'cancelSignIn', 'test', 'clear'],
  import: ['pickFile', 'preview', 'commit'],
  sync: ['run', 'checkBudgets']
}
