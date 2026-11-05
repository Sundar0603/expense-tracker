<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useSyncStore } from '../stores/sync'
import { guard, useToast } from '../composables/useToast'
import { fmtDateTime } from '../composables/useDates'
import Modal from '../components/Modal.vue'

const settings = useSettingsStore()
const sync = useSyncStore()
const toast = useToast()

const user = ref('')
const appPassword = ref('')
const clientId = ref('')
const clientSecret = ref('')
const editingClient = ref(false)
const signingIn = ref(false)
const showClientFields = computed(() => editingClient.value || !sync.gmail?.oauthClientSaved)
const canSignIn = computed(() => {
  if (signingIn.value) return false
  if (!showClientFields.value) return true
  const reusesSecret = sync.gmail?.oauthClientSaved && clientId.value.trim() === sync.gmail.oauthClientId
  return !!clientId.value.trim() && (!!clientSecret.value.trim() || !!reusesSecret)
})
const saving = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string } | null>(null)
const trackingStart = ref('')
const defaultStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toLocaleDateString('en-CA')
const passphrase = ref('')
const openAtLogin = ref(false)
const busy = ref(false)
const confirmRestore = ref(false)

onMounted(async () => {
  await sync.loadStatus()
  user.value = sync.gmail?.user ?? ''
  clientId.value = sync.gmail?.oauthClientId ?? ''
  trackingStart.value = settings.values['tracking_start'] ?? defaultStart
  openAtLogin.value = await window.api.data.getOpenAtLogin()
})

async function toggleLogin(): Promise<void> {
  openAtLogin.value = (await guard(() => window.api.data.setOpenAtLogin(!openAtLogin.value))) ?? openAtLogin.value
}
async function exportCsv(): Promise<void> {
  const p = await guard(() => window.api.data.exportCsv(), 'Export failed')
  if (p) toast.info(`Exported to ${p}`)
}
async function backup(): Promise<void> {
  busy.value = true
  const p = await guard(() => window.api.data.backup(passphrase.value), 'Backup failed')
  busy.value = false
  if (p) {
    toast.info(`Encrypted backup saved to ${p}`)
    passphrase.value = ''
  }
}
async function restore(): Promise<void> {
  confirmRestore.value = false
  busy.value = true
  const ok = await guard(() => window.api.data.restore(passphrase.value), 'Restore failed')
  busy.value = false
  if (ok) {
    toast.info('Backup restored')
    passphrase.value = ''
    window.location.reload()
  }
}

async function toggle(key: string): Promise<void> {
  await settings.set(key, settings.bool(key) ? '0' : '1')
}

async function saveGmail(): Promise<void> {
  saving.value = true
  const res = await guard(() => window.api.gmail.configure({ user: user.value.trim(), appPassword: appPassword.value }), 'Could not save')
  saving.value = false
  if (res) {
    sync.gmail = res
    appPassword.value = ''
    toast.info('Gmail credentials saved to your Keychain')
    await testConnection()
  }
}
async function googleSignIn(): Promise<void> {
  signingIn.value = true
  const input = showClientFields.value ? { clientId: clientId.value, clientSecret: clientSecret.value } : { clientId: '', clientSecret: '' }
  const res = await guard(() => window.api.gmail.signInWithGoogle(input), 'Google sign-in failed')
  signingIn.value = false
  if (res) {
    sync.gmail = res
    user.value = res.user ?? ''
    clientId.value = res.oauthClientId ?? ''
    clientSecret.value = ''
    editingClient.value = false
    toast.info(`Signed in as ${res.user}`)
    await testConnection()
  }
}
async function cancelSignIn(): Promise<void> {
  await window.api.gmail.cancelSignIn()
}
async function testConnection(): Promise<void> {
  testing.value = true
  testResult.value = null
  testResult.value = (await guard(() => window.api.gmail.test(), 'Test failed')) ?? null
  testing.value = false
}
async function clearGmail(): Promise<void> {
  const res = await guard(() => window.api.gmail.clear(), 'Could not disconnect')
  if (res) {
    sync.gmail = res
    user.value = ''
    testResult.value = null
    toast.info('Gmail disconnected')
  }
}
async function saveTrackingStart(): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trackingStart.value)) return
  await settings.set('tracking_start', trackingStart.value)
  toast.info('Saved')
}
</script>

<template>
  <div>
    <h1>Settings</h1>
    <div class="grid cols-2">
      <div class="card">
        <h2>Gmail connection</h2>
        <p class="small muted">
          The app reads HDFC Bank alert emails from your Gmail over IMAP. <strong>Sign in with Google</strong> to connect:
          no password is stored, only a sign-in token, encrypted in your macOS Keychain. It never leaves this Mac.
        </p>
        <div v-if="sync.gmail?.configured" class="row between" style="margin: 10px 0">
          <div>
            <div><span class="status-ok">●</span> Connected as <strong>{{ sync.gmail.user }}</strong></div>
            <div class="small muted">
              {{ sync.gmail.auth === 'oauth' ? 'Google sign-in' : 'App password' }} · alerts from {{ sync.gmail.sender }} ·
              <template v-if="sync.gmail.lastSyncAt">last sync {{ fmtDateTime(sync.gmail.lastSyncAt) }}</template>
              <template v-else>never synced</template>
            </div>
          </div>
          <div class="row">
            <button class="sm" :disabled="testing" @click="testConnection">{{ testing ? 'Testing…' : 'Test' }}</button>
            <button class="sm danger" @click="clearGmail">Disconnect</button>
          </div>
        </div>
        <form @submit.prevent="googleSignIn">
          <template v-if="showClientFields">
            <p class="small muted">
              One-time setup: create a free <strong>Desktop app</strong> OAuth client in Google Cloud Console
              (steps in <code>docs/gmail-oauth-setup.md</code>) and paste its ID and secret here.
            </p>
            <div class="form-grid">
              <label class="field full">
                OAuth client ID
                <input v-model="clientId" placeholder="1234-abc.apps.googleusercontent.com" autocomplete="off" spellcheck="false" />
              </label>
              <label class="field full">
                OAuth client secret
                <input
                  v-model="clientSecret"
                  type="password"
                  :placeholder="sync.gmail?.oauthClientSaved ? 'Saved in Keychain (leave blank to keep)' : 'GOCSPX-…'"
                  autocomplete="off"
                />
              </label>
            </div>
          </template>
          <div class="actions" style="margin-top: 10px">
            <button v-if="signingIn" type="button" @click="cancelSignIn">Cancel</button>
            <button v-else-if="sync.gmail?.oauthClientSaved && !editingClient" type="button" class="sm" @click="editingClient = true">
              Change OAuth client
            </button>
            <button type="submit" class="primary" :disabled="!canSignIn">
              {{ signingIn ? 'Waiting for browser…' : sync.gmail?.auth === 'oauth' ? 'Sign in again' : 'Sign in with Google' }}
            </button>
          </div>
          <p v-if="signingIn" class="small muted">
            Finish signing in in your browser. If Google says the app isn't verified, choose
            <strong>Advanced → Go to (app name)</strong>, then tick the Gmail permission.
          </p>
        </form>
        <details style="margin-top: 14px">
          <summary class="small muted" style="cursor: pointer">Use an app password instead (needs 2-Step Verification)</summary>
          <form @submit.prevent="saveGmail">
            <div class="form-grid">
              <label class="field full">
                Gmail address
                <input v-model="user" type="email" placeholder="you@gmail.com" autocomplete="off" />
              </label>
              <label class="field full">
                App password (16 characters)
                <input v-model="appPassword" type="password" placeholder="xxxx xxxx xxxx xxxx" autocomplete="off" />
              </label>
            </div>
            <div class="actions" style="margin-top: 10px">
              <button type="submit" class="primary" :disabled="saving || !user || !appPassword">
                {{ sync.gmail?.auth === 'password' ? 'Update app password' : 'Connect with app password' }}
              </button>
            </div>
          </form>
        </details>
        <p v-if="testResult" class="small" :class="testResult.ok ? 'status-ok' : 'status-bad'">{{ testResult.message }}</p>
        <p v-if="sync.gmail && !sync.gmail.encryptionAvailable" class="small status-bad">
          Keychain encryption is unavailable, credentials can't be stored.
        </p>
      </div>

      <div class="card">
        <h2>Sync behaviour</h2>
        <label class="row" style="gap: 8px; margin-top: 8px">
          <input type="checkbox" :checked="settings.bool('sync_on_launch')" @change="toggle('sync_on_launch')" />
          Sync automatically when the app opens
        </label>
        <label class="row" style="gap: 8px; margin-top: 8px">
          <input type="checkbox" :checked="settings.bool('trash_email_on_delete')" @change="toggle('trash_email_on_delete')" />
          When I delete a transaction, also move its alert email to Gmail trash
        </label>
        <label class="row" style="gap: 8px; margin-top: 8px">
          <input type="checkbox" :checked="settings.bool('notify_budget')" @change="toggle('notify_budget')" />
          Show a macOS notification when a budget is crossed
        </label>
        <div class="row" style="margin-top: 14px; gap: 8px">
          <label class="field" style="flex: 1">
            Track transactions from
            <input v-model="trackingStart" type="date" />
          </label>
          <button class="sm" style="margin-top: 18px" @click="saveTrackingStart">Save</button>
        </div>
        <p class="small muted" style="margin-top: 4px">
          Email alerts and statement rows dated before this day are skipped. Defaults to the first of the current month, so a
          fresh install starts clean. Move it earlier later if you want to backfill.
        </p>
        <p v-if="sync.last" class="small muted" style="margin-top: 12px">
          Last run: {{ sync.last.fetched }} emails fetched, {{ sync.last.inserted }} added, {{ sync.last.skippedDuplicate }} already known,
          {{ sync.last.skippedNonTransaction }} not transactions,<template v-if="sync.last.skippedBeforeStart"> {{ sync.last.skippedBeforeStart }} before start date,</template> {{ sync.last.needsReview }} need review.
          <span v-if="sync.last.errors.length" class="status-bad">{{ sync.last.errors.length }} failed.</span>
        </p>
        <ul v-if="sync.last?.errors.length" class="small status-bad">
          <li v-for="e in sync.last.errors" :key="e">{{ e }}</li>
        </ul>
      </div>

      <div class="card">
        <h2>Your data</h2>
        <label class="row" style="gap: 8px; margin-bottom: 12px">
          <input type="checkbox" :checked="openAtLogin" @change="toggleLogin" />
          Open Expense Tracker when I log in to this Mac
        </label>
        <div class="row" style="margin-bottom: 12px">
          <button @click="exportCsv">Export all transactions as CSV…</button>
        </div>
        <label class="field" style="margin-bottom: 8px">
          Backup passphrase (needed to restore; not stored anywhere)
          <input v-model="passphrase" type="password" autocomplete="off" placeholder="at least 8 characters" />
        </label>
        <div class="row">
          <button :disabled="busy || passphrase.length < 8" @click="backup">Save encrypted backup…</button>
          <button class="danger" :disabled="busy || passphrase.length < 8" @click="confirmRestore = true">Restore from backup…</button>
        </div>
        <p class="small muted" style="margin-bottom: 0">Backups are AES-256 encrypted copies of the database without your Gmail or AI keys.</p>
      </div>

      <div class="card">
        <h2>About</h2>
        <p class="small">Version {{ settings.info?.version }}</p>
        <p class="small muted">Database: <span class="mono">{{ settings.info?.dbPath }}</span></p>
        <p class="small muted">
          All data stays on this Mac. Deleted transactions are overwritten in the database file; only an anonymous hash
          is kept so re-sync won't bring them back. Consider excluding the database folder from Time Machine if you
          want deletions to be gone from backups too.
        </p>
      </div>
    </div>
    <Modal v-if="confirmRestore" title="Restore from backup?" @close="confirmRestore = false">
      <p>All transactions, categories, rules and budgets in the app will be replaced with the ones in the backup file you pick next.</p>
      <p class="small muted">
        Anything added or changed since that backup was made will be lost. A copy of your current data is saved first, encrypted with
        the same passphrase. This cannot be undone from inside the app.
      </p>
      <div class="actions">
        <button @click="confirmRestore = false">Cancel</button>
        <button class="danger" @click="restore">Choose backup file…</button>
      </div>
    </Modal>
  </div>
</template>
