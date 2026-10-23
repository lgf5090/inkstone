/**
 * The reader's own chords for their own templates: press a key, run that template, no palette.
 *
 * Upstream's `enabled_templates_hotkeys` does not store a key. It stores which *commands* a template is
 * worth registering — `CommandHandler.add_template_hotkey` registers `Insert <name>` when
 * `insert_enabled` and `Create <name>` when `create_enabled` (upstream
 * `src/handlers/CommandHandler.ts:90` and `:106`) — and Obsidian's hotkey manager then lets the reader bind
 * each of those two commands to a chord of its own. So one row with both flags is *two independently
 * bound chords*, never one key that does two things. This app keeps the row's flags but stores the chord
 * on the row (`src/shared/types.ts`'s `TemplaterHotkey`), because the settings screen needs one editable
 * field per row; that makes the two halves fight for one chord. They are mirrored faithfully and the
 * fight is not hidden: insert is claimed first (the same order upstream registers them in), and the half
 * that lost the chord comes back as a conflict record a panel can render.
 *
 * Two things this deliberately does not do:
 *
 * - It does not invent a chord format. A combo is the app's own vocabulary — `mod+shift+p`, parsed by
 *   `lib/hotkeys.ts`'s `matches()` — normalised exactly the way the QuickAdd choice editor normalises one
 *   (`trim()`, then `toLowerCase()`, empty stored as `null`), and the bindings go into the one global
 *   registry (`register`/`registerAll`) that already dispatches every chord in the app. There is no second
 *   key listener here, because a second listener is a second priority order.
 * - It does not speak. Conflicts and stale rows come back as data. Words belong to the settings screen
 *   that draws them; a toast from inside a binding effect would fire on every settings keystroke.
 *
 * The runs themselves are `run-shell.ts`, pulled in with a dynamic import on press so a reader who never
 * touches Templater does not load the parser, `yaml` and the sandbox on the first screen (plan P11-5).
 */
import { useEffect, useMemo } from 'react'
import type { MessageKey } from '@shared/locales/en-US'
import type { NoteTemplate, TemplaterHotkey } from '@shared/types'
import type { CreateDestination } from './run-shell'
import { IS_MAC, listHotkeys, registerAll, type Hotkey } from '../../lib/hotkeys'
import { APP_SHORTCUTS, NOTE_LIST_SHORTCUTS } from '../../lib/shortcuts'
import { CHAT_SHORTCUTS } from '../chat/chat-shortcuts'
import { t } from '../../lib/i18n'
import { templaterErrorText } from '../../lib/templater/errors'
import { useNotes } from '../../store/notes'
import { useNoteTemplates } from '../../store/note-templates'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'

/** Which of the two runs a chord stands for. */
export type TemplaterHotkeyAction = 'insert' | 'create'

/**
 * What kind of claimant already holds the chord a row wanted.
 *
 * `editor` is the one claimant the runtime does not ask: the keymap it describes lives in the editor's own
 * chunk, and a template chord registered over it wins. The panel is the only place that reads that list, so
 * it is the only place that can say "you are taking this from the editor" rather than "you cannot have it".
 */
export type TemplaterHotkeyClaimant = 'templater' | 'quickadd' | 'app' | 'editor'

/**
 * One chord a reader asked for that could not be bound, or that was bound over somebody else's head.
 *
 * `combo` is what the reader wrote (lower-cased for display), `owner` names the claimant so a panel can
 * say *which* key is already taken by what.
 */
export interface TemplaterHotkeyConflict {
  combo: string
  templateId: string
  templateName: string
  action: TemplaterHotkeyAction
  takenBy: TemplaterHotkeyClaimant
  owner: string
}

/** Everything the settings screen has to say about the reader's chord list, as data. */
export interface TemplaterHotkeyReport {
  conflicts: TemplaterHotkeyConflict[]
  /**
   * Rows whose `templateId` is no longer in the library. They bind nothing — the template is gone, and a
   * chord that silently stopped working is the answer that sends a reader through every note they own, so
   * the count is handed to the panel the same way `startup-bridge.ts` reports missing startup templates.
   */
  stale: string[]
}

/** A chord somebody already holds, before Templater's own rows are weighed against it. */
export interface TemplaterChordClaim {
  combo: string
  takenBy: Exclude<TemplaterHotkeyClaimant, 'templater'>
  owner: string
}

/** The ids this feature puts in the global registry, and the prefix that recognises them again. */
const OWNED_PREFIX = 'templater:'
const QUICKADD_PREFIX = 'quickadd:'

/** The two words the shortcut overview shows, one per action, beside the template's own name. */
const ACTION_LABEL: Record<TemplaterHotkeyAction, MessageKey> = {
  insert: 'templater.cmd.insert',
  create: 'templater.cmd.create',
}

/** The order a row's two halves are claimed in — upstream registers insert before create. */
const ACTIONS: readonly TemplaterHotkeyAction[] = ['insert', 'create']

/**
 * A combo as the reader wrote it, or `''` when there is nothing to bind.
 *
 * `''` is the app's one spelling of "no chord" (QuickAdd's choice editor stores `null` for it), so an
 * absent, blank or over-long value all land on it. The length ceiling is the shared setting's job
 * (`LIMITS.templaterComboMaxLength`, applied by `mergeSettings`); this only trims and lower-cases, so a
 * hand-typed `Ctrl+Shift+P` reads as the `ctrl+shift+p` the rest of the app already answers to.
 */
export function normaliseTemplaterCombo(combo: string | null | undefined): string {
  return typeof combo === 'string' ? combo.trim().toLowerCase() : ''
}

/**
 * The keystroke a combo actually asks for, as one string.
 *
 * Two combos are the same chord whenever `matches()` would accept the same event for both, and that is
 * not string equality: the matcher reads the last segment as the key and every other segment as a
 * modifier, so `mod+shift+p` and `shift+mod+p` are one chord, and off a Mac `mod` *is* `ctrl` while
 * `cmd` *is* `meta`. A settings field is typed by hand, so those spellings arrive; comparing the raw
 * strings would let a reader bind a second `Insert` onto the palette's own key and call it a fresh one.
 */
export function templaterComboFingerprint(combo: string): string {
  const parts = combo.toLowerCase().split('+')
  // The last segment is the key and everything before it is a modifier, which is exactly how `matches()`
  // reads a combo — so a trailing `+` (`mod+`) has no key, asks for nothing, and fingerprints to nothing.
  const key = parts[parts.length - 1] ?? ''
  if (key === '') return ''
  const held = parts.slice(0, -1)
  const modifiers = new Set<string>()
  if (held.includes('shift')) modifiers.add('shift')
  if (held.includes('alt')) modifiers.add('alt')
  if (held.includes('ctrl') || (held.includes('mod') && !IS_MAC)) modifiers.add('ctrl')
  if (held.includes('meta') || held.includes('cmd') || (held.includes('mod') && IS_MAC)) modifiers.add('meta')
  const keyName = key === 'esc' ? 'escape' : key
  return modifiers.size === 0 ? keyName : `${[...modifiers].sort().join('+')}+${keyName}`
}

/**
 * Every chord the app already answers to, as one flat list.
 *
 * The live registry first, because that is the only dispatcher that runs at window level: it holds the
 * shell's keys, the projector's, and the QuickAdd bridge's choices, so a chord in it is one a template
 * would genuinely be bound over. Templater's own entries are left out — the plan below weighs its rows
 * against each other itself, and reading its own live bindings back would report yesterday's list as a
 * conflict on today's edit.
 *
 * Then the hardcoded tables, for the chords an app owns before any component has mounted to register
 * them. `APP_SHORTCUTS` and `NOTE_LIST_SHORTCUTS` come from `lib/shortcuts.ts` and `CHAT_SHORTCUTS` from
 * the chat's own table, both of which are already in the first-screen chunk. The editor's keymap is
 * deliberately *not* listed here: `editor/shortcuts.ts` drags the editor command graph into the entry
 * chunk, and the settings screen that validates a combo (plan P6-3/P10-2) is lazily loaded and can afford
 * to read it. That is the known gap: four editor-scoped palette chords (`mod+shift+arrowup` and friends)
 * are not reported by this list.
 */
export function templaterChordClaims(): TemplaterChordClaim[] {
  const claims: TemplaterChordClaim[] = []
  for (const hotkey of listHotkeys()) {
    if (hotkey.id.startsWith(OWNED_PREFIX)) continue
    const combo = normaliseTemplaterCombo(hotkey.combo)
    if (combo === '') continue
    claims.push({
      combo,
      takenBy: hotkey.id.startsWith(QUICKADD_PREFIX) ? 'quickadd' : 'app',
      owner: hotkey.id,
    })
  }
  for (const [name, combo] of Object.entries(APP_SHORTCUTS)) {
    claims.push({ combo, takenBy: 'app', owner: `shortcut:${name}` })
  }
  for (const [name, combo] of Object.entries(NOTE_LIST_SHORTCUTS)) {
    claims.push({ combo, takenBy: 'app', owner: `note-list:${name}` })
  }
  for (const [name, combo] of Object.entries(CHAT_SHORTCUTS)) {
    claims.push({ combo, takenBy: 'app', owner: `chat:${name}` })
  }
  return claims
}

/** One registry entry: the chord, the words, and the run it starts. */
function templaterHotkey(combo: string, template: NoteTemplate, action: TemplaterHotkeyAction): Hotkey {
  return {
    id: `${OWNED_PREFIX}${template.id}:${action}`,
    combo,
    description: () => `${t(ACTION_LABEL[action])} — ${template.name}`,
    group: () => t('templater.group'),
    // A reader is almost always writing a note when they reach for a template, so a real chord has to get
    // past the caret. A bare key does not: pressed while typing, it would eat the letter the note was
    // supposed to gain, so it answers only when the caret is elsewhere. An open dialog owns the keyboard in
    // both cases, and never gets a note rewritten under it.
    allowInInput: templaterComboFingerprint(combo).includes('+'),
    handler: () => {
      void runTemplaterChord(template, action)
    },
  }
}

/**
 * Start the run the chord stands for, and say so when it could not be started.
 *
 * The half that does the work is `run-shell.ts`, and it reports its own refusals — no note, no editor, a
 * rejected write — so nothing is added here. What is left is the case the run never got to: the chunk that
 * holds it could not be fetched. That gets the app's own error sentence rather than silence, and the
 * original text beside it, which is how `run-shell.ts` reports a port that threw.
 */
async function runTemplaterChord(template: NoteTemplate, action: TemplaterHotkeyAction): Promise<void> {
  try {
    const shell = await import('./run-shell')
    if (action === 'insert') await shell.insertTemplateIntoActiveNote(template)
    else await shell.createNoteFromTemplate(template, chordCreateDestination())
  }
  catch (error) {
    console.error('[templater] the template behind this chord could not be started', error)
    useUi.getState().toast({ title: templaterErrorText(error, t), tone: 'danger' })
  }
}

/**
 * Where a chord's new note goes when the reader did not say.
 *
 * The chooser's own rule (`template-picker.tsx`'s `defaultFolderId`, plus an empty title meaning the
 * template's name): the folder of the note they are looking at, else the folder they are browsing, else
 * the top of the tree. A chord carries no form, so this is the whole answer, and it has to be the same
 * answer as the picker's or the same template lands in two places depending on how it was reached.
 */
function chordCreateDestination(): CreateDestination {
  const ui = useUi.getState()
  const active = ui.activeNoteId ? useNotes.getState().notes[ui.activeNoteId] : null
  return { folderId: active?.folderId ?? ui.folderId ?? null, title: '' }
}

/**
 * The reader's chord rows, worked out against the chords that are already held.
 *
 * Rows are walked in the order the settings screen shows them, and each row's two halves in the order
 * upstream registers them, so the first claim wins and everything after it is reported instead of bound —
 * the same rule the QuickAdd bridge applies to two choices that share a shortcut, except that the loser
 * here is written down rather than dropped. A row whose template has left the library binds nothing;
 * guessing which template the reader meant would be a worse morning than a key that does nothing.
 */
export function planTemplaterHotkeys(
  rows: readonly TemplaterHotkey[],
  templates: readonly NoteTemplate[],
  claims: readonly TemplaterChordClaim[],
): { bindings: Hotkey[]; report: TemplaterHotkeyReport } {
  const held = new Map<string, { takenBy: TemplaterHotkeyClaimant; owner: string }>()
  for (const claim of claims) {
    const combo = normaliseTemplaterCombo(claim.combo)
    const key = templaterComboFingerprint(combo)
    if (key === '' || held.has(key)) continue
    held.set(key, { takenBy: claim.takenBy, owner: claim.owner })
  }

  const bindings: Hotkey[] = []
  const conflicts: TemplaterHotkeyConflict[] = []
  const stale: string[] = []
  const library = new Map(templates.map((template) => [template.id, template]))
  const seen = new Set<string>()

  for (const row of rows) {
    const combo = normaliseTemplaterCombo(row.combo)
    const key = templaterComboFingerprint(combo)
    // A combo with no key part (`mod+`) is a chord no keystroke can ever produce, and an empty one is the
    // reader's own "not yet" state: neither is worth a conflict entry, because nobody holds them.
    if (key === '') continue
    // One template, one chord — the shape the stored setting is already cleaned to, kept here so a caller
    // that handed over two rows for one template could not get two bindings out of it.
    if (seen.has(row.templateId)) continue
    const template = library.get(row.templateId)
    if (template === undefined) {
      stale.push(row.templateId)
      continue
    }
    seen.add(row.templateId)
    for (const action of ACTIONS) {
      if (row[action] !== true) continue
      const holder = held.get(key)
      if (holder) {
        conflicts.push({
          combo,
          templateId: row.templateId,
          templateName: template.name,
          action,
          takenBy: holder.takenBy,
          owner: holder.owner,
        })
        continue
      }
      held.set(key, { takenBy: 'templater', owner: `${OWNED_PREFIX}${template.id}:${action}` })
      bindings.push(templaterHotkey(combo, template, action))
    }
  }

  return { bindings, report: { conflicts, stale } }
}

/**
 * Bind the reader's template chords, and re-bind them when they change.
 *
 * Both inputs are store reads, so a chord that is edited takes effect on the render that follows the save
 * and a row that is deleted stops answering on its cleanup — no reload, and no stale binding left in the
 * registry. Nothing is bound until the library has been read, because a template that has not arrived yet
 * looks exactly like one that was deleted; the effect re-runs when the rows land.
 *
 * So the library is asked for here, the same way `bridge.ts` asks for the QuickAdd one: a chord the reader
 * set in the settings screen has to work the next time they open the app, not only after they happen to
 * have visited the gallery or opened the chooser. `hydrate` answers from what the account already has, so
 * this cannot read the library twice.
 */
export function useTemplaterHotkeys(): void {
  const owner = useSession((state) => state.user?.id ?? '')
  const rows = useSession((state) => state.settings.templater.templateHotkeys)
  const templates = useNoteTemplates((state) => state.templates)
  const hydrate = useNoteTemplates((state) => state.hydrate)

  useEffect(() => {
    if (!owner) return
    void hydrate(owner).catch((error) => {
      console.warn('[templater] the template chords could not be checked against the library', error)
    })
  }, [owner, hydrate])

  useEffect(() => {
    const { bindings } = planTemplaterHotkeys(rows, templates, templaterChordClaims())
    return registerAll(bindings)
  }, [rows, templates])
}

/**
 * What is wrong with the reader's chord list, for the screen that edits it.
 *
 * It runs the same planner the bindings come from, so the panel cannot disagree with the keyboard about
 * which chord is contested. The claims are read from the live registry as the component renders: a chord
 * taken by something that mounts later (the QuickAdd library, say) is refreshed by the next render of this
 * screen, which is the one the reader is in while they are choosing a key.
 *
 * A row whose template is missing is only reported once the library has actually been read. Before that a
 * template has simply not arrived yet, and calling every chord row broken while the notebook loads is a
 * worse answer than saying nothing about it.
 */
export function useTemplaterHotkeyReport(): TemplaterHotkeyReport {
  const rows = useSession((state) => state.settings.templater.templateHotkeys)
  const templates = useNoteTemplates((state) => state.templates)
  const libraryRead = useNoteTemplates((state) => state.hydrated)
  return useMemo(() => {
    const report = planTemplaterHotkeys(rows, templates, templaterChordClaims()).report
    return libraryRead ? report : { conflicts: report.conflicts, stale: [] }
  }, [libraryRead, rows, templates])
}
