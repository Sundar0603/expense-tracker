import { app, type BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { askQuestion, suggestCategories, summarizeMonth } from './ai'
import { getAiSettings } from './ai/profiles'
import { testProfile } from './ai/providers'
import { fetchAlerts, getGmailConfig, recentSenders, testGmail } from './mail/gmail'
import { parseHdfcAlert } from './parsers/hdfc-email'
import { trackingStart } from './core/tracking-start'

/**
 * Development aid: when ET_SCREENSHOT_DIR is set, visit each route in ET_ROUTES
 * (comma separated hash routes, default "/"), save a PNG per route, then quit.
 * Never active in normal use.
 */
export function installDevHooks(win: BrowserWindow): void {
  if (process.env['ET_AI_SMOKE']) {
    void runAiSmoke(process.env['ET_AI_SMOKE'])
    return
  }
  if (process.env['ET_GMAIL_SMOKE']) {
    void runGmailSmoke(process.env['ET_GMAIL_SMOKE'])
    return
  }
  const dir = process.env['ET_SCREENSHOT_DIR']
  if (!dir) return
  // ET_UI_SCRIPT: renderer JS split into steps by `//--- <name>` lines. Each step is an async
  // function body sharing `window.__t`; its return value and a screenshot are saved per step,
  // with console warnings/errors. Development aid only.
  const uiScript = process.env['ET_UI_SCRIPT']
  if (uiScript) {
    mkdirSync(dir, { recursive: true })
    const consoleLog: string[] = []
    win.webContents.on('console-message', (e) => {
      const { level, message } = e as unknown as { level: string | number; message: string }
      if (level === 'warning' || level === 'error' || (typeof level === 'number' && level >= 2)) consoleLog.push(`[${level}] ${message}`)
    })
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 800))
      const steps = readFileSync(uiScript, 'utf8').split(/^\/\/--- */m).filter((x) => x.trim())
      const results: Record<string, unknown> = {}
      for (const step of steps) {
        const nl = step.indexOf('\n')
        const name = step.slice(0, nl).trim().replace(/[^a-z0-9-]+/gi, '_') || 'step'
        const body = step.slice(nl + 1)
        results[name] = await win.webContents
          .executeJavaScript(`(async () => { window.__t = window.__t || {}; const t = window.__t; ${body} })()`)
          .catch((err: unknown) => `script error: ${err instanceof Error ? err.message : String(err)}`)
        writeFileSync(join(dir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
      }
      results['console'] = consoleLog
      writeFileSync(join(dir, 'ui-script.json'), JSON.stringify(results, null, 2))
      app.quit()
    })
    return
  }
  const routes = (process.env['ET_ROUTES'] ?? '/').split(',').map((r) => r.trim())
  mkdirSync(dir, { recursive: true })
  win.webContents.once('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 800))
    for (const route of routes) {
      await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + route)}; true`)
      await new Promise((r) => setTimeout(r, 900))
      const img = await win.webContents.capturePage()
      const name = route === '/' ? 'dashboard' : route.replace(/^\//, '').replace(/[^a-z0-9-]+/gi, '_')
      writeFileSync(join(dir, `${name}.png`), img.toPNG())
    }
    app.quit()
  })
}

/** Development aid: exercise the AI pipeline against the active provider and write results to a file. */
async function runAiSmoke(outFile: string): Promise<void> {
  const out: Record<string, unknown> = {}
  const t0 = Date.now()
  try {
    const settings = getAiSettings()
    out['active'] = settings.activeId
    if (settings.activeId) out['test'] = await testProfile(settings.activeId)
    out['summary'] = await summarizeMonth(new Date().toISOString().slice(0, 7))
    out['ask'] = await askQuestion({ requestId: 'smoke', question: 'How much did I spend on food this month, and what was the biggest single expense?', history: [] })
    out['suggest'] = await suggestCategories()
  } catch (e) {
    out['error'] = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)
  }
  out['ms'] = Date.now() - t0
  writeFileSync(outFile, JSON.stringify(out, null, 2))
  app.quit()
}

/**
 * Development aid: connect to Gmail with the saved credentials, run the same search Sync uses,
 * parse each alert and report counts only. Nothing is inserted and no message content is written.
 */
async function runGmailSmoke(outFile: string): Promise<void> {
  const out: Record<string, unknown> = {}
  try {
    const cfg = getGmailConfig()
    // Length only; never the value.
    out['credentials'] = cfg
      ? { user: cfg.user, auth: cfg.auth.kind, ...(cfg.auth.kind === 'password' ? { passwordLength: cfg.auth.pass.length } : {}) }
      : null
    out['test'] = await testGmail()
    out['hdfcSenders30d'] = await recentSenders('hdfc', 30)
    const counts = { fetched: 0, parsed: 0, unparsed: 0, lowConfidence: 0, beforeStart: 0, errors: [] as string[] }
    const start = trackingStart()
    const r = await fetchAlerts({
      since: new Date(start),
      afterUid: 0,
      onMessage: ({ mail, internalDate }) => {
        const parsed = parseHdfcAlert({
          subject: mail.subject ?? null,
          text: mail.text ?? null,
          html: typeof mail.html === 'string' ? mail.html : null,
          date: mail.date ?? internalDate
        })
        if (!parsed) counts.unparsed++
        else {
          counts.parsed++
          if (parsed.confidence === 'low') counts.lowConfidence++
          if (parsed.postedAt.slice(0, 10) < start) counts.beforeStart++
        }
      },
      onError: (uid, err) => counts.errors.push(`uid ${uid}: ${err instanceof Error ? err.message : String(err)}`)
    })
    counts.fetched = r.fetched
    out['trackingStart'] = start
    out['fetch'] = { ...counts, maxUid: r.maxUid, uidValidity: r.uidValidity }
  } catch (e) {
    out['error'] = e instanceof Error ? e.message : String(e)
  }
  writeFileSync(outFile, JSON.stringify(out, null, 2))
  app.quit()
}
