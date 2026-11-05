<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import VChart from 'vue-echarts'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { BarChart, LineChart, PieChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent, MarkLineComponent } from 'echarts/components'
import type { InsightsData } from '@shared/types'
import { formatINR } from '@shared/money'
import { selectedMonth as month } from '../composables/useMonth'
import MonthPicker from '../components/MonthPicker.vue'
import { useSyncStore } from '../stores/sync'
import dayjs from 'dayjs'

use([CanvasRenderer, BarChart, LineChart, PieChart, GridComponent, LegendComponent, TooltipComponent, MarkLineComponent])

const data = ref<InsightsData | null>(null)
async function load(): Promise<void> {
  data.value = await window.api.stats.insights(month.value)
}
onMounted(load)
watch(month, load)
// A sync (sidebar button or on launch) can land new transactions while this view is open.
watch(() => useSyncStore().last, load)

const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
const fg = dark ? '#9aa0ab' : '#6b7280'
const grid = dark ? '#262a33' : '#e3e5ea'
const rupee = (v: number): string => formatINR(v, { compact: true })
const base = { textStyle: { fontFamily: 'inherit' }, animationDuration: 300 }
const axisStyle = { axisLabel: { color: fg }, axisLine: { lineStyle: { color: grid } }, splitLine: { lineStyle: { color: grid } } }

const donut = computed(() => {
  const rows = (data.value?.comparison ?? []).filter((c) => c.currentPaise > 0)
  return {
    ...base,
    tooltip: { trigger: 'item', valueFormatter: (v: number) => formatINR(v) },
    legend: { bottom: 0, textStyle: { color: fg }, type: 'scroll' },
    series: [{
      type: 'pie', radius: ['45%', '72%'], center: ['50%', '45%'],
      itemStyle: { borderColor: dark ? '#1a1d24' : '#fff', borderWidth: 2 },
      label: { show: false },
      data: rows.map((c) => ({ name: c.name, value: c.currentPaise, itemStyle: { color: c.color } }))
    }]
  }
})

const comparison = computed(() => {
  const rows = (data.value?.comparison ?? []).filter((c) => c.currentPaise || c.previousPaise || c.avg3Paise).slice(0, 10)
  return {
    ...base,
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatINR(v) },
    legend: { top: 0, textStyle: { color: fg } },
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    xAxis: { type: 'value', ...axisStyle, axisLabel: { color: fg, formatter: rupee } },
    yAxis: { type: 'category', data: rows.map((r) => r.name).reverse(), ...axisStyle, axisLabel: { color: fg } },
    series: [
      { name: 'This month', type: 'bar', data: rows.map((r) => ({ value: r.currentPaise, itemStyle: { color: r.color } })).reverse(), barMaxWidth: 14 },
      { name: '3-month avg', type: 'bar', data: rows.map((r) => r.avg3Paise).reverse(), barMaxWidth: 14, itemStyle: { color: dark ? '#3a4150' : '#cbd0d8' } }
    ]
  }
})

const cumulative = computed(() => {
  const d = data.value
  if (!d) return {}
  const days = dayjs(`${d.month}-01`).daysInMonth()
  const budget = d.overallMonthlyBudgetPaise
  const pace = budget ? Array.from({ length: days }, (_, i) => Math.round((budget * (i + 1)) / days)) : []
  return {
    ...base,
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatINR(v) },
    legend: { top: 0, textStyle: { color: fg } },
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: Array.from({ length: days }, (_, i) => String(i + 1)), ...axisStyle, boundaryGap: false },
    yAxis: { type: 'value', ...axisStyle, axisLabel: { color: fg, formatter: rupee } },
    series: [
      { name: 'Spent so far', type: 'line', smooth: true, showSymbol: false, areaStyle: { opacity: 0.12 }, lineStyle: { width: 2.5 }, data: d.cumulative.map((c) => c.cumulativePaise), itemStyle: { color: '#3b82f6' } },
      ...(budget ? [{ name: 'Budget pace', type: 'line', showSymbol: false, lineStyle: { type: 'dashed', color: '#d97706' }, itemStyle: { color: '#d97706' }, data: pace }] : [])
    ]
  }
})

const trend = computed(() => {
  const d = data.value
  if (!d) return {}
  const months = [...new Set(d.monthTotals.map((m) => m.month))]
  const cats = new Map<string, { name: string; color: string; byMonth: Map<string, number> }>()
  for (const r of d.monthlyByCategory) {
    const key = String(r.categoryId)
    if (!cats.has(key)) cats.set(key, { name: r.name, color: r.color, byMonth: new Map() })
    cats.get(key)!.byMonth.set(r.month, r.totalPaise)
  }
  return {
    ...base,
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatINR(v) },
    legend: { top: 0, type: 'scroll', textStyle: { color: fg } },
    grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: months.map((m) => dayjs(`${m}-01`).format('MMM')), ...axisStyle },
    yAxis: { type: 'value', ...axisStyle, axisLabel: { color: fg, formatter: rupee } },
    series: [...cats.values()].map((c) => ({ name: c.name, type: 'bar', stack: 'total', barMaxWidth: 28, itemStyle: { color: c.color }, data: months.map((m) => c.byMonth.get(m) ?? 0) }))
  }
})

const weekdays = computed(() => {
  const d = data.value
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    ...base,
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => formatINR(v) },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: names, ...axisStyle },
    yAxis: { type: 'value', ...axisStyle, axisLabel: { color: fg, formatter: rupee } },
    series: [{ name: 'Spend (3 months)', type: 'bar', barMaxWidth: 36, itemStyle: { color: '#a855f7', borderRadius: [4, 4, 0, 0] }, data: (d?.weekdays ?? []).map((w) => w.totalPaise) }]
  }
})
</script>

<template>
  <div>
    <div class="row between" style="margin-bottom: 16px">
      <h1 style="margin: 0">Insights</h1>
      <MonthPicker v-model="month" />
    </div>
    <div v-if="data?.uncategorized.count" class="card row wrap" style="margin-bottom: 16px; gap: 10px">
      <span class="stat-label" style="margin: 0">Not counted yet</span>
      <strong class="money warn-text">{{ formatINR(data.uncategorized.totalPaise) }}</strong>
      <span class="small muted">{{ data.uncategorized.count }} uncategorized {{ data.uncategorized.count === 1 ? 'expense' : 'expenses' }} this month stay out of these charts until you categorize them.</span>
      <span class="spacer" />
      <RouterLink to="/transactions?category=null" class="small">Categorize them</RouterLink>
    </div>
    <div v-if="data" class="grid cols-2">
      <div class="card">
        <h2>Where the money went</h2>
        <VChart :option="donut" autoresize style="height: 300px" />
      </div>
      <div class="card">
        <h2>This month vs 3-month average</h2>
        <VChart :option="comparison" autoresize style="height: 300px" />
      </div>
      <div class="card">
        <h2>Cumulative spend{{ data.overallMonthlyBudgetPaise ? ' vs budget pace' : '' }}</h2>
        <VChart :option="cumulative" autoresize style="height: 260px" />
        <p v-if="!data.overallMonthlyBudgetPaise" class="small muted">Add an overall monthly budget to see the pace line.</p>
      </div>
      <div class="card">
        <h2>Which days you spend on</h2>
        <VChart :option="weekdays" autoresize style="height: 260px" />
      </div>
      <div class="card" style="grid-column: 1 / -1">
        <h2>12-month trend by category</h2>
        <VChart :option="trend" autoresize style="height: 300px" />
      </div>
      <div class="card">
        <h2>Largest expenses</h2>
        <table>
          <tbody>
            <tr v-for="l in data.largest" :key="l.payee + l.postedAt">
              <td class="small muted">{{ dayjs(l.postedAt).format('DD MMM') }}</td>
              <td>{{ l.payee }} <span class="small muted">· {{ l.category }}</span></td>
              <td class="num money">{{ formatINR(l.amountPaise) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <h2>Money that is not an expense</h2>
        <table>
          <tbody>
            <tr><td>Income</td><td class="num money ok-text">{{ formatINR(data.incomePaise) }}</td></tr>
            <tr><td>Transfers (ATM cash, own accounts)</td><td class="num money">{{ formatINR(data.transferPaise) }}</td></tr>
            <tr><td>Ignored (investments, rules)</td><td class="num money muted">{{ formatINR(data.ignoredPaise) }}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
