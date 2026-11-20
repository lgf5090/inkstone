export const IS_DEMO_MODE = import.meta.env.MODE === 'demo'

export const DEMO_CREDENTIALS = {
  username: 'admin',
  password: 'password',
} as const

export function initialLoginCredentials(demo = IS_DEMO_MODE): { username: string; password: string } {
  return demo
    ? { ...DEMO_CREDENTIALS }
    : { username: '', password: '' }
}

export const CLIENT_DATABASE_NAME = IS_DEMO_MODE ? 'inkstone-demo' : 'inkstone'
export const UI_STORAGE_KEY = IS_DEMO_MODE ? 'inkstone.demo.ui' : 'inkstone.ui'
export const LOCALE_STORAGE_KEY = IS_DEMO_MODE ? 'inkstone-demo-locale' : 'inkstone-locale'
export const PINNED_WINDOWS_STORAGE_KEY = IS_DEMO_MODE ? 'inkstone.demo.pinnedWindows' : 'inkstone.pinnedWindows'

/** Events and the Background Sync tag shared by the service worker, sync engine and project pages. */
export const PROJECT_OUTBOX_SYNC_TAG = 'inkstone-project-outbox'
export const PROJECT_OUTBOX_SYNC_EVENT = 'inkstone:project-outbox-sync'
export const PROJECT_OUTBOX_CHANGED_EVENT = 'inkstone:project-outbox-changed'
export const PROJECT_OUTBOX_FLUSHED_EVENT = 'inkstone:project-outbox-flushed'
