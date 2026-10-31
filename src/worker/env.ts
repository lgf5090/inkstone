
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export interface Env {

  DB: D1Database

  ASSETS: Fetcher

  FILES?: R2Bucket

  FILES_KV?: KVNamespace

  IMAGES?: ImagesBinding

  R2_PUBLIC_URL?: string
  TG_BOT_TOKEN?: string
  TG_CHAT_ID?: string
  TG_PROXY_URL?: string
  S3_ACCESS_KEY_ID?: string
  S3_SECRET_ACCESS_KEY?: string
  S3_REGION?: string
  S3_BUCKET_NAME?: string
  S3_ENDPOINT?: string
  S3_PATH_STYLE?: string
  S3_CDN_DOMAIN?: string
  S3_USER_AGENT?: string
  DISCORD_BOT_TOKEN?: string
  DISCORD_CHANNEL_ID?: string
  DISCORD_PROXY_URL?: string
  DISCORD_IS_NITRO?: string
  HF_TOKEN?: string
  HF_REPO?: string
  HF_PRIVATE?: string
  WEBDAV_BASE_URL?: string
  WEBDAV_USERNAME?: string
  WEBDAV_PASSWORD?: string
  WEBDAV_PUBLIC_URL?: string
  WEBDAV_HEADERS?: string
  WEBDAV_CREATE_DIRECTORY?: string

  OAUTH_KV: KVNamespace

  OAUTH_PROVIDER?: OAuthHelpers

  /** Signs the daily visitor-fingerprint salt; without it no fingerprint is recorded. */
  SHORTLINKS_SECRET?: string

  SYNC_HUB?: DurableObjectNamespace

  CREDENTIAL_VAULT?: DurableObjectNamespace

  /** Optional default password for navigation categories that choose "use default". Set as a secret. */
  NAV_DEFAULT_CATEGORY_PASSWORD?: string

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

  /**
   * A public HTTPS base for a self-hosted Netease API, used when the native client cannot reach the
   * upstream from this deployment. Optional: unset keeps every request on the native path.
   */
  MUSIC_UPSTREAM_API?: string

  /**
   * YouTube Data API v3 key, set as a secret (`wrangler secret put`). With it unset the YouTube
   * app still opens its saved library, and every upstream route answers 503.
   */
  YOUTUBE_API_KEY?: string

  /** A proxy base for the YouTube Data API; must be https and carries no query or credentials. */
  YOUTUBE_API_BASE?: string

  /** A proxy base for video thumbnails; https, or loopback http for a local adapter. */
  YOUTUBE_IMAGE_BASE?: string

  /** The two-letter region `mostPopular` should describe; unset leaves the upstream default. */
  YOUTUBE_REGION_CODE?: string

  /** The deployment's own daily unit budget, which may be below Google's own 10,000. */
  YOUTUBE_DAILY_QUOTA?: string

  /** The per-account download queue; optional so a deployment without R2 can omit it. */
  MUSIC_QUEUE?: DurableObjectNamespace

  /** The cross-isolate public-share counter; optional so a small deployment can omit it. */
  MUSIC_SHARE_LIMITER?: DurableObjectNamespace

  /**
   * The bare domain Email Routing delivers to this Worker, as in `mail.example.com`. Optional: with
   * it unset no address can be formed, so the mail-token routes answer 503 and inbound mail is
   * dropped. Set it as a plain variable, not a secret — it is printed in every address.
   */
  MAIL_DOMAIN?: string

  /** Workers AI binding for semantic search; optional so AI search degrades gracefully. */
  AI?: {
    run: <T = unknown>(model: string, inputs: unknown) => Promise<T>
  }

  EMAIL?: SendEmail

  EMAIL_MAILBOX?: DurableObjectNamespace

  EMAIL_DOMAINS?: string

  EMAIL_ADDRESSES?: string

  /**
   * Google Calendar OAuth client. Both halves are server secrets; with either unset the calendar
   * sign-in route answers 503 instead of sending the reader to an authorization page that cannot
   * come back. Plain CalDAV connections do not need them.
   */
  GOOGLE_CLIENT_ID?: string

  GOOGLE_CLIENT_SECRET?: string

  /** Microsoft Graph OAuth client, with the same all-or-nothing rule as the Google pair. */
  OUTLOOK_CLIENT_ID?: string

  OUTLOOK_CLIENT_SECRET?: string

  /**
   * The public origin the OAuth callback is registered under, as in `https://notes.example.com`.
   * Optional: unset uses the origin of the request that started the flow. The callback path itself
   * is fixed at `/api/calendar/oauth/callback`.
   */
  CALENDAR_OAUTH_REDIRECT_BASE?: string
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
