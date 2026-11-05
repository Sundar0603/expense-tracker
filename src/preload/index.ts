import { contextBridge, ipcRenderer } from 'electron'
import { API_GROUPS, type Api } from '@shared/api'

// Build window.api from the shared contract so main and renderer can't drift apart.
const api: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {}
for (const [group, methods] of Object.entries(API_GROUPS)) {
  api[group] = {}
  for (const method of methods as string[]) {
    api[group]![method] = (...args: unknown[]) => ipcRenderer.invoke(`${group}.${method}`, ...args)
  }
}

contextBridge.exposeInMainWorld('api', api as unknown as Api)

// One-way events from main (e.g. streamed AI chunks). Returns an unsubscribe function.
contextBridge.exposeInMainWorld('events', {
  on(channel: string, cb: (payload: unknown) => void): () => void {
    const allowed = ['ai:chunk']
    if (!allowed.includes(channel)) throw new Error(`Unknown event channel ${channel}`)
    const listener = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
})
