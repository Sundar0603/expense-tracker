<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Budget, BudgetPeriod, BudgetStatus } from '@shared/types'
import { parseRupees } from '@shared/money'
import { useBudgetsStore } from '../stores/budgets'
import { useCategoriesStore } from '../stores/categories'
import { guard, useToast } from '../composables/useToast'
import Modal from '../components/Modal.vue'
import BudgetCard from '../components/BudgetCard.vue'

const budgets = useBudgetsStore()
const categories = useCategoriesStore()
const toast = useToast()
// Status depends on today's date (period, days left), so don't trust what was loaded at startup.
onMounted(() => void budgets.load())

const editing = ref<BudgetStatus | null>(null)
const creating = ref(false)
const scope = ref<Budget['scope']>('overall')
const categoryId = ref<number | null>(null)
const period = ref<BudgetPeriod>('monthly')
const weekStart = ref(1)
const limit = ref('')
const warnPct = ref(80)

function openCreate(): void {
  scope.value = 'overall'
  categoryId.value = categories.items[0]?.id ?? null
  period.value = 'monthly'
  weekStart.value = 1
  limit.value = ''
  warnPct.value = 80
  creating.value = true
}
function openEdit(b: BudgetStatus): void {
  scope.value = b.scope
  categoryId.value = b.categoryId
  period.value = b.period
  weekStart.value = b.weekStart
  limit.value = String(b.limitPaise / 100)
  warnPct.value = b.warnPct
  editing.value = b
}
const limitPaise = computed(() => parseRupees(limit.value))
// v-model.number leaves '' in an emptied number input, so check for a real number in range.
const warnValid = computed(() => Number.isInteger(warnPct.value) && warnPct.value >= 1 && warnPct.value <= 99)
const valid = computed(
  () => limitPaise.value !== null && limitPaise.value > 0 && warnValid.value && (scope.value === 'overall' || categoryId.value !== null)
)

async function save(): Promise<void> {
  if (!valid.value) return
  const input: Omit<Budget, 'id'> = {
    scope: scope.value,
    categoryId: scope.value === 'category' ? categoryId.value : null,
    period: period.value,
    weekStart: weekStart.value,
    limitPaise: limitPaise.value!,
    warnPct: warnPct.value
  }
  const ok = editing.value
    ? await guard(() => budgets.update(editing.value!.id, input), 'Could not save budget')
    : await guard(() => budgets.create(input), 'Could not create budget')
  if (ok !== undefined) {
    creating.value = false
    editing.value = null
    toast.info('Budget saved')
  }
}
async function remove(id: number): Promise<void> {
  await guard(() => budgets.remove(id), 'Could not delete budget')
  editing.value = null
}
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
</script>

<template>
  <div>
    <div class="row between" style="margin-bottom: 16px">
      <h1 style="margin: 0">Budgets</h1>
      <button class="primary" @click="openCreate">+ New budget</button>
    </div>
    <div v-if="!budgets.statuses.length" class="card empty">
      No budgets yet. Set a weekly or monthly limit for all spending or for one category, and the app will warn you as you approach it.
    </div>
    <div class="grid cols-2">
      <div v-for="b in budgets.statuses" :key="b.id" class="card clickable" style="cursor: pointer" @click="openEdit(b)">
        <BudgetCard :status="b" />
      </div>
    </div>

    <Modal v-if="creating || editing" :title="editing ? 'Edit budget' : 'New budget'" @close="creating = false; editing = null">
      <form @submit.prevent="save">
        <div class="form-grid">
          <label class="field">
            Applies to
            <select v-model="scope">
              <option value="overall">All spending</option>
              <option value="category">One category</option>
            </select>
          </label>
          <label v-if="scope === 'category'" class="field">
            Category
            <select v-model="categoryId">
              <option v-for="c in categories.items" :key="c.id" :value="c.id">{{ c.icon }} {{ c.name }}</option>
            </select>
          </label>
          <label class="field">
            Period
            <select v-model="period">
              <option value="monthly">Monthly (calendar month)</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
          <label v-if="period === 'weekly'" class="field">
            Week starts on
            <select v-model.number="weekStart">
              <option v-for="(d, i) in days" :key="i" :value="i">{{ d }}</option>
            </select>
          </label>
          <label class="field">
            Limit (₹)
            <input v-model="limit" inputmode="numeric" placeholder="e.g. 15000" />
          </label>
          <label class="field">
            Warn at (%)
            <input v-model.number="warnPct" type="number" min="1" max="99" />
          </label>
        </div>
        <div class="actions">
          <button v-if="editing" type="button" class="danger" style="margin-right: auto" @click="remove(editing.id)">Delete</button>
          <button type="button" @click="creating = false; editing = null">Cancel</button>
          <button type="submit" class="primary" :disabled="!valid">Save</button>
        </div>
      </form>
    </Modal>
  </div>
</template>
