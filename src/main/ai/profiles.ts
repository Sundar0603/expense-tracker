import { randomUUID } from 'node:crypto'
import { getSetting, setSetting } from '../db/repo/settings'
import { deleteSecret, getSecret, setSecret } from '../mail/secrets'
import type { AiPreset, AiPrivacy, AiProfile, AiSettings } from '@shared/types'

interface StoredProfile {
  id: string
  name: string
  preset: AiPreset
  baseUrl: string
  model: string
  supportsTools: boolean | null
}

export const PRESET_DEFAULTS: Record<AiPreset, { name: string; baseUrl: string; model: string; needsKey: boolean }> = {
  ollama: { name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', needsKey: false },
  lmstudio: { name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', model: '', needsKey: false },
  openrouter: { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-5.5', needsKey: true },
  groq: { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', needsKey: true },
  anthropic: { name: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', needsKey: true },
  custom: { name: 'Custom OpenAI-compatible', baseUrl: 'http://localhost:8080/v1', model: '', needsKey: false }
}

function load(): StoredProfile[] {
  try {
    return JSON.parse(getSetting('ai_profiles') ?? '[]') as StoredProfile[]
  } catch {
    return []
  }
}
function save(list: StoredProfile[]): void {
  setSetting('ai_profiles', JSON.stringify(list))
}

export function getAiSettings(): AiSettings {
  const profiles = load().map<AiProfile>((p) => ({ ...p, hasKey: getSecret(`ai_key:${p.id}`) !== null }))
  const activeId = getSetting('ai_active') || null
  const privacy = (getSetting('ai_privacy') as AiPrivacy | null) ?? 'aggregates'
  return { profiles, activeId: profiles.some((p) => p.id === activeId) ? activeId : (profiles[0]?.id ?? null), privacy }
}

export function saveProfile(input: Omit<AiProfile, 'hasKey' | 'supportsTools'>, apiKey?: string): AiSettings {
  const list = load()
  const id = input.id || randomUUID()
  const existing = list.find((p) => p.id === id)
  const next: StoredProfile = {
    id,
    name: input.name.trim() || PRESET_DEFAULTS[input.preset].name,
    preset: input.preset,
    baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
    model: input.model.trim(),
    supportsTools: existing && existing.model === input.model.trim() && existing.baseUrl === input.baseUrl.trim() ? existing.supportsTools : null
  }
  if (!next.model) throw new Error('Enter a model name')
  if (existing) Object.assign(existing, next)
  else list.push(next)
  save(list)
  if (apiKey && apiKey.trim()) setSecret(`ai_key:${id}`, apiKey.trim())
  if (!getSetting('ai_active')) setSetting('ai_active', id)
  return getAiSettings()
}

export function deleteProfile(id: string): AiSettings {
  save(load().filter((p) => p.id !== id))
  deleteSecret(`ai_key:${id}`)
  if (getSetting('ai_active') === id) setSetting('ai_active', '')
  return getAiSettings()
}

export function setActive(id: string): AiSettings {
  setSetting('ai_active', id)
  return getAiSettings()
}

export function setPrivacy(mode: AiPrivacy): AiSettings {
  setSetting('ai_privacy', mode)
  return getAiSettings()
}

export function markToolSupport(id: string, supports: boolean): void {
  const list = load()
  const p = list.find((x) => x.id === id)
  if (p) {
    p.supportsTools = supports
    save(list)
  }
}

export function getProfile(id: string): (StoredProfile & { apiKey: string | null }) | null {
  const p = load().find((x) => x.id === id)
  return p ? { ...p, apiKey: getSecret(`ai_key:${p.id}`) } : null
}

export function getActiveProfile(): (StoredProfile & { apiKey: string | null }) | null {
  const { activeId } = getAiSettings()
  return activeId ? getProfile(activeId) : null
}
