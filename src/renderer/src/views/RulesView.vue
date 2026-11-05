<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { Rule, RuleAction, RuleField, RuleMatch } from '@shared/types'
import { useCategoriesStore } from '../stores/categories'
import { useTransactionsStore } from '../stores/transactions'
import { useBudgetsStore } from '../stores/budgets'
import { guard, useToast } from '../composables/useToast'
import Modal from '../components/Modal.vue'

const categories = useCategoriesStore()
const toast = useToast()

const rules = ref<Rule[]>([])
const editing = ref<Rule | null>(null)
const creating = ref(false)
const field = ref<RuleField>('any')
const match = ref<RuleMatch>('contains')
const pattern = ref('')
const action = ref<RuleAction>('categorize')
const categoryId = ref<number | null>(null)
const priority = ref(100)
const enabled = ref(true)
const previewCount = ref<number | null>(null)
const applying = ref(false)
const confirmDelete = ref<Rule | null>(null)

async function load(): Promise<void> {
  rules.value = await window.api.rules.list()
}
onMounted(load)

function openCreate(): void {
  field.value = 'any'
  match.value = 'contains'
  pattern.value = ''
  action.value = 'categorize'
  categoryId.value = categories.items[0]?.id ?? null
  priority.value = 100
  enabled.value = true
  previewCount.value = null
  creating.value = true
}
function openEdit(r: Rule): void {
  field.value = r.field
  match.value = r.match
  pattern.value = r.pattern
  action.value = r.action
  categoryId.value = r.categoryId
  priority.value = r.priority
  enabled.value = r.enabled
  previewCount.value = null
  editing.value = r
}
const draft = computed<Omit<Rule, 'id'>>(() => ({
  field: field.value,
  match: match.value,
  pattern: pattern.value,
  action: action.value,
  categoryId: action.value === 'categorize' ? categoryId.value : null,
  priority: priority.value,
  enabled: enabled.value
}))
// v-model.number leaves '' in an emptied number input, which would sort the rule unpredictably.
const valid = computed(
  () =>
    pattern.value.trim().length > 0 &&
    Number.isInteger(priority.value) &&
    priority.value >= 1 &&
    (action.value !== 'categorize' || categoryId.value !== null)
)

let previewTimer: ReturnType<typeof setTimeout> | undefined
watch(draft, (d) => {
  clearTimeout(previewTimer)
  if (!d.pattern.trim()) {
    previewCount.value = null
    return
  }
  previewTimer = setTimeout(async () => {
    try {
      previewCount.value = await window.api.rules.preview(d)
    } catch {
      previewCount.value = null
    }
  }, 300)
}, { deep: true })

async function save(): Promise<void> {
  if (!valid.value) return
  const ok = editing.value
    ? await guard(() => window.api.rules.update(editing.value!.id, draft.value), 'Could not save rule')
    : await guard(() => window.api.rules.create(draft.value), 'Could not create rule')
  if (ok !== undefined) {
    creating.value = false
    editing.value = null
    toast.info('Rule saved. Use "Re-apply rules" to update existing transactions.')
    await load()
  }
}
async function remove(): Promise<void> {
  if (!confirmDelete.value) return
  const id = confirmDelete.value.id
  await guard(() => window.api.rules.delete(id), 'Could not delete rule')
  confirmDelete.value = null
  editing.value = null
  await load()
}
async function toggle(r: Rule): Promise<void> {
  await guard(() => window.api.rules.update(r.id, { enabled: !r.enabled }))
  await load()
}
async function applyAll(): Promise<void> {
  applying.value = true
  const res = await guard(() => window.api.rules.applyAll(), 'Could not apply rules')
  applying.value = false
  if (res) {
    toast.info(`Rules re-applied. ${res.updated} transaction${res.updated === 1 ? '' : 's'} updated.`)
    await Promise.all([useTransactionsStore().load(), useBudgetsStore().load()])
  }
}

const actionLabel: Record<RuleAction, string> = { ignore: 'Ignore', categorize: 'Categorize', transfer: 'Mark as transfer' }
const fieldLabel: Record<RuleField, string> = { payee: 'Payee', vpa: 'UPI ID', narration: 'Narration', any: 'Any field' }
</script>

<template>
  <div>
    <div class="row between" style="margin-bottom: 16px">
      <h1 style="margin: 0">Rules</h1>
      <div class="row">
        <button :disabled="applying" @click="applyAll">Re-apply rules</button>
        <button class="primary" @click="openCreate">+ New rule</button>
      </div>
    </div>
    <p class="small muted" style="margin: -8px 0 14px">
      Rules run on every imported transaction, top to bottom by priority (lower number first). The first match wins.
      Use <em>Ignore</em> for things that aren't expenses (investments, Zerodha), <em>Mark as transfer</em> for moving your own money,
      and <em>Categorize</em> to auto-assign a category.
    </p>
    <div class="card" style="padding: 0">
      <table v-if="rules.length">
        <thead>
          <tr><th>On</th><th>Priority</th><th>When</th><th>Then</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rules" :key="r.id" class="clickable" :style="r.enabled ? '' : 'opacity:.5'" @click="openEdit(r)">
            <td @click.stop><input type="checkbox" :checked="r.enabled" @change="toggle(r)" /></td>
            <td class="mono">{{ r.priority }}</td>
            <td>
              <span class="muted">{{ fieldLabel[r.field] }}</span>
              {{ r.match === 'contains' ? 'contains' : 'matches' }}
              <code class="mono">{{ r.pattern }}</code>
            </td>
            <td>
              <span class="chip" :style="r.action === 'ignore' ? '--chip: var(--fg-muted)' : r.action === 'transfer' ? '--chip: var(--accent)' : `--chip: ${categories.color(r.categoryId)}`">
                {{ actionLabel[r.action] }}<template v-if="r.action === 'categorize'"> → {{ categories.icon(r.categoryId) }} {{ categories.name(r.categoryId) }}</template>
              </span>
            </td>
            <td class="num" @click.stop><button class="ghost sm danger" title="Delete rule" @click="confirmDelete = r">✕</button></td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">No rules yet.</div>
    </div>

    <Modal v-if="creating || editing" :title="editing ? 'Edit rule' : 'New rule'" @close="creating = false; editing = null">
      <form @submit.prevent="save">
        <div class="form-grid">
          <label class="field">
            Look at
            <select v-model="field">
              <option value="any">Any field</option>
              <option value="payee">Payee / merchant</option>
              <option value="vpa">UPI ID</option>
              <option value="narration">Bank narration</option>
            </select>
          </label>
          <label class="field">
            Match type
            <select v-model="match">
              <option value="contains">Contains text</option>
              <option value="regex">Regular expression</option>
            </select>
          </label>
          <label class="field full">
            Pattern
            <input v-model="pattern" :placeholder="match === 'contains' ? 'e.g. zerodha' : 'e.g. swiggy|zomato'" autofocus />
            <span v-if="previewCount !== null" class="small muted">Matches {{ previewCount }} existing transaction{{ previewCount === 1 ? '' : 's' }}</span>
          </label>
          <label class="field">
            Action
            <select v-model="action">
              <option value="categorize">Categorize</option>
              <option value="ignore">Ignore (not an expense)</option>
              <option value="transfer">Mark as transfer</option>
            </select>
          </label>
          <label v-if="action === 'categorize'" class="field">
            Category
            <select v-model="categoryId">
              <option v-for="c in categories.items" :key="c.id" :value="c.id">{{ c.icon }} {{ c.name }}</option>
            </select>
          </label>
          <label class="field">
            Priority (lower runs first)
            <input v-model.number="priority" type="number" min="1" max="1000" />
          </label>
          <label class="field row" style="flex-direction: row; align-items: center; gap: 8px; padding-top: 18px">
            <input v-model="enabled" type="checkbox" /> Enabled
          </label>
        </div>
        <div class="actions">
          <button v-if="editing" type="button" class="danger" style="margin-right: auto" @click="confirmDelete = editing">Delete</button>
          <button type="button" @click="creating = false; editing = null">Cancel</button>
          <button type="submit" class="primary" :disabled="!valid">Save</button>
        </div>
      </form>
    </Modal>
    <Modal v-if="confirmDelete" title="Delete rule?" @close="confirmDelete = null">
      <p>
        <span class="muted">{{ fieldLabel[confirmDelete.field] }}</span>
        {{ confirmDelete.match === 'contains' ? 'contains' : 'matches' }}
        <code class="mono">{{ confirmDelete.pattern }}</code> → {{ actionLabel[confirmDelete.action] }}<template v-if="confirmDelete.action === 'categorize'"> {{ categories.icon(confirmDelete.categoryId) }} {{ categories.name(confirmDelete.categoryId) }}</template>
      </p>
      <p class="small muted">Transactions it already sorted stay as they are until you press “Re-apply rules”. New transactions won't be matched by it. This cannot be undone.</p>
      <div class="actions">
        <button @click="confirmDelete = null">Cancel</button>
        <button class="danger" @click="remove">Delete rule</button>
      </div>
    </Modal>
  </div>
</template>
