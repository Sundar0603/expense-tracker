import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { Api } from '@shared/api'
import { listAccounts } from '../db/repo/accounts'
import {
  countTransactions,
  deleteTransaction,
  getTransaction,
  insertTransaction,
  listTransactions,
  payeeSuggestions,
  reapplyRules,
  updateTransaction
} from '../db/repo/transactions'
import { createCategory, deleteCategory, listCategories, updateCategory } from '../db/repo/categories'
import { createRule, deleteRule, listRules, previewRule, updateRule } from '../db/repo/rules'
import { setCategorySplit } from '../db/repo/category-parts'
import { deleteFriend, ensureFriend, friendActivity, getSplit, listFriends, renameFriend, setSplit } from '../db/repo/friends'
import { budgetStatuses, createBudget, deleteBudget, listBudgets, updateBudget } from '../db/repo/budgets'
import { dashboardStats } from '../db/repo/stats'
import { insightsData } from '../db/repo/insights'
import { deleteProfile, getAiSettings, saveProfile, setActive, setPrivacy } from '../ai/profiles'
import { testProfile } from '../ai/providers'
import { askQuestion, suggestCategories, summarizeMonth } from '../ai'
import { backupDatabase, exportCsv, restoreDatabase } from '../backup'
import { getAllSettings, getSetting, setSetting } from '../db/repo/settings'
import { cancelGoogleSignIn, clearGmail, configureGmail, gmailStatus, signInWithGoogle, testGmail, trashMessage } from '../mail/gmail'
import { runSync } from '../sync'
import { commitImport, pickStatementFile, previewStatement } from '../import'
import { checkBudgetsAndNotify } from '../sync/budget-alerts'

type Handlers = { [G in keyof Api]: { [M in keyof Api[G]]: Api[G][M] } }

/**
 * Keys the renderer may write. Everything else (secrets, the suppression salt that makes past
 * deletions stick, Gmail sync cursors, AI profiles) is owned by main-process code.
 */
const USER_SETTINGS = new Set(['tracking_start', 'notify_budget', 'sync_on_launch', 'trash_email_on_delete', 'hdfc_sender'])

export function registerIpc(ctx: { dbPath: string }): void {
  const handlers: Handlers = {
    app: {
      info: async () => ({ version: app.getVersion(), dbPath: ctx.dbPath, platform: process.platform })
    },
    accounts: {
      list: async () => listAccounts()
    },
    txn: {
      list: async (f) => listTransactions(f),
      count: async (f) => countTransactions(f),
      get: async (id) => getTransaction(id),
      create: async (input) => {
        const out = insertTransaction(input)
        if (out.status !== 'inserted') throw new Error(`Could not add transaction (${out.status})`)
        return out.txn
      },
      update: async (id, patch) => updateTransaction(id, patch),
      delete: async (id) => {
        const { emailUid } = deleteTransaction(id)
        if (emailUid && getSetting('trash_email_on_delete') === '1') {
          // Best effort, after the row is already gone.
          void trashMessage(emailUid)
        }
      },
      payeeSuggestions: async (prefix) => payeeSuggestions(prefix)
    },
    categories: {
      list: async () => listCategories(),
      create: async (input) => createCategory(input),
      update: async (id, patch) => updateCategory(id, patch),
      delete: async (id) => deleteCategory(id)
    },
    rules: {
      list: async () => listRules(),
      create: async (input) => createRule(input),
      update: async (id, patch) => updateRule(id, patch),
      delete: async (id) => deleteRule(id),
      preview: async (rule) => previewRule(rule),
      applyAll: async () => reapplyRules()
    },
    friends: {
      list: async () => listFriends(),
      ensure: async (name) => ensureFriend(name),
      rename: async (id, name) => renameFriend(id, name),
      delete: async (id) => deleteFriend(id),
      activity: async (id) => friendActivity(id)
    },
    splits: {
      get: async (txnId) => getSplit(txnId),
      set: async (txnId, shares) => setSplit(txnId, shares)
    },
    categorySplits: {
      set: async (txnId, parts) => setCategorySplit(txnId, parts)
    },
    budgets: {
      list: async () => listBudgets(),
      create: async (input) => createBudget(input),
      update: async (id, patch) => updateBudget(id, patch),
      delete: async (id) => deleteBudget(id),
      status: async () => budgetStatuses()
    },
    stats: {
      dashboard: async (month) => dashboardStats(month),
      insights: async (month) => insightsData(month)
    },
    ai: {
      getSettings: async () => getAiSettings(),
      saveProfile: async ({ profile, apiKey }) => saveProfile(profile, apiKey),
      deleteProfile: async (id) => deleteProfile(id),
      setActive: async (id) => setActive(id),
      setPrivacy: async (mode) => setPrivacy(mode),
      test: async (id) => testProfile(id),
      summarize: async (month) => summarizeMonth(month),
      ask: async (input) => askQuestion(input),
      suggestCategories: async () => suggestCategories()
    },
    settings: {
      getAll: async () => getAllSettings(),
      set: async (key, value) => {
        if (!USER_SETTINGS.has(key)) throw new Error(`Setting "${key}" cannot be changed from the UI`)
        setSetting(key, value)
      }
    },
    data: {
      exportCsv: async () => exportCsv(),
      backup: async (passphrase) => backupDatabase(passphrase),
      restore: async (passphrase) => restoreDatabase(passphrase, ctx.dbPath),
      setOpenAtLogin: async (enabled) => {
        app.setLoginItemSettings({ openAtLogin: enabled })
        return app.getLoginItemSettings().openAtLogin
      },
      getOpenAtLogin: async () => app.getLoginItemSettings().openAtLogin
    },
    gmail: {
      status: async () => gmailStatus(),
      configure: async ({ user, appPassword }) => {
        configureGmail(user, appPassword)
        return gmailStatus()
      },
      signInWithGoogle: async (input) => {
        await signInWithGoogle(input, (url) => shell.openExternal(url))
        // The browser took focus for the consent page; bring the app back.
        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          if (win.isMinimized()) win.restore()
          win.focus()
          app.focus({ steal: true })
        }
        return gmailStatus()
      },
      cancelSignIn: async () => cancelGoogleSignIn(),
      test: async () => testGmail(),
      clear: async () => {
        clearGmail()
        return gmailStatus()
      }
    },
    import: {
      pickFile: async () => pickStatementFile(),
      preview: async ({ path, password }) => previewStatement(path, password),
      commit: async (rows) => commitImport(rows)
    },
    sync: {
      run: async () => runSync(),
      checkBudgets: async () => checkBudgetsAndNotify()
    }
  }

  for (const [group, methods] of Object.entries(handlers)) {
    for (const [method, fn] of Object.entries(methods as Record<string, (...a: unknown[]) => Promise<unknown>>)) {
      // Re-throw as a bare Error: Electron logs handler errors, and library errors (e.g. an AI
      // APICallError) can carry request bodies with transaction data.
      ipcMain.handle(`${group}.${method}`, async (_event, ...args: unknown[]) => {
        try {
          return await fn(...args)
        } catch (e) {
          throw new Error(e instanceof Error ? e.message : String(e))
        }
      })
    }
  }
}
