import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { Friend } from '@shared/types'

export const useFriendsStore = defineStore('friends', () => {
  const items = ref<Friend[]>([])
  const byId = computed(() => new Map(items.value.map((f) => [f.id, f])))
  /** Friends who still owe the user, largest first. */
  const owing = computed(() => items.value.filter((f) => f.balancePaise > 0).sort((a, b) => b.balancePaise - a.balancePaise))
  const owedTotalPaise = computed(() => owing.value.reduce((n, f) => n + f.balancePaise, 0))

  async function load(): Promise<void> {
    items.value = await window.api.friends.list()
  }
  function name(id: number | null): string {
    return id === null ? '' : (byId.value.get(id)?.name ?? 'Unknown')
  }
  return { items, byId, owing, owedTotalPaise, load, name }
})
