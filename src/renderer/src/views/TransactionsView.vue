<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { Category, CategoryPart, SplitShareInput, Transaction, TxnKind } from '@shared/types'
import { formatINR } from '@shared/money'
import { useTransactionsStore } from '../stores/transactions'
import { useBudgetsStore } from '../stores/budgets'
import { useCategoriesStore } from '../stores/categories'
import { useFriendsStore } from '../stores/friends'
import { guard, useToast } from '../composables/useToast'
import { fmtDateTime, monthLabel } from '../composables/useDates'
import { selectedMonth } from '../composables/useMonth'
import MonthPicker from '../components/MonthPicker.vue'
import Modal from '../components/Modal.vue'
import TxnForm from '../components/TxnForm.vue'
import CategoryManager from '../components/CategoryManager.vue'

const store = useTransactionsStore()
const categories = useCategoriesStore()
const friends = useFriendsStore()
const toast = useToast()
const route = useRoute()

const showAdd = ref(false)
const editing = ref<Transaction | null>(null)
const saving = ref(false)
const confirmDelete = ref<Transaction | null>(null)
// The filter lives in the store and survives navigation; keep the box in step with it.
const search = ref(store.filter.search ?? '')
/** After recategorizing a bank transaction, offer to make it a rule. */
const ruleOffer = ref<{ txn: Transaction; categoryId: number } | null>(null)
const ruleField = ref<'payee' | 'vpa'>('payee')
/** Category manager modal; with a transaction, the category created there is assigned to it. */
const manageCategories = ref<{ assignTo: Transaction | null } | null>(null)
/** Filing an expense under a category that needs a description (e.g. Other) from the list. */
const describe = ref<{ txn: Transaction; categoryId: number; note: string } | null>(null)
/** Filed under a catch-all category without saying what it was (a rule can do that). */
function needsDescription(t: Transaction): boolean {
  if (t.kind !== 'expense' || t.note?.trim()) return false
  return [t.categoryId, ...t.categoryParts.map((p) => p.categoryId)].some((id) => id !== null && categories.byId.get(id)?.needsNote)
}
/** Marking an incoming payment as a friend paying back their share. */
const payback = ref<{ txn: Transaction; name: string } | null>(null)
const paybackFriend = computed(() => {
  const name = payback.value?.name.trim().toLowerCase()
  return name ? (friends.items.find((f) => f.name.toLowerCase() === name) ?? null) : null
})

onMounted(() => {
  const review = route.query['review'] === '1'
  const category = route.query['category']
  if (review || typeof category === 'string') {
    // A deep link (dashboard card) asks for exactly that view, not whatever filter was left behind.
    store.filter = { kind: 'all', limit: store.filter.limit ?? 100, offset: 0 }
    search.value = ''
    // The review count on the dashboard covers every month; category totals cover the month it shows.
    store.allTime = review
    if (review) store.filter.needsReview = true
    if (typeof category === 'string') store.filter.categoryId = category === 'null' ? null : Number(category)
  }
  void store.load()
  void friends.load()
})

let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(search, (v) => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    store.filter.search = v
    store.filter.offset = 0
    void store.load()
  }, 250)
})

const month = computed<string | null>({
  get: () => (store.allTime ? null : selectedMonth.value),
  set: (m) => {
    store.allTime = m === null
    if (m !== null) selectedMonth.value = m
    store.filter.offset = 0
    void store.load()
  }
})

function setKind(k: TxnKind | 'all'): void {
  store.filter.kind = k
  store.filter.offset = 0
  void store.load()
}
function setCategory(e: Event): void {
  const v = (e.target as HTMLSelectElement).value
  store.filter.categoryId = v === '' ? undefined : v === 'null' ? null : Number(v)
  store.filter.offset = 0
  void store.load()
}
function toggleReview(): void {
  store.filter.needsReview = store.filter.needsReview ? undefined : true
  store.filter.offset = 0
  void store.load()
}
function page(delta: number): void {
  const limit = store.filter.limit ?? 100
  store.filter.offset = Math.max(0, (store.filter.offset ?? 0) + delta * limit)
  void store.load()
}

/** Name the counterparty column for what the filter shows: who was paid, who paid, or either. */
const payeeHeader = computed(() => {
  const k = store.filter.kind
  if (k === 'expense') return 'Paid to'
  if (k === 'income' || k === 'settlement') return 'Received from'
  return 'Payee'
})

const pageInfo = computed(() => {
  const limit = store.filter.limit ?? 100
  const from = (store.filter.offset ?? 0) + 1
  const to = Math.min(store.total, (store.filter.offset ?? 0) + limit)
  return store.total === 0 ? 'No transactions' : `${from}–${to} of ${store.total}`
})

type SavePayload = {
  create?: Parameters<typeof store.create>[0]
  patch?: Parameters<typeof store.update>[1]
  split?: SplitShareInput[]
  parts?: CategoryPart[]
}

async function onSave(payload: SavePayload): Promise<void> {
  if (saving.value) return
  saving.value = true
  try {
    await saveTxn(payload)
  } finally {
    saving.value = false
  }
}

async function saveTxn(payload: SavePayload): Promise<void> {
  const { split, parts } = payload
  if (payload.create) {
    const created = await guard(() => store.create(payload.create!), 'Could not add')
    if (created && split?.length) await guard(() => store.setSplit(created.id, split), 'Added, but the split was not saved')
    if (created && parts?.length) await guard(() => store.setCategorySplit(created.id, parts), 'Added, but the category split was not saved')
    if (created) {
      showAdd.value = false
      toast.info('Added')
    }
  } else if (payload.patch && editing.value) {
    const before = editing.value
    const ok = await guard(async () => {
      // A new amount is checked against the friends' shares, so drop the old shares before changing both.
      if (split && payload.patch!.amountPaise !== undefined && before.mySharePaise != null) await store.setSplit(before.id, [])
      let t = await store.update(before.id, payload.patch!)
      if (split) t = await store.setSplit(before.id, split)
      // Last: the parts must add up to the user's share, which the steps above may have changed.
      if (parts) t = await store.setCategorySplit(before.id, parts)
      return t
    }, 'Could not save')
    if (ok !== undefined) {
      editing.value = null
      toast.info('Saved')
      // A rule can only file a payee under one category.
      if (!parts?.length) offerRule(before, payload.patch.categoryId)
    }
  }
}

async function doDelete(): Promise<void> {
  if (!confirmDelete.value) return
  const id = confirmDelete.value.id
  const ok = await guard(() => store.remove(id), 'Could not delete')
  if (ok !== undefined) toast.info('Deleted permanently')
  confirmDelete.value = null
}

async function quickCategory(t: Transaction, e: Event): Promise<void> {
  const select = e.target as HTMLSelectElement
  if (select.value === 'new') {
    // Keep showing the current category until the new one exists.
    select.value = t.categoryId === null ? 'null' : String(t.categoryId)
    manageCategories.value = { assignTo: t }
    return
  }
  const id = select.value === 'null' ? null : Number(select.value)
  if (id !== null && categories.byId.get(id)?.needsNote && !t.note?.trim()) {
    // Ask what it was first; until then the row keeps its current category.
    select.value = t.categoryId === null ? 'null' : String(t.categoryId)
    describe.value = { txn: t, categoryId: id, note: '' }
    return
  }
  await setTxnCategory(t, id)
}

async function saveDescribed(): Promise<void> {
  if (!describe.value?.note.trim()) return
  const { txn, categoryId, note } = describe.value
  const ok = await guard(() => store.update(txn.id, { categoryId, note: note.trim(), needsReview: false }), 'Could not save')
  if (ok !== undefined) {
    describe.value = null
    toast.info(`Filed under ${categories.name(categoryId)}`)
  }
}

async function setTxnCategory(t: Transaction, categoryId: number | null): Promise<void> {
  const ok = await guard(() => store.update(t.id, { categoryId, needsReview: false }), 'Could not update')
  if (ok !== undefined) offerRule(t, categoryId)
}

async function onCategoryCreated(c: Category): Promise<void> {
  const t = manageCategories.value?.assignTo
  if (!t) return
  manageCategories.value = null
  await setTxnCategory(t, c.id)
}

async function savePayback(): Promise<void> {
  if (!payback.value?.name.trim()) return
  const { txn, name } = payback.value
  const ok = await guard(async () => {
    const friendId = await window.api.friends.ensure(name)
    return store.update(txn.id, { kind: 'settlement', friendId, needsReview: false })
  }, 'Could not save')
  if (ok !== undefined) {
    payback.value = null
    toast.info(`Marked as ${friends.name(ok.friendId)} paying you back`)
  }
}

/** Offer a rule when a bank transaction moves to a new category. UPI IDs are steadier than parsed names. */
function offerRule(t: Transaction, categoryId: number | null | undefined): void {
  if (categoryId == null || t.source === 'manual' || t.categoryId === categoryId) return
  // Each expense in a catch-all category needs its own description, so a rule would not help.
  if (categories.byId.get(categoryId)?.needsNote) return
  ruleField.value = t.vpa ? 'vpa' : 'payee'
  ruleOffer.value = { txn: t, categoryId }
}

async function createRuleFromOffer(): Promise<void> {
  if (!ruleOffer.value) return
  const { txn, categoryId } = ruleOffer.value
  const pattern = ruleField.value === 'vpa' && txn.vpa ? txn.vpa : txn.payee
  const ok = await guard(
    () => window.api.rules.create({ field: ruleField.value, match: 'contains', pattern, action: 'categorize', categoryId, priority: 100, enabled: true }),
    'Could not create rule'
  )
  if (ok) {
    const res = await guard(() => window.api.rules.applyAll())
    await Promise.all([store.load(), useBudgetsStore().load()])
    toast.info(`Rule created${res ? `, ${res.updated} transaction${res.updated === 1 ? '' : 's'} updated` : ''}`)
  }
  ruleOffer.value = null
}

const kindLabel: Record<TxnKind, string> = { expense: 'Expense', income: 'Income', transfer: 'Transfer', ignored: 'Ignored', settlement: 'Payback' }
const channelLabel: Record<Transaction['channel'], string> = {
  upi: 'UPI', card: 'Card', neft: 'NEFT', imps: 'IMPS', ach: 'Auto-debit', atm: 'ATM', cash: 'Cash', manual: 'Manual', other: 'Other'
}
</script>

<template>
  <div>
    <div class="row between" style="margin-bottom: 16px">
      <h1 style="margin: 0">Transactions</h1>
      <div class="row">
        <MonthPicker v-model="month" allow-all />
        <button class="primary" @click="showAdd = true">+ Add expense</button>
      </div>
    </div>

    <div class="card" style="margin-bottom: 14px">
      <div class="row wrap">
        <input v-model="search" placeholder="Search payee, narration, note…" style="width: 260px" />
        <select :value="store.filter.categoryId === undefined ? '' : String(store.filter.categoryId)" @change="setCategory">
          <option value="">All categories</option>
          <option value="null">Uncategorized</option>
          <option v-for="c in categories.items" :key="c.id" :value="String(c.id)">{{ c.icon }} {{ c.name }}</option>
        </select>
        <button class="sm" title="Add or delete categories" @click="manageCategories = { assignTo: null }">Manage categories</button>
        <div class="row" style="gap: 4px">
          <button v-for="k in (['all', 'expense', 'income', 'settlement', 'transfer', 'ignored'] as const)" :key="k" class="sm"
            :class="{ primary: store.filter.kind === k }" @click="setKind(k)">
            {{ k === 'all' ? 'All' : kindLabel[k] }}
          </button>
        </div>
        <button class="sm" :class="{ primary: store.filter.needsReview }" @click="toggleReview">Needs review</button>
        <span class="spacer" />
        <span class="small muted">{{ pageInfo }}</span>
        <button class="sm" :disabled="!store.filter.offset" @click="page(-1)">‹</button>
        <button class="sm" :disabled="(store.filter.offset ?? 0) + (store.filter.limit ?? 100) >= store.total" @click="page(1)">›</button>
      </div>
    </div>

    <div class="card" style="padding: 0">
      <table v-if="store.items.length">
        <thead>
          <tr>
            <th>Date</th>
            <th>{{ payeeHeader }}</th>
            <th>Category</th>
            <th>Via</th>
            <th class="num">Amount</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in store.items" :key="t.id" class="clickable" :style="t.kind !== 'expense' ? 'opacity:.65' : ''" @click="editing = t">
            <td class="small muted" style="white-space: nowrap">{{ fmtDateTime(t.postedAt) }}</td>
            <td>
              <div style="font-weight: 500">{{ t.payee }}</div>
              <div v-if="t.note || t.vpa" class="small muted">{{ t.note || t.vpa }}</div>
              <span v-if="t.needsReview" class="chip" style="--chip: var(--warn)">needs review</span>
              <span v-if="needsDescription(t)" class="chip" style="--chip: var(--warn)" title="Open it and say what this was">what was it?</span>
              <span v-if="t.kind !== 'expense'" class="chip" style="margin-left: 4px">{{ kindLabel[t.kind] }}</span>
            </td>
            <td v-if="t.kind === 'income'" class="small muted" @click.stop>
              Income
              <button v-if="t.direction === 'credit'" class="ghost sm" title="A friend paying back their share of a bill" @click="payback = { txn: t, name: '' }">Friend paying back?</button>
            </td>
            <td v-else-if="t.kind === 'settlement'" class="small muted">From {{ friends.name(t.friendId) }}</td>
            <td v-else-if="t.categoryParts.length" title="Split across categories. Open to change it.">
              <div v-for="p in t.categoryParts" :key="p.categoryId" class="small row" style="gap: 6px">
                <span class="dot" :style="{ background: categories.color(p.categoryId) }" />{{ categories.icon(p.categoryId) }} {{ categories.name(p.categoryId) }}
                <span class="muted money">{{ formatINR(p.amountPaise) }}</span>
              </div>
            </td>
            <td v-else @click.stop>
              <select class="sm" :value="t.categoryId === null ? 'null' : String(t.categoryId)" :style="`border-color:${categories.color(t.categoryId)}55`" @change="quickCategory(t, $event)">
                <option value="null">Uncategorized</option>
                <option v-for="c in categories.items" :key="c.id" :value="String(c.id)">{{ c.icon }} {{ c.name }}</option>
                <option value="new">+ New category…</option>
              </select>
            </td>
            <td class="small muted">{{ channelLabel[t.channel] }}<span v-if="t.source !== 'manual'"> · {{ t.source }}</span></td>
            <td class="num money" :class="t.direction === 'credit' ? 'ok-text' : ''">
              {{ t.direction === 'credit' ? '+' : '' }}{{ formatINR(t.amountPaise) }}
              <div v-if="t.mySharePaise != null && t.mySharePaise !== t.amountPaise" class="small muted" style="font-family: inherit" title="Split with friends; only your share counts as spending">
                your share {{ formatINR(t.mySharePaise) }}
              </div>
            </td>
            <td @click.stop><button class="ghost sm danger" title="Delete permanently" @click="confirmDelete = t">✕</button></td>
          </tr>
        </tbody>
      </table>
      <div v-else-if="!store.loading" class="empty">
        No transactions match{{ month ? ` in ${monthLabel(month)}` : '' }}. Add one with the button above, or set up Gmail sync in Settings.
      </div>
    </div>

    <Modal v-if="showAdd" title="Add expense" @close="showAdd = false">
      <TxnForm :saving="saving" @save="onSave" @cancel="showAdd = false" />
    </Modal>
    <Modal v-if="editing" title="Edit transaction" @close="editing = null">
      <TxnForm :existing="editing" :saving="saving" @save="onSave" @cancel="editing = null" />
    </Modal>
    <Modal v-if="manageCategories" :title="manageCategories.assignTo ? 'New category' : 'Manage categories'" @close="manageCategories = null">
      <CategoryManager :assigning="!!manageCategories.assignTo" @created="onCategoryCreated" @close="manageCategories = null" />
    </Modal>
    <Modal v-if="describe" :title="`What was it? (${categories.name(describe.categoryId)})`" @close="describe = null">
      <p>
        <strong>{{ formatINR(describe.txn.amountPaise) }}</strong> to {{ describe.txn.payee }} on {{ fmtDateTime(describe.txn.postedAt) }}
      </p>
      <form @submit.prevent="saveDescribed">
        <label class="field">
          Description
          <input v-model="describe.note" placeholder="e.g. Parking at the mall" autofocus />
        </label>
        <p class="small muted">
          {{ categories.name(describe.categoryId) }} needs a description, so you can tell later what this was and move it to a better category.
          It shows here in Transactions, not in the charts.
        </p>
        <div class="actions">
          <button type="button" @click="describe = null">Cancel</button>
          <button type="submit" class="primary" :disabled="!describe.note.trim()">Save</button>
        </div>
      </form>
    </Modal>
    <Modal v-if="payback" title="Friend paying you back?" @close="payback = null">
      <p>
        <strong>+{{ formatINR(payback.txn.amountPaise) }}</strong> from {{ payback.txn.payee }}
        <span v-if="payback.txn.vpa" class="muted">({{ payback.txn.vpa }})</span>
      </p>
      <form @submit.prevent="savePayback">
        <label class="field">
          Which friend?
          <input v-model="payback.name" list="payback-friends" placeholder="e.g. Arun" autofocus />
        </label>
        <datalist id="payback-friends">
          <option v-for="f in friends.items" :key="f.id" :value="f.name" />
        </datalist>
        <div v-if="!paybackFriend && friends.owing.length" class="row wrap" style="gap: 6px; margin-top: 8px">
          <span class="small muted">Owes you:</span>
          <button v-for="f in friends.owing" :key="f.id" type="button" class="sm" @click="payback.name = f.name">{{ f.name }} · {{ formatINR(f.balancePaise) }}</button>
        </div>
        <p v-else-if="paybackFriend" class="small muted">
          {{ paybackFriend.balancePaise > 0 ? `${paybackFriend.name} owes you ${formatINR(paybackFriend.balancePaise)}.` : `${paybackFriend.name} doesn't owe you anything right now.` }}
        </p>
        <p class="small muted">
          It won't count as income.<span v-if="payback.txn.vpa"> Future payments from this UPI ID are suggested as their paybacks while they owe you.</span>
        </p>
        <div class="actions">
          <button type="button" @click="payback = null">Cancel</button>
          <button type="submit" class="primary" :disabled="!payback.name.trim()">Mark as payback</button>
        </div>
      </form>
    </Modal>
    <Modal v-if="ruleOffer" title="Always categorize like this?" @close="ruleOffer = null">
      <p>
        Create a rule so future payments to <strong>{{ ruleOffer.txn.payee }}</strong> are filed under
        <strong>{{ categories.icon(ruleOffer.categoryId) }} {{ categories.name(ruleOffer.categoryId) }}</strong>?
      </p>
      <div class="row" style="gap: 14px; margin: 10px 0">
        <label class="row" style="gap: 6px"><input v-model="ruleField" type="radio" value="payee" /> Match payee name “{{ ruleOffer.txn.payee }}”</label>
        <label v-if="ruleOffer.txn.vpa" class="row" style="gap: 6px"><input v-model="ruleField" type="radio" value="vpa" /> Match UPI ID “{{ ruleOffer.txn.vpa }}”</label>
      </div>
      <p class="small muted">Existing transactions that match will be recategorized too. You can edit or delete the rule later under Rules.</p>
      <div class="actions">
        <button @click="ruleOffer = null">Just this one</button>
        <button class="primary" @click="createRuleFromOffer">Create rule</button>
      </div>
    </Modal>
    <Modal v-if="confirmDelete" title="Delete permanently?" @close="confirmDelete = null">
      <p>
        <strong>{{ confirmDelete.payee }}</strong> · {{ formatINR(confirmDelete.amountPaise) }} on {{ fmtDateTime(confirmDelete.postedAt) }}
      </p>
      <p class="small muted">
        This removes the record and overwrites its storage. Only an anonymous hash is kept so a future sync won't re-import it.
        This cannot be undone.
      </p>
      <div class="actions">
        <button @click="confirmDelete = null">Cancel</button>
        <button class="danger" @click="doDelete">Delete permanently</button>
      </div>
    </Modal>
  </div>
</template>
