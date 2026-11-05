import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { generateText, tool, stepCountIs, zodSchema, type LanguageModel } from 'ai'
import { z } from 'zod'
import { PRESET_DEFAULTS, getProfile, markToolSupport } from './profiles'
import type { AiTestResult } from '@shared/types'

export interface ResolvedModel {
  id: string
  model: LanguageModel
  label: string
  supportsTools: boolean | null
}

export function resolveModel(profileId: string): ResolvedModel {
  const p = getProfile(profileId)
  if (!p) throw new Error('AI provider profile not found')
  if (PRESET_DEFAULTS[p.preset].needsKey && !p.apiKey) throw new Error(`${p.name}: an API key is required`)
  let model: LanguageModel
  switch (p.preset) {
    case 'openai':
      model = createOpenAI({ apiKey: p.apiKey ?? undefined })(p.model)
      break
    case 'anthropic':
      model = createAnthropic({ apiKey: p.apiKey ?? undefined })(p.model)
      break
    default: {
      const provider = createOpenAICompatible({
        name: p.preset,
        baseURL: p.baseUrl,
        apiKey: p.apiKey ?? (p.preset === 'ollama' ? 'ollama' : 'none'),
        headers: p.preset === 'openrouter' ? { 'HTTP-Referer': 'https://localhost/expense-tracker', 'X-Title': 'Expense Tracker' } : undefined
      })
      model = provider.chatModel(p.model)
    }
  }
  return { id: p.id, model, label: `${p.name} · ${p.model}`, supportsTools: p.supportsTools }
}

/** List models from an OpenAI-compatible /models endpoint (works for Ollama, LM Studio, OpenRouter, Groq, OpenAI). */
export async function listModels(profileId: string): Promise<string[]> {
  const p = getProfile(profileId)
  if (!p) return []
  if (p.preset === 'anthropic') return ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
  const url = `${p.baseUrl.replace(/\/+$/, '')}/models`
  const headers: Record<string, string> = {}
  if (p.apiKey) headers['Authorization'] = `Bearer ${p.apiKey}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    const json = (await res.json()) as { data?: { id: string }[]; models?: { name: string }[] }
    const ids = (json.data ?? []).map((m) => m.id).concat((json.models ?? []).map((m) => m.name))
    return [...new Set(ids)].sort()
  } finally {
    clearTimeout(timer)
  }
}

/** Ask the model to call a trivial tool. If it does, tool mode is available. */
export async function probeToolSupport(profileId: string): Promise<boolean> {
  const { model } = resolveModel(profileId)
  try {
    const res = await generateText({
      model,
      tools: {
        ping: tool({
          description: 'Returns pong. Call this tool.',
          inputSchema: zodSchema(z.object({ value: z.string().describe('any short string') })),
          execute: async ({ value }) => `pong:${value}`
        })
      },
      stopWhen: stepCountIs(2),
      prompt: 'Call the ping tool with the value "test" and then reply with the result.'
    })
    const called = res.steps.some((s) => s.toolCalls.length > 0)
    markToolSupport(profileId, called)
    return called
  } catch {
    markToolSupport(profileId, false)
    return false
  }
}

export async function testProfile(profileId: string): Promise<AiTestResult> {
  let models: string[] = []
  try {
    models = await listModels(profileId)
  } catch {
    models = []
  }
  try {
    const { model, label } = resolveModel(profileId)
    const res = await generateText({ model, prompt: 'Reply with the single word OK.' })
    if (!res.text) throw new Error('Empty response')
    const supportsTools = await probeToolSupport(profileId)
    return {
      ok: true,
      message: `${label} responded. ${supportsTools ? 'Tool calling works, so questions use live queries.' : 'No tool calling, so the app will pre-compute statistics for the model (briefing mode).'}`,
      supportsTools,
      models
    }
  } catch (e) {
    return { ok: false, message: friendly(e), supportsTools: null, models }
  }
}

function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/ECONNREFUSED|fetch failed/i.test(msg)) return `Could not connect. Is the local server running? (${msg})`
  if (/401|403|Unauthorized|invalid.*key/i.test(msg)) return `The provider rejected the API key (${msg})`
  if (/404|not found|does not exist|No such model/i.test(msg)) return `Model not found at this provider (${msg})`
  return msg
}
