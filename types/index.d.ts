export type Window = { percentUsed: number; resetsAt: string | null }

export type Snapshot = {
  fiveHour: Window | null
  sevenDay: Window | null
  costUsd: number | null
}

/** A per-model weekly limit (`Fable`), as the app's usage card lists it. */
export type ModelWindow = Window & { name: string }

/** What /api/oauth/usage answered: the account windows plus per-model ones. */
export type Remote = {
  fiveHour: Window | null
  sevenDay: Window | null
  models: ModelWindow[]
}

export type Tokens = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': {
      snap: Snapshot
      remote: Remote | null
      tokens: Tokens
      now: number
      isHidden: boolean
    }
  }
}
