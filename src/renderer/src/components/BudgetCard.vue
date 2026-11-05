<script setup lang="ts">
import type { BudgetStatus } from '@shared/types'
import { formatINR } from '@shared/money'
import { useCategoriesStore } from '../stores/categories'
import { fmtShort } from '../composables/useDates'
import dayjs from 'dayjs'

defineProps<{ status: BudgetStatus; compact?: boolean }>()
const categories = useCategoriesStore()
/** periodEnd is exclusive (the first day of the next period); show the last day inside it. */
const lastDay = (end: string): string => fmtShort(dayjs(end).subtract(1, 'day').format('YYYY-MM-DD'))
</script>

<template>
  <div :style="compact ? 'margin-bottom: 12px' : ''">
    <div class="row between" style="margin-bottom: 4px">
      <div>
        <strong>{{ status.scope === 'overall' ? 'All spending' : `${categories.icon(status.categoryId)} ${categories.name(status.categoryId)}` }}</strong>
        <span class="small muted"> · {{ status.period }} · {{ fmtShort(status.periodStart) }} – {{ lastDay(status.periodEnd) }}</span>
      </div>
      <span class="money" :class="{ 'danger-text': status.state === 'over', 'warn-text': status.state === 'warn' }">
        {{ formatINR(status.spentPaise) }} <span class="muted" style="font-weight: 400">/ {{ formatINR(status.limitPaise) }}</span>
      </span>
    </div>
    <div class="bar" :class="status.state"><span :style="{ width: `${Math.min(100, status.pct)}%` }" /></div>
    <div class="row between small muted" style="margin-top: 4px">
      <span>{{ status.pct }}% used · {{ status.daysLeft }} day{{ status.daysLeft === 1 ? '' : 's' }} left</span>
      <span v-if="status.state === 'over'" class="danger-text">Over by {{ formatINR(status.spentPaise - status.limitPaise) }}</span>
      <span v-else>Safe to spend today: <strong class="money">{{ formatINR(status.safeToSpendTodayPaise) }}</strong></span>
    </div>
  </div>
</template>
