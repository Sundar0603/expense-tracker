import type { Api } from '../shared/api'

declare global {
  interface Window {
    api: Api
    events: {
      on(channel: 'ai:chunk', cb: (payload: { requestId: string; delta: string }) => void): () => void
    }
  }
}

export {}
