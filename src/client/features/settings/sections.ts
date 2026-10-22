import { backupRunsResource, backupTargetsResource, mcpResource, sharesResource, statsResource, totpResource } from './resources'
import { useSession } from '../../store/session'
import type { MessageKey } from '../../lib/i18n'

export type SettingsSection = 'appearance' | 'editor' | 'properties' | 'notes' | 'search' | 'backup' | 'sync' | 'mcp' | 'account' | 'data' | 'shares' | 'automation' | 'queries' | 'tasks' | 'linter' | 'excalidraw' | 'mindmap' | 'reading' | 'rss' | 'todo' | 'about'

export const SECTION_LABEL_KEYS: Record<SettingsSection, MessageKey> = {
  rss: 'settings.rss',
  appearance: 'settings.appearance',
  editor: 'settings.editor',
  properties: 'settings.properties',
  notes: 'settings.new_notes',
  search: 'settings.search',
  backup: 'settings.backup',
  sync: 'settings.sync',
  mcp: 'settings.mcp',
  automation: 'settings.automation',
  queries: 'settings.dataview',
  tasks: 'settings.tasks',
  linter: 'settings.markdown_linter',
  excalidraw: 'settings.excalidraw',
  mindmap: 'settings.mindmap_title',
  reading: 'settings.reading_title',
  todo: 'todo.title',
  account: 'settings.account',
  data: 'settings.data',
  shares: 'share.shared_notes',
  about: 'settings.about',
}

export const settingsLoaders = {
  rss: () => import('./RssSettings').then((m) => ({ default: m.RssSettings })),
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
  queries: () => import('./DataviewSettings').then((m) => ({ default: m.DataviewSettings })),
  tasks: () => import('./TasksSettings').then((m) => ({ default: m.TasksSettings })),
  linter: () => import('./LinterSettings').then((m) => ({ default: m.LinterSettings })),
  excalidraw: () => import('./ExcalidrawSettings').then((m) => ({ default: m.ExcalidrawSettings })),
  mindmap: () => import('./MindmapSettings').then((m) => ({ default: m.MindmapSettings })),
  reading: () => import('./ReaderSettings').then((m) => ({ default: m.ReaderSettings })),
  todo: () => import('./TodoSettings').then((m) => ({ default: m.TodoSettings })),
  about: () => import('./AboutSettings').then((m) => ({ default: m.AboutSettings })),
}

export function warmSettingsSection(section: SettingsSection): void {
  // A prefetch of the panel's own chunk, nothing more: the section imports it again when it is opened, and
  // that read is the one whose failure the boundary beside it reports. A failed warm-up costs a round
  // trip, never a panel.
  if (section !== 'appearance') void settingsLoaders[section]().catch(() => {})
  if (useSession.getState().status !== 'authed') return
  const resources = section === 'backup' ? [backupTargetsResource, backupRunsResource]
    : section === 'mcp' ? [mcpResource]
    : section === 'data' ? [statsResource]
    : section === 'account' ? [totpResource]
    : section === 'shares' ? [sharesResource] : []
  // Same shape: this only fills the resource cache. The panel that draws the data calls `load()` itself
  // and owns the error state — `BackupSettings` sets `loadError` from its own catch — so a warm-up that
  // fails leaves the panel to say so when the reader is looking at it.
  resources.forEach((resource) => { void resource.load().catch(() => {}) })
}

const warmupQueue: SettingsSection[] = []
const queuedWarmup = new Set<SettingsSection>()
let warmupTimer: number | undefined
/** Spacing between warming two sections, so a warm-up queue never floods the network. */
const WARMUP_STAGGER_MS = 150

function drainWarmupQueue(): void {
  warmupTimer = undefined
  const section = warmupQueue.shift()
  if (!section) return
  warmSettingsSection(section)
  if (warmupQueue.length) warmupTimer = window.setTimeout(drainWarmupQueue, WARMUP_STAGGER_MS)
}

/**
 * The delay a caller gets when it names none: long enough for the panel's own first paint and the
 * route it came in on to finish before the warm-up starts taking bandwidth from them.
 */
const DEFAULT_WARMUP_DELAY_MS = 1200

export function scheduleSettingsWarmup(delay = DEFAULT_WARMUP_DELAY_MS): void {
  (Object.keys(settingsLoaders) as SettingsSection[]).forEach((section) => {
    if (queuedWarmup.has(section)) return
    queuedWarmup.add(section)
    warmupQueue.push(section)
  })
  if (warmupTimer === undefined) warmupTimer = window.setTimeout(drainWarmupQueue, delay)
}
