import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  GMAIL_SCOPE,
  buildAuthUrl,
  emailFromIdToken,
  pkcePair,
  refreshAccessToken,
  signIn,
  validateOAuthClient
} from '../src/main/mail/google-oauth'

const client = { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' }
const realFetch = globalThis.fetch

function idToken(claims: object): string {
  const b = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b({ alg: 'RS256' })}.${b(claims)}.sig`
}

/** Mock only Google's token endpoint; let the test's own loopback requests through. */
function mockTokenEndpoint(body: object, status = 200): { calls: URLSearchParams[] } {
  const calls: URLSearchParams[] = []
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
      calls.push(new URLSearchParams(String(init?.body)))
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    }
    if (String(url).startsWith('https://oauth2.googleapis.com/revoke')) return new Response('{}')
    return realFetch(url, init)
  })
  return { calls }
}

/** Plays the browser: follows Google's redirect back to the loopback server. */
function browserRedirect(params: (auth: URL) => Record<string, string>): (url: string) => Promise<void> {
  return async (url) => {
    const auth = new URL(url)
    const back = new URL(auth.searchParams.get('redirect_uri')!)
    back.search = new URLSearchParams(params(auth)).toString()
    setTimeout(() => void realFetch(back).then((r) => r.text()), 0)
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('google oauth helpers', () => {
  it('validates the OAuth client', () => {
    expect(validateOAuthClient({ clientId: ` ${client.clientId} `, clientSecret: ' s ' })).toEqual({ clientId: client.clientId, clientSecret: 's' })
    expect(() => validateOAuthClient({ clientId: 'nope', clientSecret: 's' })).toThrow(/apps\.googleusercontent\.com/)
    expect(() => validateOAuthClient({ clientId: client.clientId, clientSecret: '' })).toThrow(/secret/)
  })

  it('builds an S256 PKCE pair', () => {
    const { verifier, challenge } = pkcePair()
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
  })

  it('asks for offline Gmail access with PKCE', () => {
    const u = new URL(buildAuthUrl({ clientId: 'id', redirectUri: 'http://127.0.0.1:5000', state: 's', challenge: 'c', loginHint: 'me@gmail.com' }))
    expect(u.searchParams.get('scope')?.split(' ')).toContain(GMAIL_SCOPE)
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('login_hint')).toBe('me@gmail.com')
  })

  it('reads the email from an id_token', () => {
    expect(emailFromIdToken(idToken({ email: 'me@gmail.com' }))).toBe('me@gmail.com')
    expect(emailFromIdToken('garbage')).toBeNull()
  })
})

describe('signIn', () => {
  it('exchanges the code from the loopback redirect for tokens', async () => {
    const { calls } = mockTokenEndpoint({
      access_token: 'at',
      expires_in: 3599,
      refresh_token: 'rt',
      id_token: idToken({ email: 'me@gmail.com' }),
      scope: `openid ${GMAIL_SCOPE} https://www.googleapis.com/auth/userinfo.email`
    })
    const res = await signIn(client, browserRedirect((a) => ({ code: 'the-code', state: a.searchParams.get('state')! })))
    expect(res).toMatchObject({ email: 'me@gmail.com', refreshToken: 'rt', accessToken: 'at' })
    expect(calls[0]!.get('code')).toBe('the-code')
    expect(calls[0]!.get('code_verifier')).toBeTruthy()
    expect(calls[0]!.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('rejects a redirect with the wrong state', async () => {
    mockTokenEndpoint({})
    await expect(signIn(client, browserRedirect(() => ({ code: 'c', state: 'forged' })))).rejects.toThrow(/unexpected response/)
  })

  it('reports a cancelled consent', async () => {
    mockTokenEndpoint({})
    await expect(signIn(client, browserRedirect(() => ({ error: 'access_denied' })))).rejects.toThrow(/cancelled/)
  })

  it('fails when the Gmail permission was unticked', async () => {
    mockTokenEndpoint({ access_token: 'at', refresh_token: 'rt', id_token: idToken({ email: 'me@gmail.com' }), scope: 'openid email' })
    await expect(signIn(client, browserRedirect((a) => ({ code: 'c', state: a.searchParams.get('state')! })))).rejects.toThrow(/Gmail access was not granted/)
  })
})

describe('refreshAccessToken', () => {
  it('explains an expired or revoked grant', async () => {
    mockTokenEndpoint({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)
    await expect(refreshAccessToken(client, 'rt')).rejects.toThrow(/expired.*Sign in again/)
  })
})
