
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
   * The VAPID key pair Web Push is signed with, both set as secrets (`wrangler secret put`), never in a
   * config file. The public half is the base64url of an uncompressed P-256 point and is handed to browsers;
   * the private half is its JWK and leaves this process only inside a signed claim. With either unset, the
   * push routes say so instead of pretending a send happened — see `assistant/push.ts`.
   */
  VAPID_PUBLIC_KEY?: string

  VAPID_PRIVATE_KEY?: string

  /**
   * The contact a push service may reach for abuse reports, as a `mailto:` or `https:` value. Optional: a
   * deployment that leaves it unset signs a claim without a subject.
   */
  VAPID_SUBJECT?: string

  /**
   * Comma-separated bare provider hosts added to CSP `connect-src`, for a deployment whose readers
   * call an AI endpoint of their own. Optional; blank keeps the built-in preset hosts.
   */
  AI_CONNECT_HOSTS?: string

  /** Workers AI binding for semantic search; optional so AI search degrades gracefully. */
  AI?: {
    run: <T = unknown>(model: string, inputs: unknown) => Promise<T>
  }
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
