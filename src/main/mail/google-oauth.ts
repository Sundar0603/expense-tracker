import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

/**
 * "Sign in with Google" for Gmail IMAP (XOAUTH2), using the installed-app loopback flow with PKCE.
 * The user supplies their own Desktop OAuth client from Google Cloud Console; only the refresh
 * token is kept (encrypted, by the caller). No Google SDK: two HTTPS calls are all it needs.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const GMAIL_SCOPE = 'https://mail.google.com/'
const SCOPES = [GMAIL_SCOPE, 'openid', 'email']
const SIGN_IN_TIMEOUT_MS = 5 * 60_000

export interface OAuthClient {
  clientId: string
  clientSecret: string
}

export interface SignInResult {
  email: string
  refreshToken: string
  accessToken: string
  expiresAt: number
}

export function validateOAuthClient(c: OAuthClient): OAuthClient {
  const clientId = c.clientId.trim()
  const clientSecret = c.clientSecret.trim()
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('The client ID should end in .apps.googleusercontent.com. Copy it from Google Cloud Console → Clients.')
  }
  if (!clientSecret) throw new Error('Enter the client secret from Google Cloud Console → Clients.')
  return { clientId, clientSecret }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function buildAuthUrl(opts: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint?: string }): string {
  const u = new URL(AUTH_URL)
  u.search = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    // offline + consent so Google always returns a refresh token, even on a repeat sign-in.
    access_type: 'offline',
    prompt: 'consent',
    ...(opts.loginHint ? { login_hint: opts.loginHint } : {})
  }).toString()
  return u.toString()
}

/** The id_token comes straight from Google's token endpoint over TLS, so reading its payload is enough. */
export function emailFromIdToken(idToken: string): string | null {
  const payload = idToken.split('.')[1]
  if (!payload) return null
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown }
    return typeof claims.email === 'string' ? claims.email : null
  } catch {
    return null
  }
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  id_token?: string
  scope?: string
  error?: string
  error_description?: string
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  let res: Response
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString()
    })
  } catch (e) {
    throw new Error(`Could not reach Google: ${e instanceof Error ? e.message : String(e)}`)
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse
  if (!res.ok || json.error) throw new OAuthError(json.error ?? `HTTP ${res.status}`, json.error_description)
  return json
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    description?: string
  ) {
    super(describeOAuthError(code, description))
  }
}

export function describeOAuthError(code: string, description?: string): string {
  const detail = description ? ` (${description})` : ''
  switch (code) {
    case 'invalid_grant':
      // Google ends refresh tokens for "Testing" projects after 7 days, so this is routine there.
      return 'Google sign-in has expired (this happens weekly while the Google Cloud project is in Testing). Go to Settings → Gmail connection → Sign in again.'
    case 'invalid_client':
    case 'unauthorized_client':
      return `Google did not accept the OAuth client${detail}. Check the client ID and secret, and that the client type is "Desktop app".`
    case 'access_denied':
      return 'Sign-in was cancelled in the browser.'
    default:
      return `Google sign-in failed: ${code}${detail}`
  }
}

let pending: { cancel: () => void } | null = null

export function cancelSignIn(): void {
  pending?.cancel()
}

/**
 * Open Google's consent page in the browser and wait for the redirect on a one-shot loopback server.
 * Resolves once the code is exchanged for tokens. Starting a new sign-in cancels any earlier one.
 */
export async function signIn(client: OAuthClient, openUrl: (url: string) => Promise<void>, loginHint?: string): Promise<SignInResult> {
  cancelSignIn()
  const { verifier, challenge } = pkcePair()
  const state = randomBytes(16).toString('hex')

  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as { port: number }).port
  const redirectUri = `http://127.0.0.1:${port}`

  const code = await new Promise<string>((resolve, reject) => {
    let done = false
    const finish = (err: Error | null, value?: string): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      pending = null
      closeServer(server)
      if (err) reject(err)
      else resolve(value!)
    }
    const timer = setTimeout(() => finish(new Error('Timed out waiting for Google sign-in. Try again.')), SIGN_IN_TIMEOUT_MS)
    pending = { cancel: () => finish(new Error('Sign-in cancelled.')) }

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri)
      if (url.pathname !== '/') {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const gotCode = url.searchParams.get('code')
      const ok = !error && !!gotCode && url.searchParams.get('state') === state
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', connection: 'close' })
      // Settle only after the page is flushed; finish() tears the connection down.
      res.end(resultPage(ok), () => {
        if (error) finish(new OAuthError(error))
        else if (!ok) finish(new Error('Google sign-in returned an unexpected response. Try again.'))
        else finish(null, gotCode!)
      })
    })

    openUrl(buildAuthUrl({ clientId: client.clientId, redirectUri, state, challenge, loginHint })).catch((e: unknown) =>
      finish(e instanceof Error ? e : new Error(String(e)))
    )
  })

  const tok = await postToken({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier
  })
  // Google's consent screen lists each permission with its own checkbox, and Gmail's can be left unticked.
  const granted = tok.scope?.split(' ').filter(Boolean) ?? []
  if (!granted.includes(GMAIL_SCOPE)) {
    if (tok.refresh_token) void revokeToken(tok.refresh_token)
    throw new Error(
      'Gmail access was not granted. Sign in again and, on the Google permission page, tick ' +
        '"Read, compose, send and permanently delete all your email from Gmail" (or "Select all") before Continue. ' +
        `Google granted only: ${granted.join(', ') || 'nothing'}.`
    )
  }
  const email = tok.id_token ? emailFromIdToken(tok.id_token) : null
  if (!tok.refresh_token || !tok.access_token || !email) throw new Error('Google did not return a usable sign-in. Try again.')
  return { email, refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 }
}

export async function refreshAccessToken(client: OAuthClient, refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
  const tok = await postToken({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })
  if (!tok.access_token) throw new Error('Google did not return an access token. Sign in with Google again in Settings.')
  return { accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in ?? 3600) * 1000 }
}

/** Best-effort: tell Google to drop the grant so the app no longer appears under Third-party access. */
export async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString()
    })
  } catch {
    // Offline: the token stays valid until the user removes it in their Google Account.
  }
}

function closeServer(server: Server): void {
  server.close()
  server.closeAllConnections()
}

function resultPage(ok: boolean): string {
  const msg = ok
    ? 'Signed in. You can close this tab and go back to Expense Tracker.'
    : 'Sign-in did not complete. Close this tab and try again from Expense Tracker.'
  return `<!doctype html><meta charset="utf-8"><title>Expense Tracker</title>
<body style="font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;color:#222">
<p>${msg}</p></body>`
}
