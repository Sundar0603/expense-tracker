<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import type { Category } from '@shared/types'
import { useCategoriesStore } from '../stores/categories'
import { guard, useToast } from '../composables/useToast'
import Modal from '../components/Modal.vue'

const categories = useCategoriesStore()
const toast = useToast()
// Opened from the Transactions page's category manager: offer a way straight back.
const cameFromTransactions = useRoute().query['from'] === 'transactions'

const editing = ref<Category | null>(null)
const creating = ref(false)
const name = ref('')
const icon = ref('🏷️')
const color = ref('#3b82f6')
const needsNote = ref(false)
const confirmDelete = ref<Category | null>(null)

function openCreate(): void {
  name.value = ''
  icon.value = '🏷️'
  color.value = '#3b82f6'
  needsNote.value = false
  creating.value = true
}
function openEdit(c: Category): void {
  name.value = c.name
  icon.value = c.icon
  color.value = c.color
  needsNote.value = c.needsNote
  editing.value = c
}
async function save(): Promise<void> {
  if (!name.value.trim()) return
  const payload = { name: name.value.trim(), icon: icon.value.trim() || '🏷️', color: color.value, needsNote: needsNote.value }
  const ok = editing.value
    ? await guard(() => categories.update(editing.value!.id, payload), 'Could not save')
    : await guard(() => categories.create({ ...payload, sortOrder: Math.max(-1, ...categories.items.map((x) => x.sortOrder)) + 1 }), 'Could not create')
  if (ok !== undefined) {
    creating.value = false
    editing.value = null
    toast.info('Category saved')
  }
}
async function remove(): Promise<void> {
  if (!confirmDelete.value) return
  await guard(() => categories.remove(confirmDelete.value!.id), 'Could not delete')
  confirmDelete.value = null
  editing.value = null
}
async function move(c: Category, delta: number): Promise<void> {
  const list = [...categories.items]
  const i = list.findIndex((x) => x.id === c.id)
  const j = i + delta
  if (j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j]!, list[i]!]
  // Renumber everything: after deletes/creates the stored orders have gaps and ties, so swapping
  // two indices alone may not change the visible order.
  await guard(async () => {
    for (const [k, x] of list.entries()) if (x.sortOrder !== k) await window.api.categories.update(x.id, { sortOrder: k })
    await categories.load()
  })
}
</script>

<template>
  <div>
    <RouterLink v-if="cameFromTransactions" to="/transactions" class="small" style="display: inline-block; margin-bottom: 8px">← Back to Transactions</RouterLink>
    <div class="row between" style="margin-bottom: 16px">
      <h1 style="margin: 0">Categories</h1>
      <button class="primary" @click="openCreate">+ New category</button>
    </div>
    <div class="card" style="padding: 0">
      <table>
        <tbody>
          <tr v-for="(c, i) in categories.items" :key="c.id" class="clickable" @click="openEdit(c)">
            <td style="width: 40px; font-size: 20px">{{ c.icon }}</td>
            <td><strong>{{ c.name }}</strong> <span v-if="c.needsNote" class="small muted">· needs a description</span></td>
            <td><span class="dot" :style="{ background: c.color }" /> <span class="small muted mono">{{ c.color }}</span></td>
            <td class="num" style="white-space: nowrap" @click.stop>
              <button class="ghost sm" :disabled="i === 0" @click="move(c, -1)">↑</button>
              <button class="ghost sm" :disabled="i === categories.items.length - 1" @click="move(c, 1)">↓</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="creating || editing" :title="editing ? 'Edit category' : 'New category'" @close="creating = false; editing = null">
      <form @submit.prevent="save">
        <div class="form-grid">
          <label class="field">
            Icon (emoji)
            <input v-model="icon" maxlength="4" style="font-size: 20px" />
          </label>
          <label class="field">
            Colour
            <input v-model="color" type="color" style="height: 38px; padding: 2px" />
          </label>
          <label class="field full">
            Name
            <input v-model="name" placeholder="e.g. Petrol" autofocus />
          </label>
          <label class="full row" style="gap: 8px; font-size: 13px">
            <input v-model="needsNote" type="checkbox" /> Ask what it was: expenses here need a description
          </label>
        </div>
        <div class="actions">
          <button v-if="editing" type="button" class="danger" style="margin-right: auto" @click="confirmDelete = editing">Delete</button>
          <button type="button" @click="creating = false; editing = null">Cancel</button>
          <button type="submit" class="primary" :disabled="!name.trim()">Save</button>
        </div>
      </form>
    </Modal>
    <Modal v-if="confirmDelete" title="Delete category?" @close="confirmDelete = null">
      <p>Transactions in <strong>{{ confirmDelete.name }}</strong> become uncategorized. Budgets for it are removed. Rules pointing to it are kept but need a new category.</p>
      <div class="actions">
        <button @click="confirmDelete = null">Cancel</button>
        <button class="danger" @click="remove">Delete</button>
      </div>
    </Modal>
  </div>
</template>
