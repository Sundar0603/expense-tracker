<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { DashboardStats } from '@shared/types'
import { formatINR } from '@shared/money'
import { useBudgetsStore } from '../stores/budgets'
import { useFriendsStore } from '../stores/friends'
import { useSyncStore } from '../stores/sync'
import { monthLabel, thisMonth } from '../composables/useDates'
import { selectedMonth as month } from '../composables/useMonth'
import MonthPicker from '../components/MonthPicker.vue'
import BudgetCard from '../components/BudgetCard.vue'

const stats = ref<DashboardStats | null>(null)
const budgets = useBudgetsStore()
const friends = useFriendsStore()

async function load(): Promise<void> {
  // Budget status depends on today's date (days left, safe-to-spend), so refresh it with the stats.
  const [s] = await Promise.all([window.api.stats.dashboard(month.value), budgets.load(), friends.load()])
  stats.value = s
}
onMounted(load)
watch(month, load)
// A sync (sidebar button or on launch) can land new transactions while this view is open.
watch(() => useSyncStore().last, load)

const delta = computed(() => {
  if (!stats.value || stats.value.prevMonthTotalPaise === 0) return null
  return Math.round(((stats.value.monthTotalPaise - stats.value.prevMonthTotalPaise) / stats.value.prevMonthTotalPaise) * 100)
})
const maxCat = computed(() => Math.max(1, ...(stats.value?.byCategory.map((c) => c.totalPaise) ?? [1])))
const maxDay = computed(() => Math.max(1, ...(stats.value?.daily.map((d) => d.totalPaise) ?? [1])))
const maxMonth = computed(() => Math.max(1, ...(stats.value?.monthly.map((d) => d.totalPaise) ?? [1])))
const daysInMonth = computed(() => new Date(Number(month.value.slice(0, 4)), Number(month.value.slice(5, 7)), 0).getDate())
const dailySeries = computed(() => {
  const map = new Map(stats.value?.daily.map((d) => [d.day, d.totalPaise]) ?? [])
  return Array.from({ length: daysInMonth.value }, (_, i) => {
    const day = `${month.value}-${String(i + 1).padStart(2, '0')}`
    return { day, total: map.get(day) ?? 0 }
  })
})
/** All 12 months ending at the selected one; the query only returns months that had spending. */
const monthlySeries = computed(() => {
  const map = new Map(stats.value?.monthly.map((m) => [m.month, m.totalPaise]) ?? [])
  const y = Number(month.value.slice(0, 4))
  const mo = Number(month.value.slice(5, 7))
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(y, mo - 12 + i, 1)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    return { month: key, total: map.get(key) ?? 0 }
  })
})
const avgPerDay = computed(() => {
  if (!stats.value) return 0
  const isCurrent = month.value === thisMonth()
  const days = isCurrent ? new Date().getDate() : daysInMonth.value
  return Math.round(stats.value.monthTotalPaise / Math.max(1, days))
})
</script>

<template>
  <div>
    <div class="row between" style="margin-bottom: 16px">
      <h1 style="margin: 0">Dashboard</h1>
      <MonthPicker v-model="month" />
    </div>

    <div v-if="stats" class="grid cols-4" style="margin-bottom: 16px">
      <div class="card">
        <div class="stat-label">Spent this month</div>
        <div class="stat-value money">{{ formatINR(stats.monthTotalPaise) }}</div>
        <div v-if="delta !== null" class="small" :class="delta > 0 ? 'danger-text' : 'ok-text'">
          {{ delta > 0 ? '▲' : '▼' }} {{ Math.abs(delta) }}% vs last month
        </div>
        <div v-else class="small muted">No data for last month</div>
      </div>
      <div class="card">
        <div class="stat-label">Average per day</div>
        <div class="stat-value money">{{ formatINR(avgPerDay) }}</div>
        <div class="small muted">{{ stats.monthCount }} transactions</div>
      </div>
      <div class="card">
        <div class="stat-label">Budgets</div>
        <div class="stat-value">
          <span :class="budgets.overCount ? 'danger-text' : 'ok-text'">{{ budgets.overCount }}</span>
          <span class="muted" style="font-size: 14px; font-weight: 500"> over · </span>
          <span :class="budgets.warnCount ? 'warn-text' : ''">{{ budgets.warnCount }}</span>
          <span class="muted" style="font-size: 14px; font-weight: 500"> warning</span>
        </div>
        <RouterLink to="/budgets" class="small">Manage budgets</RouterLink>
      </div>
      <div class="card">
        <div class="stat-label">Needs review</div>
        <div class="stat-value" :class="stats.needsReviewCount ? 'warn-text' : ''">{{ stats.needsReviewCount }}</div>
        <RouterLink to="/transactions?review=1" class="small">Review them</RouterLink>
      </div>
    </div>

    <div v-if="stats?.uncategorized.count" class="card row wrap" style="margin-bottom: 16px; gap: 10px">
      <span class="stat-label" style="margin: 0">Not counted yet</span>
      <strong class="money warn-text">{{ formatINR(stats.uncategorized.totalPaise) }}</strong>
      <span class="small muted">{{ stats.uncategorized.count }} uncategorized {{ stats.uncategorized.count === 1 ? 'expense' : 'expenses' }} this month stay out of these figures until you categorize them.</span>
      <span class="spacer" />
      <RouterLink to="/transactions?category=null" class="small">Categorize them</RouterLink>
    </div>

    <div v-if="friends.owing.length" class="card row wrap" style="margin-bottom: 16px; gap: 10px">
      <span class="stat-label" style="margin: 0">Friends owe you</span>
      <strong class="money ok-text">{{ formatINR(friends.owedTotalPaise) }}</strong>
      <span class="small muted">
        {{ friends.owing.slice(0, 4).map((f) => `${f.name} ${formatINR(f.balancePaise)}`).join(' · ') }}<template v-if="friends.owing.length > 4"> · +{{ friends.owing.length - 4 }} more</template>
      </span>
      <span class="spacer" />
      <RouterLink to="/friends" class="small">See who owes what</RouterLink>
    </div>

    <div v-if="stats" class="grid cols-2" style="margin-bottom: 16px">
      <div class="card">
        <h2>By category</h2>
        <div v-if="!stats.byCategory.length" class="empty">Nothing spent yet this month.</div>
        <div v-for="c in stats.byCategory" :key="c.categoryId ?? 'none'" style="margin-bottom: 10px">
          <div class="row between small">
            <RouterLink :to="`/transactions?category=${c.categoryId}`" class="row" style="gap: 6px; color: inherit">
              <span class="dot" :style="{ background: c.color }" />{{ c.name }}
              <span class="muted">· {{ c.count }}</span>
            </RouterLink>
            <span class="money">{{ formatINR(c.totalPaise) }}</span>
          </div>
          <div class="bar"><span :style="{ width: `${(c.totalPaise / maxCat) * 100}%`, background: c.color }" /></div>
        </div>
      </div>
      <div class="card">
        <h2>Daily spend</h2>
        <div class="spark" style="height: 120px">
          <span v-for="d in dailySeries" :key="d.day" :style="{ height: `${(d.total / maxDay) * 100}%` }" :title="`${d.day}: ${formatINR(d.total)}`" />
        </div>
        <div class="row between small muted" style="margin-top: 6px"><span>1</span><span>{{ daysInMonth }}</span></div>
        <h2 style="margin-top: 18px">Last 12 months</h2>
        <div class="spark" style="height: 80px">
          <span v-for="m in monthlySeries" :key="m.month" :style="{ height: `${(m.total / maxMonth) * 100}%`, opacity: m.month === month ? 1 : 0.5 }" :title="`${monthLabel(m.month)}: ${formatINR(m.total)}`" />
        </div>
        <div class="row between small muted" style="margin-top: 6px">
          <span>{{ monthLabel(monthlySeries[0]!.month) }}</span><span>{{ monthLabel(month) }}</span>
        </div>
      </div>
    </div>

    <div v-if="stats" class="grid cols-2">
      <div class="card">
        <h2>Top payees</h2>
        <table v-if="stats.topPayees.length">
          <tbody>
            <tr v-for="p in stats.topPayees" :key="p.payee">
              <td>{{ p.payee }} <span class="small muted">· {{ p.count }}</span></td>
              <td class="num money">{{ formatINR(p.totalPaise) }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty">No payees yet.</div>
      </div>
      <div class="card">
        <h2>Budget status</h2>
        <div v-if="!budgets.statuses.length" class="empty">No budgets yet. <RouterLink to="/budgets">Create one</RouterLink>.</div>
        <BudgetCard v-for="b in budgets.statuses" :key="b.id" :status="b" compact />
      </div>
    </div>
  </div>
</template>
