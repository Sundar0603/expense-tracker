<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { Account, CategoryPart, Channel, NewTransaction, SplitShareInput, Transaction, TransactionPatch, TxnKind } from '@shared/types'
import { formatINR, parseRupees } from '@shared/money'
import { useCategoriesStore } from '../stores/categories'
import { useFriendsStore } from '../stores/friends'
import { guard } from '../composables/useToast'
import dayjs from 'dayjs'

const props = defineProps<{ existing?: Transaction | null; saving?: boolean }>()
const emit = defineEmits<{
  /**
   * split: the friends' shares to store; parts: the category split. Each is empty to remove one
   * and left out when there was none and is none.
   */
  save: [payload: { create?: NewTransaction; patch?: TransactionPatch; split?: SplitShareInput[]; parts?: CategoryPart[] }]
  cancel: []
}>()

const categories = useCategoriesStore()
const friends = useFriendsStore()
const accounts = ref<Account[]>([])

const amount = ref('')
const payee = ref('')
const date = ref(dayjs().format('YYYY-MM-DD'))
const time = ref(dayjs().format('HH:mm'))
const categoryId = ref<number | null>(null)
const kind = ref<TxnKind>('expense')
const note = ref('')
const accountId = ref<number>(1)
const channel = ref<Channel>('cash')
const suggestions = ref<string[]>([])
/** Settlements: who paid the user back. */
const friendName = ref('')
const splitOn = ref(false)
const wasSplit = ref(false)
const shares = ref<{ name: string; amount: string }[]>([])
/** Splitting the user's spend across categories. */
const partsOn = ref(false)
const wasPartsSplit = ref(false)
const parts = ref<{ categoryId: number | null; amount: string }[]>([])

onMounted(async () => {
  accounts.value = await window.api.accounts.list()
  void friends.load()
  if (props.existing) {
    const t = props.existing
    amount.value = (t.amountPaise / 100).toFixed(2)
    payee.value = t.payee
    date.value = t.postedAt.slice(0, 10)
    time.value = t.postedAt.slice(11, 16) || '00:00'
    categoryId.value = t.categoryId
    kind.value = t.kind
    note.value = t.note ?? ''
    accountId.value = t.accountId
    channel.value = t.channel
    if (t.kind === 'settlement') {
      await friends.load()
      friendName.value = friends.name(t.friendId)
    }
    if (t.mySharePaise != null) {
      shares.value = (await window.api.splits.get(t.id)).map((s) => ({ name: s.friendName, amount: (s.amountPaise / 100).toFixed(2) }))
      splitOn.value = wasSplit.value = true
    }
    if (t.categoryParts.length) {
      parts.value = t.categoryParts.map((p) => ({ categoryId: p.categoryId, amount: (p.amountPaise / 100).toFixed(2) }))
      partsOn.value = wasPartsSplit.value = true
    }
  } else {
    const cash = accounts.value.find((a) => a.bank === 'CASH')
    if (cash) accountId.value = cash.id
  }
})

watch(payee, async (v) => {
  if (props.existing || v.trim().length < 2) {
    suggestions.value = []
    return
  }
  suggestions.value = (await window.api.txn.payeeSuggestions(v.trim())).filter((s) => s !== v)
})

watch(splitOn, (on) => {
  if (on && !shares.value.length) shares.value.push({ name: '', amount: '' })
})
watch(partsOn, (on) => {
  if (on && !parts.value.length) parts.value.push({ categoryId: categoryId.value, amount: '' }, { categoryId: null, amount: '' })
})

const amountPaise = computed(() => parseRupees(amount.value))
const isManualSource = computed(() => !props.existing || props.existing.source === 'manual')
const incoming = computed(() => kind.value === 'income' || kind.value === 'settlement')
/** Bank rows keep the direction the bank reported; manual ones follow the type. */
const isCredit = computed(() => (isManualSource.value ? incoming.value : props.existing!.direction === 'credit'))
const canSettle = computed(() => isManualSource.value || props.existing!.direction === 'credit')
const canSplit = computed(() => kind.value === 'expense' && !isCredit.value)

const owedPaise = computed(() => shares.value.reduce((n, s) => n + (parseRupees(s.amount) ?? 0), 0))
const mySharePaise = computed(() => (amountPaise.value ?? 0) - owedPaise.value)
const splitError = computed(() => {
  if (!canSplit.value || !splitOn.value) return null
  if (!shares.value.length) return 'Add at least one friend'
  const seen = new Set<string>()
  for (const s of shares.value) {
    const key = s.name.trim().toLowerCase()
    if (!key) return "Enter each friend's name"
    if (seen.has(key)) return `${s.name.trim()} is listed twice`
    seen.add(key)
    const p = parseRupees(s.amount)
    if (p === null || p <= 0) return `Enter ${s.name.trim()}'s share`
  }
  if (mySharePaise.value < 0) return "Friends' shares are more than the bill"
  return null
})
/** What the category parts must add up to: the user's share when friends paid part of it. */
const spendPaise = computed(() => (canSplit.value && splitOn.value ? mySharePaise.value : (amountPaise.value ?? 0)))
const assignedPaise = computed(() => parts.value.reduce((n, p) => n + (parseRupees(p.amount) ?? 0), 0))
const leftPaise = computed(() => spendPaise.value - assignedPaise.value)
const partsError = computed(() => {
  if (!canSplit.value || !partsOn.value) return null
  if (parts.value.length < 2) return 'Add at least two categories'
  const seen = new Set<number>()
  for (const p of parts.value) {
    if (p.categoryId === null) return 'Pick a category for each part'
    if (seen.has(p.categoryId)) return `${categories.name(p.categoryId)} is listed twice`
    seen.add(p.categoryId)
    const v = parseRupees(p.amount)
    if (v === null || v <= 0) return `Enter the amount for ${categories.name(p.categoryId)}`
  }
  if (leftPaise.value > 0) return `${formatINR(leftPaise.value)} left to assign`
  if (leftPaise.value < 0) return `${formatINR(-leftPaise.value)} more than ${splitOn.value ? 'your share' : 'the amount'}`
  return null
})
/** Put whatever is left into the first part without an amount, else the last part. */
function fillRest(): void {
  const target = parts.value.find((p) => !parseRupees(p.amount)) ?? parts.value[parts.value.length - 1]
  if (!target) return
  target.amount = (Math.max(0, (parseRupees(target.amount) ?? 0) + leftPaise.value) / 100).toFixed(2)
}
function addPart(): void {
  parts.value.push({ categoryId: null, amount: leftPaise.value > 0 ? (leftPaise.value / 100).toFixed(2) : '' })
}

/** A catch-all category (e.g. Other) asks what the expense was, so it can be recategorized later. */
const noteCategory = computed(() => {
  if (kind.value !== 'expense' || isCredit.value) return null
  const ids = canSplit.value && partsOn.value ? parts.value.map((p) => p.categoryId) : [categoryId.value]
  return ids.map((id) => (id === null ? undefined : categories.byId.get(id))).find((c) => c?.needsNote) ?? null
})

const settleFriend = computed(() => friends.items.find((f) => f.name.toLowerCase() === friendName.value.trim().toLowerCase()) ?? null)

const valid = computed(
  () =>
    amountPaise.value !== null &&
    amountPaise.value > 0 &&
    payee.value.trim().length > 0 &&
    !splitError.value &&
    !partsError.value &&
    (!noteCategory.value || note.value.trim().length > 0) &&
    (kind.value !== 'settlement' || friendName.value.trim().length > 0)
)

/** Everyone, the user included, pays the same; the leftover paise stay with the user. */
function splitEqually(): void {
  if (!amountPaise.value || !shares.value.length) return
  const each = Math.floor(amountPaise.value / (shares.value.length + 1))
  for (const s of shares.value) s.amount = (each / 100).toFixed(2)
}

async function submit(): Promise<void> {
  if (!valid.value || props.saving) return
  let friendId: number | null = null
  if (kind.value === 'settlement') {
    const id = await guard(() => window.api.friends.ensure(friendName.value))
    if (id === undefined) return
    friendId = id
  }
  const split: SplitShareInput[] | undefined =
    canSplit.value && splitOn.value
      ? shares.value.map((s) => ({ friendName: s.name.trim(), amountPaise: parseRupees(s.amount)! }))
      : wasSplit.value
        ? []
        : undefined
  const categoryParts: CategoryPart[] | undefined =
    canSplit.value && partsOn.value
      ? parts.value.map((p) => ({ categoryId: p.categoryId!, amountPaise: parseRupees(p.amount)! }))
      : wasPartsSplit.value
        ? []
        : undefined
  const postedAt = `${date.value}T${time.value || '00:00'}:00`
  const direction = incoming.value ? 'credit' : 'debit'
  // A category split decides the category itself (its largest part); until then, use that part.
  const category = incoming.value
    ? null
    : categoryParts?.length
      ? categoryParts.reduce((a, b) => (b.amountPaise > a.amountPaise ? b : a)).categoryId
      : categoryId.value
  if (props.existing) {
    const patch: TransactionPatch = {
      categoryId: category,
      kind: kind.value,
      note: note.value.trim() || null,
      needsReview: false,
      friendId
    }
    if (isManualSource.value) {
      patch.amountPaise = amountPaise.value!
      patch.payee = payee.value.trim()
      patch.postedAt = postedAt
      patch.accountId = accountId.value
      patch.direction = direction
    }
    emit('save', { patch, split, parts: categoryParts })
    return
  }
  emit('save', {
    create: {
      accountId: accountId.value,
      postedAt,
      amountPaise: amountPaise.value!,
      direction,
      payee: payee.value.trim(),
      channel: channel.value,
      source: 'manual',
      categoryId: category,
      kind: kind.value,
      note: note.value.trim() || null,
      friendId
    },
    split,
    parts: categoryParts
  })
}
</script>

<template>
  <form @submit.prevent="submit">
    <div class="form-grid">
      <label class="field">
        Amount (₹)
        <input v-model="amount" inputmode="decimal" placeholder="0.00" autofocus :disabled="!isManualSource" />
        <span v-if="amountPaise !== null" class="small muted">{{ formatINR(amountPaise) }}</span>
      </label>
      <label class="field">
        Type
        <select v-model="kind">
          <option value="expense">Expense</option>
          <option value="income">Income</option>
          <option v-if="canSettle" value="settlement">Friend paying me back</option>
          <option value="transfer">Transfer (not an expense)</option>
          <option value="ignored">Ignored</option>
        </select>
      </label>
      <label class="field full">
        {{ incoming ? 'Received from' : 'Paid to' }}
        <input v-model="payee" placeholder="e.g. Tea stall, Swiggy, Auto" list="payee-suggestions" :disabled="!isManualSource" />
        <datalist id="payee-suggestions">
          <option v-for="s in suggestions" :key="s" :value="s" />
        </datalist>
      </label>
      <div v-if="kind === 'settlement'" class="field full">
        <label class="field">
          Friend paying you back
          <input v-model="friendName" list="friend-names" placeholder="e.g. Arun" />
        </label>
        <span v-if="settleFriend" class="small muted">
          {{ settleFriend.balancePaise > 0 ? `${settleFriend.name} owes you ${formatINR(settleFriend.balancePaise)}` : `${settleFriend.name} doesn't owe you anything right now` }}
        </span>
        <div v-else-if="friends.owing.length" class="row wrap" style="gap: 6px">
          <button v-for="f in friends.owing" :key="f.id" type="button" class="sm" @click="friendName = f.name">
            {{ f.name }} · {{ formatINR(f.balancePaise) }}
          </button>
        </div>
      </div>
      <label class="field">
        Date
        <input v-model="date" type="date" :disabled="!isManualSource" />
      </label>
      <label class="field">
        Time
        <input v-model="time" type="time" :disabled="!isManualSource" />
      </label>
      <label v-if="!incoming && !(canSplit && partsOn)" class="field">
        Category
        <select v-model="categoryId">
          <option :value="null">Uncategorized</option>
          <option v-for="c in categories.items" :key="c.id" :value="c.id">{{ c.icon }} {{ c.name }}</option>
        </select>
      </label>
      <label class="field">
        Account
        <select v-model="accountId" :disabled="!isManualSource">
          <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </label>
      <label v-if="!existing" class="field">
        Paid via
        <select v-model="channel">
          <option value="cash">Cash</option>
          <option value="upi">UPI</option>
          <option value="card">Card</option>
          <option value="other">Other</option>
        </select>
      </label>
      <div v-if="canSplit" class="full split-box">
        <label class="row" style="gap: 8px; font-size: 13px">
          <input v-model="splitOn" type="checkbox" /> I paid for friends too (split this bill)
        </label>
        <template v-if="splitOn">
          <div v-for="(s, i) in shares" :key="i" class="row" style="gap: 8px; margin-top: 8px">
            <input v-model="s.name" placeholder="Friend's name" list="friend-names" style="flex: 1" />
            <input v-model="s.amount" inputmode="decimal" placeholder="Their share ₹" style="width: 130px" />
            <button type="button" class="ghost sm" title="Remove" @click="shares.splice(i, 1)">✕</button>
          </div>
          <div class="row" style="gap: 8px; margin-top: 8px">
            <button type="button" class="sm" @click="shares.push({ name: '', amount: '' })">+ Friend</button>
            <button type="button" class="sm" :disabled="!amountPaise || !shares.length" @click="splitEqually">Split equally</button>
            <span class="spacer" />
            <span class="small" :class="splitError ? 'danger-text' : ''">{{ splitError ?? `Your share: ${formatINR(mySharePaise)}` }}</span>
          </div>
          <p class="small muted" style="margin: 8px 0 0">Only your share counts as spending. The rest is what your friends owe you.</p>
        </template>
      </div>
      <div v-if="canSplit" class="full split-box">
        <label class="row" style="gap: 8px; font-size: 13px">
          <input v-model="partsOn" type="checkbox" /> Split across categories
        </label>
        <template v-if="partsOn">
          <div v-for="(p, i) in parts" :key="i" class="row" style="gap: 8px; margin-top: 8px">
            <select v-model="p.categoryId" style="flex: 1">
              <option :value="null" disabled>Pick a category</option>
              <option v-for="c in categories.items" :key="c.id" :value="c.id">{{ c.icon }} {{ c.name }}</option>
            </select>
            <input v-model="p.amount" inputmode="decimal" placeholder="Amount ₹" style="width: 130px" />
            <button type="button" class="ghost sm" title="Remove" @click="parts.splice(i, 1)">✕</button>
          </div>
          <div class="row" style="gap: 8px; margin-top: 8px">
            <button type="button" class="sm" @click="addPart">+ Category</button>
            <button type="button" class="sm" :disabled="leftPaise === 0 || !parts.length" @click="fillRest">Fill the rest</button>
            <span class="spacer" />
            <span class="small" :class="partsError ? 'danger-text' : 'ok-text'">{{ partsError ?? `Adds up to ${formatINR(spendPaise)}` }}</span>
          </div>
          <p class="small muted" style="margin: 8px 0 0">
            Each part counts under its own category. Together they must add up to {{ splitOn ? 'your share' : 'the amount' }}, {{ formatINR(spendPaise) }}.
          </p>
        </template>
      </div>
      <label class="field full">
        {{ noteCategory ? `What was it? (required for ${noteCategory.name})` : 'Note' }}
        <input v-model="note" :placeholder="noteCategory ? 'e.g. Parking at the mall' : 'Optional'" />
        <span v-if="noteCategory" class="small muted">So you can tell later what this was, and move it to a better category.</span>
      </label>
    </div>
    <datalist id="friend-names">
      <option v-for="f in friends.items" :key="f.id" :value="f.name" />
    </datalist>
    <p v-if="existing && !isManualSource" class="small muted">
      Amount, payee and date come from the bank and can't be edited. Category, type and note can.
    </p>
    <div class="actions">
      <button type="button" @click="emit('cancel')">Cancel</button>
      <button type="submit" class="primary" :disabled="!valid || saving">{{ existing ? 'Save' : 'Add' }}</button>
    </div>
  </form>
</template>

<style scoped>
.split-box { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
</style>
