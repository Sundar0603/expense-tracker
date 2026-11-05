import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Category, NewCategory } from '@shared/types'
import { useBudgetsStore } from './budgets'
import { useTransactionsStore } from './transactions'

export const useCategoriesStore = defineStore('categories', () => {
  const items = ref<Category[]>([])
  const byId = computed(() => new Map(items.value.map((c) => [c.id, c])))

  async function load(): Promise<void> {
    items.value = await window.api.categories.list()
  }
  async function create(input: NewCategory): Promise<Category> {
    const c = await window.api.categories.create(input)
    await load()
    return c
  }
  // Mutations resolve to a value (never undefined) so guard() can tell success from failure.
  async function update(id: number, patch: Partial<Omit<Category, 'id'>>): Promise<Category> {
    const c = await window.api.categories.update(id, patch)
    await load()
    return c
  }
  async function remove(id: number): Promise<true> {
    await window.api.categories.delete(id)
    // Its budgets are deleted with it and its transactions become uncategorized.
    const txns = useTransactionsStore()
    if (txns.filter.categoryId === id) txns.filter.categoryId = undefined
    await Promise.all([load(), useBudgetsStore().load(), txns.load()])
    return true
  }
  function name(id: number | null): string {
    return id === null ? 'Uncategorized' : (byId.value.get(id)?.name ?? 'Unknown')
  }
  function color(id: number | null): string {
    return id === null ? '#8b8b8b' : (byId.value.get(id)?.color ?? '#8b8b8b')
  }
  function icon(id: number | null): string {
    return id === null ? '·' : (byId.value.get(id)?.icon ?? '🏷️')
  }
  return { items, byId, load, create, update, remove, name, color, icon }
})
