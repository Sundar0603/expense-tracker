<script setup lang="ts">
import { onMounted } from 'vue'
import { useCategoriesStore } from './stores/categories'
import { useBudgetsStore } from './stores/budgets'
import { useFriendsStore } from './stores/friends'
import { useSettingsStore } from './stores/settings'
import { useSyncStore } from './stores/sync'
import ToastHost from './components/ToastHost.vue'
import { fmtDateTime } from './composables/useDates'

const nav = [
  { to: '/', label: 'Dashboard', icon: '◫' },
  { to: '/transactions', label: 'Transactions', icon: '☰' },
  { to: '/insights', label: 'Insights', icon: '📈' },
  { to: '/ai', label: 'AI assistant', icon: '✦' },
  { to: '/budgets', label: 'Budgets', icon: '◔' },
  { to: '/friends', label: 'Friends', icon: '⇄' },
  { to: '/categories', label: 'Categories', icon: '◈' },
  { to: '/rules', label: 'Rules', icon: '⚙' },
  { to: '/import', label: 'Import', icon: '⇪' },
  { to: '/settings', label: 'Settings', icon: '⋯' }
]

const categories = useCategoriesStore()
const budgets = useBudgetsStore()
const settings = useSettingsStore()
const sync = useSyncStore()

onMounted(async () => {
  await Promise.all([categories.load(), budgets.load(), useFriendsStore().load(), settings.load(), sync.loadStatus()])
  if (settings.bool('sync_on_launch') && sync.gmail?.configured) {
    void sync.run({ silent: true })
  }
})
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="drag-region" />
      <div class="brand">Expense Tracker</div>
      <nav>
        <RouterLink v-for="n in nav" :key="n.to" :to="n.to" class="nav-link" active-class="active">
          <span class="nav-icon" aria-hidden="true">{{ n.icon }}</span>
          <span>{{ n.label }}</span>
          <span v-if="n.to === '/budgets' && budgets.overCount" class="badge danger">{{ budgets.overCount }}</span>
        </RouterLink>
      </nav>
      <div class="spacer" />
      <div class="sync-box">
        <button class="primary" style="width: 100%" :disabled="sync.running || !sync.gmail?.configured" @click="sync.run()">
          {{ sync.running ? 'Syncing…' : 'Sync now' }}
        </button>
        <div class="small muted" style="margin-top: 6px; text-align: center">
          <template v-if="!sync.gmail?.configured"><RouterLink to="/settings">Connect Gmail</RouterLink> to sync</template>
          <template v-else-if="sync.gmail?.lastSyncAt">Last sync {{ fmtDateTime(sync.gmail.lastSyncAt) }}</template>
          <template v-else>Never synced</template>
        </div>
      </div>
    </aside>
    <main class="content">
      <RouterView />
    </main>
    <ToastHost />
  </div>
</template>
