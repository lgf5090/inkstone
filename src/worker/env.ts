
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export interface Env {

  DB: D1Database

  ASSETS: Fetcher

  FILES?: R2Bucket

  FILES_KV?: KVNamespace

  OAUTH_KV: KVNamespace

  OAUTH_PROVIDER?: OAuthHelpers

  SYNC_HUB?: DurableObjectNamespace

  CREDENTIAL_VAULT?: DurableObjectNamespace

  APP_NAME?: string

  PUBLIC_URL?: string

  SETUP_TOKEN?: string

  DO_AUTH_KEY?: string

  /**
   * Comma-separated bare provider hosts added to CSP `connect-src`, for a deployment whose readers
   * call an AI endpoint of their own. Optional; blank keeps the built-in preset hosts.
   */
  AI_CONNECT_HOSTS?: string

  /** Workers AI binding for semantic search; optional so AI search degrades gracefully. */
  AI?: {
    run: <T = unknown>(model: string, inputs: unknown) => Promise<T>
  }

  /**
   * The runtime the code interpreter loads its scratch Workers into.
   *
   * Optional, and its absence is not an error: a deployment that has not been given the binding simply
   * has no `code_execute` tool, which is a smaller app rather than a broken one. The binding is a
   * deployment capability like `FILES` or `AI`, so it is declared here as one and checked where the tool
   * is offered, not where it runs.
   */
  CODE_SANDBOX?: WorkerLoader
}

export interface DatabaseState {
  ftsEnabled: boolean
}


export interface Variables {

  database: DatabaseState
  userId: string

  sessionId: string

  user: {
    id: string
    username: string
    login: string
    name: string
    avatarUrl: string
    role: 'owner' | 'member'
    createdAt: number
    settingsRaw: string
  }
}

export type AppBindings = { Bindings: Env; Variables: Variables }
