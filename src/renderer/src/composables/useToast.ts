import { reactive } from 'vue'

export interface Toast {
  id: number
  text: string
  kind: 'info' | 'error'
}

const state = reactive<{ toasts: Toast[] }>({ toasts: [] })
let seq = 0

export function useToast() {
  function push(text: string, kind: Toast['kind'] = 'info', ms = 3500): void {
    const id = ++seq
    state.toasts.push({ id, text, kind })
    setTimeout(() => {
      const i = state.toasts.findIndex((t) => t.id === id)
      if (i >= 0) state.toasts.splice(i, 1)
    }, ms)
  }
  return {
    toasts: state.toasts,
    info: (t: string) => push(t, 'info'),
    error: (t: string) => push(t, 'error', 6000)
  }
}

/** Run an async action and toast on failure. Returns undefined on error. */
export async function guard<T>(fn: () => Promise<T>, onErrorText?: string): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(e)
    useToast().error(onErrorText ? `${onErrorText}: ${msg}` : msg)
    return undefined
  }
}
