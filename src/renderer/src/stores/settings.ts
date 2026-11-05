import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useSettingsStore = defineStore('settings', () => {
  const values = ref<Record<string, string>>({})
  const info = ref<{ version: string; dbPath: string; platform: string } | null>(null)

  async function load(): Promise<void> {
    const [v, i] = await Promise.all([window.api.settings.getAll(), window.api.app.info()])
    values.value = v
    info.value = i
  }
  async function set(key: string, value: string): Promise<void> {
    await window.api.settings.set(key, value)
    values.value = { ...values.value, [key]: value }
  }
  function bool(key: string, fallback = false): boolean {
    const v = values.value[key]
    return v === undefined ? fallback : v === '1' || v === 'true'
  }
  return { values, info, load, set, bool }
})
