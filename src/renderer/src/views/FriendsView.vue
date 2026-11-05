<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { Friend, FriendActivity } from '@shared/types'
import { formatINR } from '@shared/money'
import { useFriendsStore } from '../stores/friends'
import { guard, useToast } from '../composables/useToast'
import { fmtDateTime } from '../composables/useDates'
import Modal from '../components/Modal.vue'

const friends = useFriendsStore()
const toast = useToast()

const open = ref<number | null>(null)
const activity = ref<FriendActivity[]>([])
const renaming = ref<{ friend: Friend; name: string } | null>(null)
const confirmDelete = ref<Friend | null>(null)

onMounted(() => void friends.load())

async function toggle(f: Friend): Promise<void> {
  if (open.value === f.id) {
    open.value = null
    return
  }
  activity.value = (await guard(() => window.api.friends.activity(f.id))) ?? []
  open.value = f.id
}

async function rename(): Promise<void> {
  if (!renaming.value?.name.trim()) return
  const { friend, name } = renaming.value
  const ok = await guard(async () => {
    await window.api.friends.rename(friend.id, name)
    await friends.load()
    return true
  }, 'Could not rename')
  if (ok) renaming.value = null
}

async function remove(): Promise<void> {
  if (!confirmDelete.value) return
  const f = confirmDelete.value
  const ok = await guard(async () => {
    await window.api.friends.delete(f.id)
    await friends.load()
    return true
  }, 'Could not delete')
  confirmDelete.value = null
  if (ok) toast.info(`Removed ${f.name}`)
}

function balanceText(f: Friend): string {
  if (f.balancePaise > 0) return `owes you ${formatINR(f.balancePaise)}`
  if (f.balancePaise < 0) return `you owe ${formatINR(-f.balancePaise)}`
  return 'settled up'
}
</script>

<template>
  <div>
    <div class="row between" style="margin-bottom: 16px">
      <h1 style="margin: 0">Friends</h1>
      <div v-if="friends.owedTotalPaise">
        <span class="muted small">Owed to you </span>
        <span class="money ok-text" style="font-size: 18px">{{ formatINR(friends.owedTotalPaise) }}</span>
      </div>
    </div>

    <div v-if="!friends.items.length" class="card empty">
      No friends yet. When you pay a bill for friends too, open the transaction and tick
      “I paid for friends too” to record their shares. When they pay you back, use “Friend paying back?” on the incoming payment.
    </div>

    <div v-else class="card" style="padding: 0">
      <table>
        <tbody>
          <template v-for="f in friends.items" :key="f.id">
            <tr class="clickable" @click="toggle(f)">
              <td style="width: 24px" class="muted">{{ open === f.id ? '▾' : '▸' }}</td>
              <td>
                <strong>{{ f.name }}</strong>
                <div v-if="f.vpas.length" class="small muted">{{ f.vpas.join(', ') }}</div>
              </td>
              <td class="small muted">Shared {{ formatINR(f.sharedPaise) }} · paid back {{ formatINR(f.settledPaise) }}</td>
              <td class="num" :class="f.balancePaise > 0 ? 'ok-text' : f.balancePaise < 0 ? 'warn-text' : 'muted'">{{ balanceText(f) }}</td>
              <td class="num" style="white-space: nowrap" @click.stop>
                <button class="ghost sm" @click="renaming = { friend: f, name: f.name }">Rename</button>
                <button class="ghost sm danger" :disabled="f.sharedPaise > 0 || f.settledPaise > 0" :title="f.sharedPaise || f.settledPaise ? 'Has split bills or paybacks recorded' : `Remove ${f.name}`" @click="confirmDelete = f">✕</button>
              </td>
            </tr>
            <tr v-if="open === f.id">
              <td />
              <td colspan="4" style="padding-top: 0">
                <div v-if="!activity.length" class="small muted">Nothing recorded.</div>
                <table v-else class="small">
                  <tbody>
                    <tr v-for="a in activity" :key="`${a.type}-${a.txnId}`">
                      <td class="muted" style="white-space: nowrap">{{ fmtDateTime(a.postedAt) }}</td>
                      <td>
                        <template v-if="a.type === 'share'">Their share of {{ a.payee }} <span class="muted">(bill {{ formatINR(a.billPaise ?? 0) }})</span></template>
                        <template v-else>Paid you back <span class="muted">({{ a.payee }})</span></template>
                      </td>
                      <td class="num money" :class="a.type === 'settlement' ? 'ok-text' : ''">
                        {{ a.type === 'settlement' ? '−' : '+' }}{{ formatINR(a.amountPaise) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <Modal v-if="renaming" title="Rename friend" @close="renaming = null">
      <form @submit.prevent="rename">
        <label class="field">
          Name
          <input v-model="renaming.name" autofocus />
        </label>
        <div class="actions">
          <button type="button" @click="renaming = null">Cancel</button>
          <button type="submit" class="primary" :disabled="!renaming.name.trim()">Save</button>
        </div>
      </form>
    </Modal>
    <Modal v-if="confirmDelete" title="Remove friend?" @close="confirmDelete = null">
      <p>Remove <strong>{{ confirmDelete.name }}</strong> and the UPI IDs remembered for them?</p>
      <div class="actions">
        <button @click="confirmDelete = null">Cancel</button>
        <button class="danger" @click="remove">Remove</button>
      </div>
    </Modal>
  </div>
</template>
