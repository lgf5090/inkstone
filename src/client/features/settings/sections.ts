import { backupRunsResource, backupTargetsResource, mcpResource, sharesResource, statsResource, totpResource } from './resources'
import { useSession } from '../../store/session'
import type { MessageKey } from '../../lib/i18n'

export type SettingsSection = 'appearance' | 'editor' | 'properties' | 'notes' | 'search' | 'backup' | 'sync' | 'mcp' | 'account' | 'data' | 'shares' | 'automation' | 'linter' | 'about'

export const SECTION_LABEL_KEYS: Record<SettingsSection, MessageKey> = {
  appearance: 'settings.appearance',
  editor: 'settings.editor',
  properties: 'settings.properties',
  notes: 'settings.new_notes',
  search: 'settings.search',
  backup: 'settings.backup',
  sync: 'settings.sync',
  mcp: 'settings.mcp',
  automation: 'settings.automation',
  linter: 'settings.markdown_linter',
  account: 'settings.account',
  data: 'settings.data',
  shares: 'share.shared_notes',
  about: 'settings.about',
}

export const settingsLoaders = {
  editor: () => import('./EditorSettings').then((m) => ({ default: m.EditorSettings })),
  properties: () => import('./PropertiesSettings').then((m) => ({ default: m.PropertiesSettings })),
  notes: () => import('./NotesSettings').then((m) => ({ default: m.NotesSettings })),
  search: () => import('./SearchSettings').then((m) => ({ default: m.SearchSettings })),
  backup: () => import('./BackupSettings').then((m) => ({ default: m.BackupSettings })),
  sync: () => import('./SyncSettings').then((m) => ({ default: m.SyncSettings })),
  mcp: () => import('./McpSettings').then((m) => ({ default: m.McpSettings })),
  account: () => import('./AccountSettings').then((m) => ({ default: m.AccountSettings })),
  data: () => import('./DataSettings').then((m) => ({ default: m.DataSettings })),
  shares: () => import('./SharedNotes').then((m) => ({ default: m.SharedNotes })),
  automation: () => import('./QuickAddSettings').then((m) => ({ default: m.QuickAddSettings })),
  linter: () => import('./LinterSettings').then((m) => ({ default: m.LinterSettings })),
  about: () => import('./AboutSettings').then((m) => ({ default: m.AboutSettings })),
}

export function warmSettingsSection(section: SettingsSection): void {
  if (section !== 'appearance') void settingsLoaders[section]().catch(() => {})
  if (useSession.getState().status !== 'authed') return
  const resources = section === 'backup' ? [backupTargetsResource, backupRunsResource]
    : section === 'mcp' ? [mcpResource]
    : section === 'data' ? [statsResource]
    : section === 'account' ? [totpResource]
    : section === 'shares' ? [sharesResource] : []
  resources.forEach((resource) => { void resource.load().catch(() => {}) })
}

const warmupQueue: SettingsSection[] = []
const queuedWarmup = new Set<SettingsSection>()
let warmupTimer: number | undefined

function drainWarmupQueue(): void {
  warmupTimer = undefined
  const section = warmupQueue.shift()
  if (!section) return
  warmSettingsSection(section)
  if (warmupQueue.length) warmupTimer = window.setTimeout(drainWarmupQueue, 150)
}

export function scheduleSettingsWarmup(delay = 1200): void {
  (Object.keys(settingsLoaders) as SettingsSection[]).forEach((section) => {
    if (queuedWarmup.has(section)) return
    queuedWarmup.add(section)
    warmupQueue.push(section)
  })
  if (warmupTimer === undefined) warmupTimer = window.setTimeout(drainWarmupQueue, delay)
}
