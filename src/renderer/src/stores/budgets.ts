import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Budget, BudgetStatus } from '@shared/types'

export const useBudgetsStore = defineStore('budgets', () => {
  const statuses = ref<BudgetStatus[]>([])
  const overCount = computed(() => statuses.value.filter((s) => s.state === 'over').length)
  const warnCount = computed(() => statuses.value.filter((s) => s.state === 'warn').length)

  async function load(): Promise<void> {
    statuses.value = await window.api.budgets.status()
  }
  // Mutations resolve to a value (never undefined) so guard() can tell success from failure.
  async function create(input: Omit<Budget, 'id'>): Promise<Budget> {
    const b = await window.api.budgets.create(input)
    await load()
    return b
  }
  async function update(id: number, patch: Partial<Omit<Budget, 'id'>>): Promise<Budget> {
    const b = await window.api.budgets.update(id, patch)
    await load()
    return b
  }
  async function remove(id: number): Promise<true> {
    await window.api.budgets.delete(id)
    await load()
    return true
  }
  return { statuses, overCount, warnCount, load, create, update, remove }
})
