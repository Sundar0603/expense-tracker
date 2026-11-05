<script setup lang="ts">
import { computed, ref, toRaw } from 'vue'
import type { ImportPreview, ImportPreviewRow } from '@shared/types'
import { formatINR } from '@shared/money'
import { useTransactionsStore } from '../stores/transactions'
import { useBudgetsStore } from '../stores/budgets'
import { guard, useToast } from '../composables/useToast'
import { fmtDate } from '../composables/useDates'

const toast = useToast()
const preview = ref<ImportPreview | null>(null)
const path = ref<string | null>(null)
const password = ref('')
const loading = ref(false)
const committing = ref(false)
const showAll = ref(false)
const done = ref<{ inserted: number; duplicate: number; suppressed: number } | null>(null)

async function pick(): Promise<void> {
  const p = await guard(() => window.api.import.pickFile())
  if (!p) return
  path.value = p
  password.value = ''
  done.value = null
  await load()
}

async function load(): Promise<void> {
  if (!path.value) return
  loading.value = true
  preview.value = (await guard(() => window.api.import.preview({ path: path.value!, password: password.value || undefined }), 'Could not read file')) ?? null
  loading.value = false
}

const visibleRows = computed<ImportPreviewRow[]>(() => {
  const rows = preview.value?.rows ?? []
  return showAll.value ? rows : rows.filter((r) => r.status === 'new')
})

async function commit(): Promise<void> {
  if (!preview.value) return
  committing.value = true
  // toRaw: filtering a reactive array yields reactive proxies, which IPC cannot structured-clone.
  const rows = toRaw(preview.value).rows.filter((r) => r.status === 'new')
  const res = await guard(() => window.api.import.commit(rows), 'Import failed')
  committing.value = false
  if (res) {
    done.value = res
    toast.info(`Imported ${res.inserted} transaction${res.inserted === 1 ? '' : 's'}`)
    for (const a of res.budgetAlerts) toast.error(a)
    await Promise.all([useTransactionsStore().load(), useBudgetsStore().load()])
    preview.value = null
    path.value = null
  }
}

const statusLabel: Record<ImportPreviewRow['status'], string> = { new: 'New', duplicate: 'Already known', suppressed: 'Deleted earlier', before_start: 'Before start date' }
</script>

<template>
  <div>
    <h1>Import statement</h1>
    <div class="card" style="margin-bottom: 14px">
      <p class="small muted" style="margin-top: 0">
        Use this to backfill history or catch anything the email alerts missed. Download the statement from HDFC NetBanking
        (Accounts → Statements → Excel/CSV preferred) or the PDF the mobile app emails you. Rows that already exist, or that
        you deleted earlier, are skipped automatically.
      </p>
      <div class="row">
        <button class="primary" :disabled="loading" @click="pick">Choose statement file…</button>
        <span v-if="path" class="small muted mono">{{ path }}</span>
      </div>
      <div v-if="preview?.needsPassword" class="row" style="margin-top: 12px">
        <label class="field">
          PDF password (your numeric Customer ID)
          <input v-model="password" type="password" @keyup.enter="load" />
        </label>
        <button style="margin-top: 18px" @click="load">Unlock</button>
      </div>
      <p v-if="preview?.error" class="small status-bad" style="margin-bottom: 0">{{ preview.error }}</p>
    </div>

    <div v-if="done" class="card" style="margin-bottom: 14px">
      <strong>Done.</strong> {{ done.inserted }} imported, {{ done.duplicate }} already known, {{ done.suppressed }} skipped as deleted earlier.
    </div>

    <div v-if="preview && preview.rows.length" class="card" style="padding: 0">
      <div class="row between" style="padding: 12px 14px; border-bottom: 1px solid var(--border)">
        <div>
          <strong>{{ preview.fileName }}</strong>
          <span class="small muted"> · {{ preview.counts.new }} new · {{ preview.counts.duplicate }} already known · {{ preview.counts.suppressed }} deleted earlier<template v-if="preview.counts.beforeStart"> · {{ preview.counts.beforeStart }} before start date</template><template v-if="preview.skipped"> · {{ preview.skipped }} lines skipped</template></span>
        </div>
        <div class="row">
          <label class="row small" style="gap: 6px"><input v-model="showAll" type="checkbox" /> Show all rows</label>
          <button class="primary" :disabled="committing || preview.counts.new === 0" @click="commit">
            Import {{ preview.counts.new }} new
          </button>
        </div>
      </div>
      <table>
        <thead>
          <tr><th>Date</th><th>Narration</th><th>Payee</th><th class="num">Amount</th><th>Status</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in visibleRows" :key="r.fingerprint" :style="r.status !== 'new' ? 'opacity:.55' : ''">
            <td class="small muted" style="white-space: nowrap">{{ fmtDate(r.postedAt) }}</td>
            <td class="small mono" style="max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap" :title="r.narration">{{ r.narration }}</td>
            <td>{{ r.payee }}<span v-if="r.vpa" class="small muted"> · {{ r.vpa }}</span></td>
            <td class="num money" :class="r.direction === 'credit' ? 'ok-text' : ''">{{ r.direction === 'credit' ? '+' : '' }}{{ formatINR(r.amountPaise) }}</td>
            <td><span class="chip" :style="r.status === 'new' ? '--chip: var(--ok)' : ''">{{ statusLabel[r.status] }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
