import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { CategoryPart, NewTransaction, SplitShareInput, Transaction, TransactionFilter, TransactionPatch } from '@shared/types'
import { useBudgetsStore } from './budgets'
import { useFriendsStore } from './friends'
import { shiftMonth } from '../composables/useDates'
import { selectedMonth } from '../composables/useMonth'

export const useTransactionsStore = defineStore('transactions', () => {
  const items = ref<Transaction[]>([])
  const total = ref(0)
  const loading = ref(false)
  // Open on spending; credits, transfers and ignored rows are one click away.
  const filter = ref<TransactionFilter>({ kind: 'expense', limit: 100, offset: 0 })
  /** Show every month instead of the shared selected month. */
  const allTime = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      // Plain copy: reactive proxies cannot be structured-cloned across IPC.
      const f = { ...filter.value }
      if (!allTime.value) {
        f.from = `${selectedMonth.value}-01`
        f.to = `${shiftMonth(selectedMonth.value, 1)}-01`
      }
      let [list, count] = await Promise.all([window.api.txn.list(f), window.api.txn.count(f)])
      // A delete or recategorize can empty the last page; step back to the last one that exists.
      if (list.length === 0 && count > 0 && (f.offset ?? 0) > 0) {
        const limit = f.limit ?? 100
        filter.value.offset = Math.floor((count - 1) / limit) * limit
        list = await window.api.txn.list({ ...f, offset: filter.value.offset })
      }
      items.value = list
      total.value = count
    } finally {
      loading.value = false
    }
  }
  async function create(input: NewTransaction): Promise<Transaction> {
    const t = await window.api.txn.create(input)
    await Promise.all([load(), useBudgetsStore().load(), useFriendsStore().load()])
    return t
  }
  // Mutations resolve to a value (never undefined) so guard() can tell success from failure.
  async function update(id: number, patch: TransactionPatch): Promise<Transaction> {
    const t = await window.api.txn.update(id, patch)
    await Promise.all([load(), useBudgetsStore().load(), useFriendsStore().load()])
    return t
  }
  async function remove(id: number): Promise<true> {
    await window.api.txn.delete(id)
    // Deleting a split bill or a payback changes what friends owe.
    await Promise.all([load(), useBudgetsStore().load(), useFriendsStore().load()])
    return true
  }
  async function setSplit(id: number, shares: SplitShareInput[]): Promise<Transaction> {
    const t = await window.api.splits.set(id, shares)
    await Promise.all([load(), useBudgetsStore().load(), useFriendsStore().load()])
    return t
  }
  async function setCategorySplit(id: number, parts: CategoryPart[]): Promise<Transaction> {
    const t = await window.api.categorySplits.set(id, parts)
    await Promise.all([load(), useBudgetsStore().load()])
    return t
  }
  return { items, total, loading, filter, allTime, load, create, update, remove, setSplit, setCategorySplit }
})
