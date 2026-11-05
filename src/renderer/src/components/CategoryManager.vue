<script setup lang="ts">
import { ref } from 'vue'
import type { Category } from '@shared/types'
import { useCategoriesStore } from '../stores/categories'
import { guard, useToast } from '../composables/useToast'

/** Add and delete categories without leaving the current page. Edits and reordering live on the Categories page. */
defineProps<{ assigning?: boolean }>()
const emit = defineEmits<{ created: [Category]; close: [] }>()

const categories = useCategoriesStore()
const toast = useToast()

const PALETTE = ['#f97316', '#84cc16', '#06b6d4', '#eab308', '#3b82f6', '#ec4899', '#ef4444', '#a855f7', '#14b8a6', '#6366f1']
const name = ref('')
const icon = ref('🏷️')
const color = ref(PALETTE[categories.items.length % PALETTE.length]!)
const adding = ref(false)
const confirmId = ref<number | null>(null)

async function add(): Promise<void> {
  if (!name.value.trim() || adding.value) return
  adding.value = true
  const c = await guard(
    () =>
      categories.create({
        name: name.value.trim(),
        icon: icon.value.trim() || '🏷️',
        color: color.value,
        sortOrder: Math.max(-1, ...categories.items.map((x) => x.sortOrder)) + 1
      }),
    'Could not add'
  )
  adding.value = false
  if (!c) return
  toast.info(`Added ${c.name}`)
  name.value = ''
  icon.value = '🏷️'
  color.value = PALETTE[categories.items.length % PALETTE.length]!
  emit('created', c)
}

async function remove(c: Category): Promise<void> {
  const ok = await guard(() => categories.remove(c.id), 'Could not delete')
  confirmId.value = null
  if (ok) toast.info(`Deleted ${c.name}`)
}
</script>

<template>
  <div>
    <form class="row" style="gap: 8px; align-items: flex-end" @submit.prevent="add">
      <label class="field" style="width: 64px">
        Icon
        <input v-model="icon" maxlength="4" style="font-size: 18px; text-align: center" />
      </label>
      <label class="field" style="flex: 1">
        {{ assigning ? 'New category for this transaction' : 'New category' }}
        <input v-model="name" placeholder="e.g. Petrol" autofocus />
      </label>
      <label class="field" style="width: 52px">
        Colour
        <input v-model="color" type="color" style="height: 38px; padding: 2px" />
      </label>
      <button type="submit" class="primary" :disabled="!name.trim() || adding">Add</button>
    </form>

    <div v-if="!assigning" class="cat-list">
      <div v-for="c in categories.items" :key="c.id" class="cat-row">
        <template v-if="confirmId === c.id">
          <span class="small" style="flex: 1">
            Delete <strong>{{ c.name }}</strong>? Its transactions become uncategorized and its budget is removed.
          </span>
          <button class="sm" @click="confirmId = null">Cancel</button>
          <button class="sm danger" @click="remove(c)">Delete</button>
        </template>
        <template v-else>
          <span style="width: 26px; font-size: 18px">{{ c.icon }}</span>
          <span class="dot" :style="{ background: c.color }" />
          <span style="flex: 1">{{ c.name }}</span>
          <button class="ghost sm danger" :title="`Delete ${c.name}`" @click="confirmId = c.id">✕</button>
        </template>
      </div>
      <div v-if="!categories.items.length" class="small muted" style="padding: 12px 0">No categories yet. Add one above.</div>
    </div>

    <div class="actions">
      <RouterLink v-if="!assigning" :to="{ path: '/categories', query: { from: 'transactions' } }" class="small" style="margin-right: auto; align-self: center" @click="emit('close')">
        Rename, recolour or reorder…
      </RouterLink>
      <button type="button" @click="emit('close')">{{ assigning ? 'Cancel' : 'Done' }}</button>
    </div>
  </div>
</template>

<style scoped>
.cat-list { margin-top: 16px; max-height: 50vh; overflow-y: auto; border-top: 1px solid var(--border); }
.cat-row { display: flex; align-items: center; gap: 10px; padding: 6px 2px; border-bottom: 1px solid var(--border); min-height: 40px; }
</style>
