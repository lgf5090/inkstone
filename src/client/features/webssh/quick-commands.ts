/**
 * The preset command shelf beside the terminal. Presets ship with the app, but the list the reader
 * sees is the one in localStorage from the first open onwards: deleting a preset is a real deletion,
 * not something the next load quietly puts back. Entries carry either a translated title key (the
 * shipped presets) or a title the reader typed, and every one of them can be edited, re-categorised
 * and starred like a hand-written command.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import { isImeComposing } from '../../lib/ime'

export const QUICK_COMMANDS_STORAGE_KEY = 'inkstone.webssh.quick_commands'
export const QUICK_COMMAND_TITLE_MAX = 80
export const QUICK_COMMAND_TEXT_MAX = 4000

export type QuickCommandCategory = 'system' | 'files' | 'network' | 'process' | 'docker' | 'logs' | 'custom'

export const QUICK_COMMAND_CATEGORIES: readonly QuickCommandCategory[] = [
  'system',
  'files',
  'network',
  'process',
  'docker',
  'logs',
  'custom',
]

export interface QuickCommandEntry {
  id: string
  /** Present on shipped presets only; the panel translates it instead of showing stored copy. */
  titleKey?: MessageKey
  /** Present on commands the reader typed, and on a preset the reader renamed. */
  title?: string
  command: string
  category: QuickCommandCategory
  favorite: boolean
}

export const DEFAULT_QUICK_COMMANDS: readonly QuickCommandEntry[] = [
  { id: 'preset-uptime', titleKey: 'webssh.quick.preset.uptime', command: 'uptime', category: 'system', favorite: false },
  { id: 'preset-whoami', titleKey: 'webssh.quick.preset.whoami', command: 'whoami', category: 'system', favorite: false },
  { id: 'preset-disk', titleKey: 'webssh.quick.preset.disk', command: 'df -h', category: 'files', favorite: false },
  { id: 'preset-memory', titleKey: 'webssh.quick.preset.memory', command: 'free -h', category: 'system', favorite: false },
  { id: 'preset-processes', titleKey: 'webssh.quick.preset.processes', command: 'ps aux --sort=-%cpu | head -20', category: 'process', favorite: false },
  { id: 'preset-docker', titleKey: 'webssh.quick.preset.docker', command: 'docker ps', category: 'docker', favorite: false },
  { id: 'preset-listeners', titleKey: 'webssh.quick.preset.listeners', command: 'ss -tlnp', category: 'network', favorite: false },
  { id: 'preset-journal', titleKey: 'webssh.quick.preset.journal', command: 'journalctl -n 50 --no-pager', category: 'logs', favorite: false },
]

function cloneDefaults(): QuickCommandEntry[] {
  return DEFAULT_QUICK_COMMANDS.map((entry) => ({ ...entry }))
}

function isCategory(value: unknown): value is QuickCommandCategory {
  return typeof value === 'string' && QUICK_COMMAND_CATEGORIES.includes(value as QuickCommandCategory)
}

function isEntry(value: unknown): value is QuickCommandEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== 'string' || !entry.id) return false
  if (typeof entry.command !== 'string' || !entry.command.trim()) return false
  if (entry.command.length > QUICK_COMMAND_TEXT_MAX) return false
  if (typeof entry.titleKey !== 'string' && typeof entry.title !== 'string') return false
  if (typeof entry.title === 'string' && entry.title.length > QUICK_COMMAND_TITLE_MAX) return false
  return isCategory(entry.category)
}

export function parseQuickCommands(raw: string | null | undefined): QuickCommandEntry[] {
  if (!raw) return cloneDefaults()
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return cloneDefaults()
    const seen = new Set<string>()
    const items: QuickCommandEntry[] = []
    for (const candidate of parsed) {
      if (!isEntry(candidate) || seen.has(candidate.id)) continue
      seen.add(candidate.id)
      items.push({
        id: candidate.id,
        ...(candidate.titleKey ? { titleKey: candidate.titleKey } : {}),
        ...(candidate.title ? { title: candidate.title.slice(0, QUICK_COMMAND_TITLE_MAX) } : {}),
        command: candidate.command.slice(0, QUICK_COMMAND_TEXT_MAX),
        category: candidate.category,
        favorite: Boolean(candidate.favorite),
      })
    }
    return items
  } catch {
    return cloneDefaults()
  }
}

export function loadQuickCommands(): QuickCommandEntry[] {
  if (typeof localStorage === 'undefined') return cloneDefaults()
  return parseQuickCommands(localStorage.getItem(QUICK_COMMANDS_STORAGE_KEY))
}

export function saveQuickCommands(items: readonly QuickCommandEntry[]): void {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(QUICK_COMMANDS_STORAGE_KEY, JSON.stringify(items))
}

export function newQuickCommandId(): string {
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : undefined
  if (cryptoApi?.randomUUID) return `command-${cryptoApi.randomUUID()}`
  return `command-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function quickCommandTitle(entry: QuickCommandEntry, translate: (key: MessageKey) => string): string {
  if (entry.title) return entry.title
  return entry.titleKey ? translate(entry.titleKey) : entry.command
}

/** The line the caret is on, which is what "send the current line" hands to the shell. */
export function currentLineAt(text: string, caret: number): string {
  const start = text.lastIndexOf('\n', Math.max(0, caret - 1)) + 1
  const end = text.indexOf('\n', caret)
  return text.slice(start, end < 0 ? text.length : end)
}

/**
 * A bare Enter in the command editor has to stay a newline, and the composition guard is asked before
 * the shortcut so an IME candidate is never submitted as "run every line".
 */
export function isCommandSendShortcut(event: ReactKeyboardEvent): boolean {
  if (isImeComposing(event)) return false
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey
}
