import { ImapFlow, type SearchObject } from 'imapflow'
import { simpleParser, type ParsedMail } from 'mailparser'
import { getSetting, setSetting } from '../db/repo/settings'
import { deleteSecret, encryptionAvailable, getSecret, setSecret } from './secrets'
import type { GmailStatus } from '@shared/types'
import { cancelSignIn, refreshAccessToken, revokeToken, signIn, validateOAuthClient, type OAuthClient } from './google-oauth'

const ALL_MAIL = '[Gmail]/All Mail'
/** HDFC moved alerts to its .bank.in domain in 2026; keep the old address so older mail still matches. */
const DEFAULT_HDFC_SENDERS = ['alerts@hdfcbank.bank.in', 'alerts@hdfcbank.net']

/** The `hdfc_sender` setting (comma separated) overrides the defaults. */
function alertSenders(): string[] {
  const custom = (getSetting('hdfc_sender') ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  return custom.length ? custom : DEFAULT_HDFC_SENDERS
}

function alertSearch(since: Date): SearchObject {
  const senders = alertSenders()
  return senders.length === 1 ? { from: senders[0], since } : { or: senders.map((from) => ({ from })), since }
}
const TRASH = '[Gmail]/Trash'

/**
 * Gmail names its system folders in the account's display language, and each one can be hidden
 * from IMAP. Resolve the folder by its special-use flag (\All, \Trash) and fall back to the
 * English name, then INBOX, instead of hard-coding the path.
 */
async function resolveFolder(client: ImapFlow, use: '\\All' | '\\Trash'): Promise<string> {
  const fallback = use === '\\All' ? ALL_MAIL : TRASH
  let boxes: Awaited<ReturnType<ImapFlow['list']>> = []
  try {
    boxes = await client.list()
  } catch {
    return fallback
  }
  const byUse = boxes.find((b) => b.specialUse === use)
  if (byUse) return byUse.path
  if (boxes.some((b) => b.path === fallback)) return fallback
  if (use === '\\All') return 'INBOX'
  throw new Error('Gmail Trash folder is not visible over IMAP. In Gmail settings → Labels, turn on "Show in IMAP" for Trash.')
}

export type GmailAuthKind = 'oauth' | 'password'

export type GmailAuth = { kind: 'oauth'; client: OAuthClient; refreshToken: string } | { kind: 'password'; pass: string }

export interface GmailConfig {
  user: string
  auth: GmailAuth
}

function getOAuthClient(): OAuthClient | null {
  const clientId = getSetting('gmail_oauth_client_id')
  const clientSecret = getSecret('gmail_oauth_client_secret')
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

export function getGmailConfig(): GmailConfig | null {
  const user = getSetting('gmail_user')
  if (!user) return null
  if (getSetting('gmail_auth') === 'oauth') {
    const client = getOAuthClient()
    const refreshToken = getSecret('gmail_refresh_token')
    return client && refreshToken ? { user, auth: { kind: 'oauth', client, refreshToken } } : null
  }
  const pass = getSecret('gmail_pass')
  return pass ? { user, auth: { kind: 'password', pass } } : null
}

export function gmailStatus(): GmailStatus {
  const cfg = getGmailConfig()
  return {
    configured: cfg !== null,
    auth: cfg?.auth.kind ?? null,
    user: getSetting('gmail_user') || null,
    oauthClientId: getSetting('gmail_oauth_client_id') || null,
    oauthClientSaved: getOAuthClient() !== null,
    lastSyncAt: getSetting('gmail_last_sync_at'),
    lastUid: Number(getSetting('gmail_last_uid') ?? 0),
    encryptionAvailable: encryptionAvailable(),
    sender: alertSenders().join(', ')
  }
}

/** A different mailbox has unrelated UIDs, so start its sync cursor from scratch. */
function setGmailUser(user: string): void {
  if (getSetting('gmail_user') !== user) {
    for (const k of ['gmail_last_uid', 'gmail_last_sync_at', 'gmail_uidvalidity']) setSetting(k, '')
  }
  setSetting('gmail_user', user)
}

export function configureGmail(user: string, appPassword: string): void {
  const cleanedPass = appPassword.replace(/\s+/g, '')
  if (!/^[^@\s]+@[^@\s]+$/.test(user)) throw new Error('Enter the full Gmail address')
  // Google app passwords are always 16 letters (shown as four groups of four). Anything else is
  // almost certainly the normal account password, which Gmail IMAP rejects as "Invalid credentials".
  if (!/^[a-z]{16}$/i.test(cleanedPass)) {
    throw new Error(
      `That is not an app password (got ${cleanedPass.length} characters, expected 16 letters). ` +
        'Create one at myaccount.google.com/apppasswords (2-Step Verification must be on) and paste it here.'
    )
  }
  dropOAuthGrant()
  setGmailUser(user.trim())
  setSecret('gmail_pass', cleanedPass)
  setSetting('gmail_auth', 'password')
}

/**
 * Run Google's browser sign-in and switch Gmail to OAuth. Empty client fields reuse the saved
 * OAuth client, so signing in again later is one click.
 */
export async function signInWithGoogle(input: { clientId: string; clientSecret: string }, openUrl: (url: string) => Promise<void>): Promise<void> {
  if (!encryptionAvailable()) throw new Error('Keychain encryption is not available on this Mac')
  const saved = getOAuthClient()
  const clientId = input.clientId.trim() || saved?.clientId || ''
  const reuseSecret = saved && clientId === saved.clientId
  const client = validateOAuthClient({ clientId, clientSecret: input.clientSecret.trim() || (reuseSecret ? saved.clientSecret : '') })
  const res = await signIn(client, openUrl, getSetting('gmail_user') || undefined)
  setSetting('gmail_oauth_client_id', client.clientId)
  setSecret('gmail_oauth_client_secret', client.clientSecret)
  dropOAuthGrant()
  setGmailUser(res.email)
  setSecret('gmail_refresh_token', res.refreshToken)
  deleteSecret('gmail_pass')
  setSetting('gmail_auth', 'oauth')
  tokenCache = { refreshToken: res.refreshToken, accessToken: res.accessToken, expiresAt: res.expiresAt }
}

export { cancelSignIn as cancelGoogleSignIn }

/** Forget and revoke any stored Google grant (keeps the OAuth client for the next sign-in). */
function dropOAuthGrant(): void {
  const token = getSecret('gmail_refresh_token')
  if (token) void revokeToken(token)
  deleteSecret('gmail_refresh_token')
  tokenCache = null
}

export function clearGmail(): void {
  dropOAuthGrant()
  deleteSecret('gmail_pass')
  for (const k of ['gmail_user', 'gmail_auth', 'gmail_last_uid', 'gmail_last_sync_at', 'gmail_uidvalidity']) {
    setSetting(k, '')
  }
}

let tokenCache: { refreshToken: string; accessToken: string; expiresAt: number } | null = null

async function accessTokenFor(auth: Extract<GmailAuth, { kind: 'oauth' }>): Promise<string> {
  if (tokenCache && tokenCache.refreshToken === auth.refreshToken && tokenCache.expiresAt - 60_000 > Date.now()) {
    return tokenCache.accessToken
  }
  const t = await refreshAccessToken(auth.client, auth.refreshToken)
  tokenCache = { refreshToken: auth.refreshToken, ...t }
  return t.accessToken
}

async function makeClient(cfg: GmailConfig): Promise<ImapFlow> {
  const auth = cfg.auth.kind === 'oauth' ? { user: cfg.user, accessToken: await accessTokenFor(cfg.auth) } : { user: cfg.user, pass: cfg.auth.pass }
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth,
    logger: false,
    emitLogs: false
  })
}

/** Connect, open All Mail, report how many HDFC alert mails exist in the last 30 days. */
export async function testGmail(): Promise<{ ok: boolean; message: string }> {
  const cfg = getGmailConfig()
  if (!cfg) return { ok: false, message: 'Gmail is not configured' }
  let client: ImapFlow
  try {
    client = await makeClient(cfg)
  } catch (e) {
    return { ok: false, message: friendlyImapError(e, cfg.auth.kind) }
  }
  try {
    await client.connect()
    const folder = await resolveFolder(client, '\\All')
    const lock = await client.getMailboxLock(folder)
    try {
      const since = new Date(Date.now() - 30 * 86400_000)
      const sender = alertSenders().join(' or ')
      const uids = (await client.search(alertSearch(since), { uid: true })) || []
      const where = folder === 'INBOX' ? ' (All Mail is hidden from IMAP, so only the Inbox is searched)' : ''
      return { ok: true, message: `Connected. ${uids.length} HDFC alert email(s) from ${sender} in the last 30 days${where}.` }
    } finally {
      lock.release()
    }
  } catch (e) {
    return { ok: false, message: friendlyImapError(e, cfg.auth.kind) }
  } finally {
    await client.logout().catch(() => client.close())
  }
}

export interface FetchedMail {
  uid: number
  internalDate: Date | null
  mail: ParsedMail
}

/**
 * Fetch HDFC alert mails newer than `since` and with UID greater than `afterUid`.
 * Calls `onMessage` for each; keeps going on per-message failures.
 */
export async function fetchAlerts(opts: {
  since: Date
  afterUid: number
  onMessage: (m: FetchedMail) => Promise<void> | void
  onError: (uid: number, err: unknown) => void
}): Promise<{ fetched: number; maxUid: number; uidValidity: string | null }> {
  const cfg = getGmailConfig()
  if (!cfg) throw new Error('Gmail is not configured. Add your Gmail address and app password in Settings.')
  const client = await makeClient(cfg)
  let fetched = 0
  let maxUid = opts.afterUid
  let uidValidity: string | null = null
  try {
    await client.connect()
    const folder = await resolveFolder(client, '\\All')
    const lock = await client.getMailboxLock(folder)
    try {
      uidValidity = client.mailbox && typeof client.mailbox === 'object' ? String(client.mailbox.uidValidity ?? '') : null
      const found = (await client.search(alertSearch(opts.since), { uid: true })) || []
      const uids = found.filter((u) => u > opts.afterUid).sort((a, b) => a - b)
      if (uids.length === 0) return { fetched, maxUid, uidValidity }
      for await (const msg of client.fetch(uids, { uid: true, source: true, internalDate: true }, { uid: true })) {
        fetched++
        try {
          if (!msg.source) throw new Error('empty message source')
          const mail = await simpleParser(msg.source)
          const internalDate = msg.internalDate ? new Date(msg.internalDate) : null
          await opts.onMessage({ uid: msg.uid, internalDate, mail })
          if (msg.uid > maxUid) maxUid = msg.uid
        } catch (e) {
          opts.onError(msg.uid, e)
        }
      }
    } finally {
      lock.release()
    }
  } catch (e) {
    throw new Error(friendlyImapError(e, cfg.auth.kind))
  } finally {
    await client.logout().catch(() => client.close())
  }
  return { fetched, maxUid, uidValidity }
}

/**
 * Sender addresses (lowercased) of recent mail whose From contains `match`, with counts. Addresses
 * only, never content: used to spot a bank alert sender that changed.
 */
export async function recentSenders(match: string, days: number): Promise<Record<string, number>> {
  const cfg = getGmailConfig()
  if (!cfg) throw new Error('Gmail is not configured')
  const client = await makeClient(cfg)
  const counts: Record<string, number> = {}
  try {
    await client.connect()
    const lock = await client.getMailboxLock(await resolveFolder(client, '\\All'))
    try {
      const since = new Date(Date.now() - days * 86400_000)
      const uids = (await client.search({ from: match, since }, { uid: true })) || []
      if (uids.length === 0) return counts
      for await (const msg of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
        const addr = msg.envelope?.from?.[0]?.address?.toLowerCase()
        if (addr) counts[addr] = (counts[addr] ?? 0) + 1
      }
    } finally {
      lock.release()
    }
  } catch (e) {
    throw new Error(friendlyImapError(e, cfg.auth.kind))
  } finally {
    await client.logout().catch(() => client.close())
  }
  return counts
}

/** Best-effort: move an alert email to Gmail Trash. */
export async function trashMessage(uid: number): Promise<boolean> {
  const cfg = getGmailConfig()
  if (!cfg) return false
  let client: ImapFlow
  try {
    client = await makeClient(cfg)
  } catch {
    return false
  }
  try {
    await client.connect()
    const folder = await resolveFolder(client, '\\All')
    const trash = await resolveFolder(client, '\\Trash')
    const lock = await client.getMailboxLock(folder)
    try {
      const res = await client.messageMove(String(uid), trash, { uid: true })
      return res !== false
    } finally {
      lock.release()
    }
  } catch {
    return false
  } finally {
    await client.logout().catch(() => client.close())
  }
}

export function friendlyImapError(e: unknown, auth: GmailAuthKind = 'password'): string {
  // imapflow reports a server NO/BAD as a bare "Command failed" and puts the server's
  // explanation in responseText; join them so the user sees the real reason.
  const extra = e && typeof e === 'object' ? (e as { responseText?: unknown; code?: unknown }) : {}
  const parts = [e instanceof Error ? e.message : String(e)]
  if (typeof extra.responseText === 'string' && extra.responseText) parts.push(extra.responseText)
  else if (typeof extra.code === 'string' && extra.code) parts.push(extra.code)
  const msg = parts.join(': ')
  if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed/i.test(msg)) {
    if (auth === 'oauth') {
      tokenCache = null
      return `Gmail rejected the Google sign-in (${msg}). Sign in with Google again in Settings.`
    }
    return `Gmail rejected the login (${msg}). Check the address and app password: 2-Step Verification must be on, and the password is the 16-character app password, not your normal one.`
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) return `Could not reach imap.gmail.com: ${msg}`
  if (/Mailbox doesn't exist|NONEXISTENT|Unknown Mailbox/i.test(msg)) return `The mail folder is not visible over IMAP (${msg}). In Gmail settings → Labels, turn on "Show in IMAP" for All Mail.`
  if (/Web login required|application-specific password/i.test(msg)) return `Gmail wants an app password, not your account password (${msg}).`
  if (/IMAP access is disabled|not enabled/i.test(msg)) return `IMAP is turned off for this Gmail account (${msg}). Enable it under Gmail settings → See all settings → Forwarding and POP/IMAP.`
  if (/Too many simultaneous connections|THROTTLE/i.test(msg)) return `Gmail is throttling IMAP connections (${msg}). Wait a minute and try again.`
  return msg
}
