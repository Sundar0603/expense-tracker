import { BrowserWindow } from 'electron'
import { Output, generateText, streamText, stepCountIs, zodSchema } from 'ai'
import { z } from 'zod'
import dayjs from 'dayjs'
import { getAiSettings, getActiveProfile } from './profiles'
import { resolveModel, probeToolSupport } from './providers'
import { makeTools, systemPrompt } from './tools'
import { buildBriefing } from './briefing'
import { getDb } from '../db/connection'
import { listCategories } from '../db/repo/categories'
import type { AiAnswer, AiChatMessage, CategorySuggestion } from '@shared/types'

function active() {
  const p = getActiveProfile()
  if (!p) throw new Error('No AI provider configured. Add one under AI → Provider.')
  return resolveModel(p.id)
}

/**
 * streamText's default onError console.logs the whole error, and an APICallError carries the
 * request body (the prompt, with transaction rows in rows mode). textStream also just ends on
 * an error. Capture it instead and surface only a short message.
 */
function captureStreamError(): { onError: (e: { error: unknown }) => void; rethrow: () => void } {
  let failure: unknown = null
  return {
    onError: ({ error }) => {
      failure ??= error
    },
    rethrow: () => {
      if (failure !== null) throw new Error(safeAiMessage(failure))
    }
  }
}

function safeAiMessage(e: unknown): string {
  const err = e as { message?: unknown; statusCode?: unknown }
  const msg = typeof err?.message === 'string' ? err.message.split('\n')[0]!.slice(0, 200) : 'unknown error'
  return `The AI provider returned an error${typeof err?.statusCode === 'number' ? ` (HTTP ${err.statusCode})` : ''}: ${msg}`
}

async function ensureToolSupport(id: string, current: boolean | null): Promise<boolean> {
  if (current !== null) return current
  return probeToolSupport(id)
}

export async function summarizeMonth(month: string): Promise<AiAnswer> {
  const { model, label } = active()
  const { privacy } = getAiSettings()
  const briefing = buildBriefing(month, privacy)
  const res = await generateText({
    model,
    system: systemPrompt(privacy),
    prompt: `${briefing}\n\nWrite a short monthly spending review for ${dayjs(`${month}-01`).format('MMMM YYYY')}: 1) the headline (total and change vs last month), 2) the two or three categories or payees that explain most of the change or stand out against the 3-month average, 3) budget pace and what to watch for the rest of the month, 4) one practical suggestion. Use short paragraphs or bullets, under 180 words. Do not invent figures that are not in the briefing.`
  })
  return { text: res.text.trim(), mode: 'briefing', model: label }
}

export async function askQuestion(input: { requestId: string; question: string; history: AiChatMessage[] }): Promise<AiAnswer> {
  const resolved = active()
  const { privacy } = getAiSettings()
  const supportsTools = await ensureToolSupport(resolved.id, resolved.supportsTools)
  const send = (delta: string): void => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('ai:chunk', { requestId: input.requestId, delta })
  }
  const history = input.history.slice(-12).map((m) => ({ role: m.role, content: m.content }))

  const errors = captureStreamError()
  if (supportsTools) {
    const result = streamText({
      onError: errors.onError,
      model: resolved.model,
      system: systemPrompt(privacy),
      tools: makeTools(privacy),
      stopWhen: stepCountIs(6),
      messages: [...history, { role: 'user', content: input.question }]
    })
    let full = ''
    for await (const delta of result.textStream) {
      full += delta
      send(delta)
    }
    errors.rethrow()
    return { text: full.trim(), mode: 'tool', model: resolved.label }
  }

  // Briefing mode: pre-compute this month and the previous two, then let the model answer from that.
  const months = [0, 1, 2].map((i) => dayjs().subtract(i, 'month').format('YYYY-MM'))
  const context = months.map((m) => buildBriefing(m, privacy, { maxRows: 150 })).join('\n\n---\n\n')
  const result = streamText({
    onError: errors.onError,
    model: resolved.model,
    system: `${systemPrompt(privacy)} You cannot run queries; answer only from the statistics provided. If the answer is not derivable, say what is missing.`,
    messages: [
      { role: 'user', content: `Here are my spending statistics:\n\n${context}` },
      { role: 'assistant', content: 'Thanks, I have the statistics. What would you like to know?' },
      ...history,
      { role: 'user', content: input.question }
    ]
  })
  let full = ''
  for await (const delta of result.textStream) {
    full += delta
    send(delta)
  }
  errors.rethrow()
  return { text: full.trim(), mode: 'briefing', model: resolved.label }
}

const SuggestionSchema = z.object({
  suggestions: z.array(z.object({ payee: z.string(), category: z.string(), confidence: z.number().min(0).max(1) }))
})

/** Only merchant names (never amounts or dates) are sent to the model. */
export async function suggestCategories(): Promise<CategorySuggestion[]> {
  const { model } = active()
  const cats = listCategories()
  const rows = getDb()
    .prepare(
      `SELECT payee, COUNT(*) AS n, SUM(amount_paise) AS t FROM transactions
       WHERE kind = 'expense' AND category_id IS NULL GROUP BY payee ORDER BY n DESC, t DESC LIMIT 60`
    )
    .all() as { payee: string; n: number; t: number }[]
  if (rows.length === 0) return []
  const prompt = `Categorize each Indian merchant/payee name into exactly one of these categories: ${cats.map((c) => c.name).join(', ')}. Use "Other" when unsure and give a confidence between 0 and 1. Payees:\n${rows.map((r) => `- ${r.payee}`).join('\n')}`
  let parsed: z.infer<typeof SuggestionSchema>
  try {
    const res = await generateText({ model, output: Output.object({ schema: zodSchema(SuggestionSchema) }), prompt })
    parsed = SuggestionSchema.parse(res.output)
  } catch {
    // Models without JSON mode: ask for JSON in text and parse leniently.
    const res = await generateText({ model, prompt: `${prompt}\n\nRespond with JSON only: {"suggestions":[{"payee":"...","category":"...","confidence":0.0}]}` })
    const m = res.text.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('The model did not return JSON')
    parsed = SuggestionSchema.parse(JSON.parse(m[0]))
  }
  const byPayee = new Map(rows.map((r) => [r.payee.toLowerCase(), r]))
  return parsed.suggestions
    .map((s) => {
      const row = byPayee.get(s.payee.toLowerCase())
      const cat = cats.find((c) => c.name.toLowerCase() === s.category.toLowerCase())
      if (!row) return null
      return { payee: row.payee, count: row.n, totalPaise: row.t, categoryId: cat?.id ?? null, categoryName: cat?.name ?? s.category, confidence: s.confidence }
    })
    .filter((x): x is CategorySuggestion => x !== null && x.categoryId !== null)
}
