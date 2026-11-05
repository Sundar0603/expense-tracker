import type Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'

/** Ordered migrations. Index + 1 == resulting user_version. Never edit a shipped migration; append. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    bank       TEXT NOT NULL,
    last4      TEXT
  );

  CREATE TABLE categories (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    icon       TEXT NOT NULL DEFAULT '🏷️',
    color      TEXT NOT NULL DEFAULT '#8b8b8b',
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE transactions (
    id           INTEGER PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES accounts(id),
    posted_at    TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
    direction    TEXT NOT NULL CHECK (direction IN ('debit','credit')),
    payee        TEXT NOT NULL,
    vpa          TEXT,
    narration    TEXT NOT NULL DEFAULT '',
    ref_no       TEXT,
    channel      TEXT NOT NULL,
    source       TEXT NOT NULL CHECK (source IN ('email','statement','manual')),
    fingerprint  TEXT NOT NULL UNIQUE,
    category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    note         TEXT,
    kind         TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','transfer','income','ignored')),
    needs_review INTEGER NOT NULL DEFAULT 0,
    email_uid    INTEGER,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
  );
  CREATE INDEX idx_txn_posted   ON transactions(posted_at);
  CREATE INDEX idx_txn_category ON transactions(category_id);
  CREATE INDEX idx_txn_kind     ON transactions(kind, direction, posted_at);

  -- Salted hashes of deleted transactions' fingerprints. Nothing else is kept.
  CREATE TABLE suppressed (
    fingerprint_hash TEXT PRIMARY KEY
  );

  CREATE TABLE rules (
    id          INTEGER PRIMARY KEY,
    priority    INTEGER NOT NULL DEFAULT 100,
    field       TEXT NOT NULL CHECK (field IN ('payee','vpa','narration','any')),
    match       TEXT NOT NULL CHECK (match IN ('contains','regex')),
    pattern     TEXT NOT NULL,
    action      TEXT NOT NULL CHECK (action IN ('ignore','categorize','transfer')),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    enabled     INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE budgets (
    id          INTEGER PRIMARY KEY,
    scope       TEXT NOT NULL CHECK (scope IN ('overall','category')),
    category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    period      TEXT NOT NULL CHECK (period IN ('weekly','monthly')),
    week_start  INTEGER NOT NULL DEFAULT 1,
    limit_paise INTEGER NOT NULL CHECK (limit_paise > 0),
    warn_pct    INTEGER NOT NULL DEFAULT 80
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2: the user picked this row's category or type by hand; "Re-apply rules" leaves it alone.
  `ALTER TABLE transactions ADD COLUMN user_set INTEGER NOT NULL DEFAULT 0;`,
  // v3: bills split with friends. An expense can carry the user's own share (spend_paise is what
  // every spending total counts), friends' shares are money owed back, and a 'settlement' is a
  // friend paying it back: neither income nor expense. SQLite can't alter a CHECK, so the
  // transactions table is rebuilt to allow the new kind.
  `
  CREATE TABLE friends (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );

  -- UPI IDs a friend has paid back from, learned when the user marks a settlement.
  CREATE TABLE friend_vpas (
    vpa       TEXT PRIMARY KEY COLLATE NOCASE,
    friend_id INTEGER NOT NULL REFERENCES friends(id) ON DELETE CASCADE
  );

  CREATE TABLE transactions_new (
    id             INTEGER PRIMARY KEY,
    account_id     INTEGER NOT NULL REFERENCES accounts(id),
    posted_at      TEXT NOT NULL,
    amount_paise   INTEGER NOT NULL CHECK (amount_paise >= 0),
    direction      TEXT NOT NULL CHECK (direction IN ('debit','credit')),
    payee          TEXT NOT NULL,
    vpa            TEXT,
    narration      TEXT NOT NULL DEFAULT '',
    ref_no         TEXT,
    channel        TEXT NOT NULL,
    source         TEXT NOT NULL CHECK (source IN ('email','statement','manual')),
    fingerprint    TEXT NOT NULL UNIQUE,
    category_id    INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    note           TEXT,
    kind           TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','transfer','income','ignored','settlement')),
    needs_review   INTEGER NOT NULL DEFAULT 0,
    email_uid      INTEGER,
    created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime')),
    user_set       INTEGER NOT NULL DEFAULT 0,
    -- NULL: not split, the whole amount is the user's.
    my_share_paise INTEGER CHECK (my_share_paise >= 0),
    -- The friend paying back, on settlements.
    friend_id      INTEGER REFERENCES friends(id) ON DELETE RESTRICT,
    spend_paise    INTEGER GENERATED ALWAYS AS (COALESCE(my_share_paise, amount_paise)) VIRTUAL
  );
  INSERT INTO transactions_new (id, account_id, posted_at, amount_paise, direction, payee, vpa, narration, ref_no,
    channel, source, fingerprint, category_id, note, kind, needs_review, email_uid, created_at, user_set)
  SELECT id, account_id, posted_at, amount_paise, direction, payee, vpa, narration, ref_no,
    channel, source, fingerprint, category_id, note, kind, needs_review, email_uid, created_at, user_set
  FROM transactions;
  DROP TABLE transactions;
  ALTER TABLE transactions_new RENAME TO transactions;
  CREATE INDEX idx_txn_posted   ON transactions(posted_at);
  CREATE INDEX idx_txn_category ON transactions(category_id);
  CREATE INDEX idx_txn_kind     ON transactions(kind, direction, posted_at);
  CREATE INDEX idx_txn_friend   ON transactions(friend_id);

  -- What each friend owes on a split expense. Goes with the transaction when it is deleted.
  CREATE TABLE split_shares (
    id           INTEGER PRIMARY KEY,
    txn_id       INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    friend_id    INTEGER NOT NULL REFERENCES friends(id) ON DELETE RESTRICT,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    UNIQUE (txn_id, friend_id)
  );
  CREATE INDEX idx_split_friend ON split_shares(friend_id);
  `,
  // v4: one expense split across categories (a settlement covering a dinner and a movie). The parts
  // add up to what the user spent; the transaction keeps its largest part as its category.
  // expense_lines is what every spending figure reads: a split expense once per part, any other
  // categorized expense once. Uncategorized expenses are not reviewed yet, so they are left out.
  `
  CREATE TABLE category_parts (
    id           INTEGER PRIMARY KEY,
    txn_id       INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    UNIQUE (txn_id, category_id)
  );
  CREATE INDEX idx_parts_category ON category_parts(category_id);

  CREATE VIEW expense_lines AS
    SELECT t.id AS txn_id, t.posted_at, t.payee,
           COALESCE(p.category_id, t.category_id) AS category_id,
           COALESCE(p.amount_paise, t.spend_paise) AS spend_paise
    FROM transactions t LEFT JOIN category_parts p ON p.txn_id = t.id
    WHERE t.kind = 'expense' AND t.direction = 'debit' AND t.category_id IS NOT NULL;
  `,
  // v5: catch-all categories ask what the expense was, so it can be recategorized later. The
  // description is the transaction's note.
  `
  ALTER TABLE categories ADD COLUMN needs_note INTEGER NOT NULL DEFAULT 0;
  UPDATE categories SET needs_note = 1 WHERE name = 'Other';
  `
]

const STARTER_CATEGORIES: [string, string, string][] = [
  ['Food', '🍔', '#f97316'],
  ['Groceries', '🛒', '#84cc16'],
  ['Travel', '🚕', '#06b6d4'],
  ['Petrol', '⛽', '#eab308'],
  ['Bills & Utilities', '💡', '#3b82f6'],
  ['Shopping', '🛍️', '#ec4899'],
  ['Health', '💊', '#ef4444'],
  ['Entertainment', '🎬', '#a855f7'],
  ['Rent', '🏠', '#14b8a6'],
  ['Subscriptions', '🔁', '#6366f1'],
  ['Cash', '💵', '#22c55e'],
  ['Other', '🏷️', '#8b8b8b']
]

/** Starter rules: investments and self-transfers out of expense totals. User can edit/delete. */
const STARTER_RULES: { field: string; match: string; pattern: string; action: string; priority: number }[] = [
  { field: 'any', match: 'contains', pattern: 'zerodha', action: 'ignore', priority: 10 },
  { field: 'any', match: 'regex', pattern: 'INDIAN CLEARING CORP|ICCL', action: 'ignore', priority: 10 },
  { field: 'any', match: 'regex', pattern: 'COIN|ZERODHA BROKING', action: 'ignore', priority: 10 }
]

export function migrate(db: Database.Database): void {
  const current = db.pragma('user_version', { simple: true }) as number
  const run = db.transaction(() => {
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]!)
      db.pragma(`user_version = ${v + 1}`)
    }
  })
  run()
  seed(db)
}

function seed(db: Database.Database): void {
  const seedTx = db.transaction(() => {
    const accountCount = (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
    if (accountCount === 0) {
      db.prepare('INSERT INTO accounts (name, bank, last4) VALUES (?, ?, ?)').run('HDFC Savings', 'HDFC', null)
      db.prepare('INSERT INTO accounts (name, bank, last4) VALUES (?, ?, ?)').run('Cash', 'CASH', null)
    }
    // Seed starter categories once. After that the list is the user's: deleting every category must
    // not bring the starters back on the next launch.
    const catSeeded = db.prepare("SELECT value FROM settings WHERE key = 'categories_seeded'").get()
    if (!catSeeded) {
      const catCount = (db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }).n
      if (catCount === 0) {
        const ins = db.prepare('INSERT INTO categories (name, icon, color, sort_order, needs_note) VALUES (?, ?, ?, ?, ?)')
        STARTER_CATEGORIES.forEach(([name, icon, color], i) => ins.run(name, icon, color, i, name === 'Other' ? 1 : 0))
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('categories_seeded', '1')").run()
    }
    // Same for starter rules: seed once, then deleting them all keeps them deleted.
    const rulesSeeded = db.prepare("SELECT value FROM settings WHERE key = 'rules_seeded'").get()
    if (!rulesSeeded) {
      const ruleCount = (db.prepare('SELECT COUNT(*) AS n FROM rules').get() as { n: number }).n
      if (ruleCount === 0) {
        const ins = db.prepare(
          'INSERT INTO rules (priority, field, match, pattern, action, category_id, enabled) VALUES (?, ?, ?, ?, ?, NULL, 1)'
        )
        for (const r of STARTER_RULES) ins.run(r.priority, r.field, r.match, r.pattern, r.action)
      }
      db.prepare("INSERT INTO settings (key, value) VALUES ('rules_seeded', '1')").run()
    }
    const salt = db.prepare("SELECT value FROM settings WHERE key = 'suppression_salt'").get()
    if (!salt) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
        'suppression_salt',
        randomBytes(32).toString('hex')
      )
    }
  })
  seedTx()
}
