<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AiChatMessage, AiPreset, AiProfile, AiSettings, AiTestResult, CategorySuggestion } from '@shared/types'
import { formatINR } from '@shared/money'
import { useCategoriesStore } from '../stores/categories'
import { useTransactionsStore } from '../stores/transactions'
import { useBudgetsStore } from '../stores/budgets'
import { guard, useToast } from '../composables/useToast'
import { selectedMonth as month } from '../composables/useMonth'
import MonthPicker from '../components/MonthPicker.vue'
import Modal from '../components/Modal.vue'

const toast = useToast()
const categories = useCategoriesStore()
const settings = ref<AiSettings | null>(null)
const active = computed(() => settings.value?.profiles.find((p) => p.id === settings.value?.activeId) ?? null)

// ----- provider form -----
const PRESETS: { value: AiPreset; label: string; baseUrl: string; model: string; needsKey: boolean }[] = [
  { value: 'ollama', label: 'Ollama (local, free)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', needsKey: false },
  { value: 'lmstudio', label: 'LM Studio (local, free)', baseUrl: 'http://localhost:1234/v1', model: '', needsKey: false },
  { value: 'openrouter', label: 'OpenRouter (any model)', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-5.5', needsKey: true },
  { value: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needsKey: true },
  { value: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', needsKey: true },
  { value: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', needsKey: true },
  { value: 'custom', label: 'Custom OpenAI-compatible URL', baseUrl: 'http://localhost:8080/v1', model: '', needsKey: false }
]
const editing = ref<Partial<AiProfile> | null>(null)
const apiKey = ref('')
const testing = ref(false)
const testResult = ref<AiTestResult | null>(null)
const presetInfo = computed(() => PRESETS.find((p) => p.value === editing.value?.preset) ?? PRESETS[0]!)

function openNew(): void {
  const p = PRESETS[0]!
  editing.value = { id: '', name: '', preset: p.value, baseUrl: p.baseUrl, model: p.model }
  apiKey.value = ''
  testResult.value = null
}
function openEdit(p: AiProfile): void {
  editing.value = { ...p }
  apiKey.value = ''
  testResult.value = null
}
function onPreset(): void {
  const p = PRESETS.find((x) => x.value === editing.value?.preset)
  if (p && editing.value) {
    editing.value.baseUrl = p.baseUrl
    editing.value.model = p.model
    if (!editing.value.id) editing.value.name = p.label
  }
}
const savingProfile = ref(false)
async function saveProfile(): Promise<void> {
  const e = editing.value
  if (!e || savingProfile.value) return
  savingProfile.value = true
  const res = await guard(() => window.api.ai.saveProfile({
    profile: { id: e.id ?? '', name: e.name ?? '', preset: e.preset as AiPreset, baseUrl: e.baseUrl ?? '', model: e.model ?? '' },
    apiKey: apiKey.value || undefined
  }), 'Could not save provider')
  savingProfile.value = false
  if (res) {
    settings.value = res
    const saved = res.profiles.find((p) => p.name === (e.name || presetInfo.value.label) && p.model === e.model) ?? res.profiles[res.profiles.length - 1]
    editing.value = saved ? { ...saved } : null
    apiKey.value = ''
    toast.info('Provider saved')
    if (saved) await testProfile(saved.id)
  }
}
async function testProfile(id: string): Promise<void> {
  testing.value = true
  testResult.value = (await guard(() => window.api.ai.test(id), 'Test failed')) ?? null
  testing.value = false
  settings.value = (await window.api.ai.getSettings()) ?? settings.value
}
async function removeProfile(id: string): Promise<void> {
  settings.value = (await guard(() => window.api.ai.deleteProfile(id))) ?? settings.value
  editing.value = null
}
async function setActive(id: string): Promise<void> {
  settings.value = (await guard(() => window.api.ai.setActive(id))) ?? settings.value
}
async function setPrivacy(mode: 'aggregates' | 'rows'): Promise<void> {
  settings.value = (await guard(() => window.api.ai.setPrivacy(mode))) ?? settings.value
}

// ----- monthly summary -----
const summary = ref<{ text: string; model: string } | null>(null)
const summarizing = ref(false)
// A review belongs to the month it was written for.
watch(month, () => (summary.value = null))
async function summarize(): Promise<void> {
  summarizing.value = true
  const res = await guard(() => window.api.ai.summarize(month.value), 'Summary failed')
  summarizing.value = false
  if (res) summary.value = { text: res.text, model: res.model }
}

// ----- chat -----
const question = ref('')
const messages = ref<(AiChatMessage & { mode?: string })[]>([])
const asking = ref(false)
const chatBox = ref<HTMLElement | null>(null)
let unsubscribe: (() => void) | null = null
let currentRequest = ''
onMounted(async () => {
  settings.value = await window.api.ai.getSettings()
  unsubscribe = window.events.on('ai:chunk', ({ requestId, delta }) => {
    if (requestId !== currentRequest) return
    const last = messages.value[messages.value.length - 1]
    if (last && last.role === 'assistant') last.content += delta
    void nextTick(() => chatBox.value?.scrollTo({ top: chatBox.value.scrollHeight }))
  })
})
onBeforeUnmount(() => unsubscribe?.())

async function ask(): Promise<void> {
  const q = question.value.trim()
  if (!q || asking.value) return
  const history = messages.value.map((m) => ({ role: m.role, content: m.content }))
  messages.value.push({ role: 'user', content: q }, { role: 'assistant', content: '' })
  question.value = ''
  asking.value = true
  currentRequest = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const res = await guard(() => window.api.ai.ask({ requestId: currentRequest, question: q, history }), 'Question failed')
  asking.value = false
  const last = messages.value[messages.value.length - 1]!
  if (res) {
    last.content = res.text || last.content
    last.mode = res.mode
  } else if (!last.content) {
    messages.value.splice(-2, 2)
  }
}

// ----- category suggestions -----
const suggestions = ref<CategorySuggestion[] | null>(null)
const suggesting = ref(false)
async function suggest(): Promise<void> {
  suggesting.value = true
  suggestions.value = (await guard(() => window.api.ai.suggestCategories(), 'Suggestion failed')) ?? null
  suggesting.value = false
  if (suggestions.value && suggestions.value.length === 0) toast.info('Nothing uncategorized to suggest for')
}
async function acceptSuggestion(s: CategorySuggestion, asRule: boolean): Promise<void> {
  if (s.categoryId === null) return
  const ok = await guard(async () => {
    if (asRule) {
      await window.api.rules.create({ field: 'payee', match: 'contains', pattern: s.payee, action: 'categorize', categoryId: s.categoryId, priority: 100, enabled: true })
      await window.api.rules.applyAll()
    } else {
      const rows = await window.api.txn.list({ search: s.payee, categoryId: null, limit: 500 })
      for (const r of rows.filter((r) => r.payee === s.payee)) await window.api.txn.update(r.id, { categoryId: s.categoryId, needsReview: false })
    }
    await Promise.all([useTransactionsStore().load(), useBudgetsStore().load()])
    return true
  })
  if (ok) suggestions.value = suggestions.value?.filter((x) => x.payee !== s.payee) ?? null
}
</script>

<template>
  <div>
    <h1>AI assistant</h1>

    <div class="grid cols-2" style="margin-bottom: 16px">
      <div class="card">
        <div class="row between">
          <h2 style="margin: 0">Provider</h2>
          <button class="sm" @click="openNew">+ Add</button>
        </div>
        <p class="small muted">Works with any OpenAI-compatible API, including local models through Ollama or LM Studio, aggregators like OpenRouter, or direct OpenAI/Anthropic keys.</p>
        <div v-if="!settings?.profiles.length" class="empty" style="padding: 16px">No provider yet. Add one to enable summaries, questions and category suggestions.</div>
        <table v-else>
          <tbody>
            <tr v-for="p in settings.profiles" :key="p.id" class="clickable" @click="openEdit(p)">
              <td style="width: 24px" @click.stop><input type="radio" name="active" :checked="p.id === settings.activeId" @change="setActive(p.id)" /></td>
              <td><strong>{{ p.name }}</strong><div class="small muted mono">{{ p.model }}</div></td>
              <td class="small muted">
                <span v-if="p.supportsTools === true" class="chip" style="--chip: var(--ok)">tools</span>
                <span v-else-if="p.supportsTools === false" class="chip">briefing</span>
                <span v-else class="chip">untested</span>
              </td>
            </tr>
          </tbody>
        </table>
        <h2 style="margin-top: 16px">Privacy</h2>
        <label class="row" style="gap: 8px"><input type="radio" :checked="settings?.privacy === 'aggregates'" @change="setPrivacy('aggregates')" /> Aggregates only: totals, categories, payee rankings. No individual transactions leave the app.</label>
        <label class="row" style="gap: 8px; margin-top: 6px"><input type="radio" :checked="settings?.privacy === 'rows'" @change="setPrivacy('rows')" /> Allow transaction rows: the model can see dates, payees and amounts for row-level questions.</label>
        <p class="small muted" style="margin-bottom: 0">With a local model both modes stay on this Mac.</p>
      </div>

      <div class="card">
        <div class="row between">
          <h2 style="margin: 0">Monthly review</h2>
          <div class="row">
            <MonthPicker v-model="month" />
            <button class="primary sm" :disabled="summarizing || !active" @click="summarize">{{ summarizing ? 'Writing…' : 'Write review' }}</button>
          </div>
        </div>
        <div v-if="summary" class="prose" style="margin-top: 10px; white-space: pre-wrap">{{ summary.text }}</div>
        <p v-if="summary" class="small muted">by {{ summary.model }} · computed from the app's own statistics</p>
        <div v-else class="empty" style="padding: 24px">A short narrative of the month: headline, what changed, budget pace, one suggestion.</div>
      </div>
    </div>

    <div class="grid cols-2">
      <div class="card" style="display: flex; flex-direction: column; min-height: 420px">
        <h2>Ask about your spending</h2>
        <div ref="chatBox" class="chat" style="flex: 1; overflow: auto; margin-bottom: 10px">
          <div v-if="!messages.length" class="empty" style="padding: 20px">
            Try: “How much did I spend on food last month?” · “Top 5 payees since August” · “Am I on track with my budgets?”
          </div>
          <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
            <div style="white-space: pre-wrap">{{ m.content || (asking && i === messages.length - 1 ? '…' : '') }}</div>
            <div v-if="m.mode" class="small muted">{{ m.mode === 'tool' ? 'answered with live queries' : 'answered from pre-computed statistics' }}</div>
          </div>
        </div>
        <form class="row" @submit.prevent="ask">
          <input v-model="question" style="flex: 1" placeholder="Ask a question…" :disabled="!active || asking" />
          <button class="primary" type="submit" :disabled="!active || asking || !question.trim()">Ask</button>
          <button v-if="messages.length" type="button" class="ghost sm" @click="messages = []">Clear</button>
        </form>
      </div>

      <div class="card">
        <div class="row between">
          <h2 style="margin: 0">Category suggestions</h2>
          <button class="sm" :disabled="suggesting || !active" @click="suggest">{{ suggesting ? 'Thinking…' : 'Suggest for uncategorized' }}</button>
        </div>
        <p class="small muted">Only payee names are sent, never amounts or dates. Accept one-off, or turn it into a rule for the future.</p>
        <table v-if="suggestions?.length">
          <tbody>
            <tr v-for="s in suggestions" :key="s.payee">
              <td><strong>{{ s.payee }}</strong><div class="small muted">{{ s.count }} txns · {{ formatINR(s.totalPaise) }}</div></td>
              <td><span class="chip" :style="`--chip: ${categories.color(s.categoryId)}`">{{ categories.icon(s.categoryId) }} {{ s.categoryName }}</span><div class="small muted">{{ Math.round(s.confidence * 100) }}%</div></td>
              <td v-if="categories.byId.get(s.categoryId ?? -1)?.needsNote" class="num small muted">
                {{ s.categoryName }} needs a description for each one.<br /><RouterLink to="/transactions?category=null">Categorize in Transactions</RouterLink>
              </td>
              <td v-else class="num" style="white-space: nowrap">
                <button class="sm" @click="acceptSuggestion(s, false)">Apply</button>
                <button class="sm primary" @click="acceptSuggestion(s, true)">Make rule</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <Modal v-if="editing" :title="editing.id ? 'Edit provider' : 'Add provider'" @close="editing = null">
      <form @submit.prevent="saveProfile">
        <div class="form-grid">
          <label class="field full">
            Provider
            <select v-model="editing.preset" @change="onPreset">
              <option v-for="p in PRESETS" :key="p.value" :value="p.value">{{ p.label }}</option>
            </select>
          </label>
          <label class="field full">
            Name
            <input v-model="editing.name" :placeholder="presetInfo.label" />
          </label>
          <label v-if="editing.preset !== 'openai' && editing.preset !== 'anthropic'" class="field full">
            Base URL
            <input v-model="editing.baseUrl" class="mono" />
          </label>
          <label class="field full">
            Model
            <input v-model="editing.model" class="mono" :list="testResult?.models.length ? 'model-list' : undefined" placeholder="e.g. llama3.1, qwen2.5:14b, gpt-5" />
            <datalist id="model-list"><option v-for="m in testResult?.models ?? []" :key="m" :value="m" /></datalist>
          </label>
          <label class="field full">
            API key {{ presetInfo.needsKey ? '' : '(optional for local servers)' }}
            <input v-model="apiKey" type="password" autocomplete="off" :placeholder="editing.hasKey ? 'Saved in Keychain. Enter to replace.' : ''" />
          </label>
        </div>
        <p v-if="testResult" class="small" :class="testResult.ok ? 'status-ok' : 'status-bad'">{{ testResult.message }}</p>
        <p v-if="testResult?.models.length" class="small muted">{{ testResult.models.length }} models available at this provider; the Model field now autocompletes.</p>
        <div class="actions">
          <button v-if="editing.id" type="button" class="danger" style="margin-right: auto" @click="removeProfile(editing.id!)">Delete</button>
          <button v-if="editing.id" type="button" :disabled="testing" @click="testProfile(editing.id!)">{{ testing ? 'Testing…' : 'Test' }}</button>
          <button type="button" @click="editing = null">Close</button>
          <button type="submit" class="primary" :disabled="savingProfile">Save &amp; test</button>
        </div>
      </form>
    </Modal>
  </div>
</template>
