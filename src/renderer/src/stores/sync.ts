import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { GmailStatus, SyncResult } from '@shared/types'
import { useTransactionsStore } from './transactions'
import { useBudgetsStore } from './budgets'
import { useToast } from '../composables/useToast'

export const useSyncStore = defineStore('sync', () => {
  const running = ref(false)
  const last = ref<SyncResult | null>(null)
  const gmail = ref<GmailStatus | null>(null)

  async function loadStatus(): Promise<void> {
    gmail.value = await window.api.gmail.status()
  }

  async function run(opts: { silent?: boolean } = {}): Promise<SyncResult | null> {
    if (running.value) return null
    const toast = useToast()
    running.value = true
    try {
      const res = await window.api.sync.run()
      last.value = res
      await Promise.all([useTransactionsStore().load(), useBudgetsStore().load(), loadStatus()])
      if (!opts.silent || res.inserted > 0 || res.errors.length) {
        const parts = [`${res.inserted} new`]
        if (res.needsReview) parts.push(`${res.needsReview} need review`)
        if (res.skippedDuplicate) parts.push(`${res.skippedDuplicate} already known`)
        if (res.errors.length) parts.push(`${res.errors.length} failed`)
        toast.info(`Sync done: ${parts.join(', ')}`)
      }
      for (const a of res.budgetAlerts) toast.error(a)
      return res
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e)
      toast.error(`Sync failed: ${msg}`)
      return null
    } finally {
      running.value = false
    }
  }

  return { running, last, gmail, loadStatus, run }
})
