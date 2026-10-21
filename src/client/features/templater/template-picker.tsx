/**
 * The Templater chooser: pick one of the reader's own templates and say what to do with it.
 *
 * It is the surface Templater's `Ctrl+T` / `Ctrl+Alt+N` modals are, and it is built out of the pieces this
 * app already uses for exactly that job — the QuickAdd launcher's searchable list
 * (`features/quickadd/launcher.tsx`), `Modal` for the frame and its focus contract, `FilterInput` for the
 * shared box semantics, `Segmented` for the mode (a radio group, not two buttons that look selected), and
 * `FolderPicker` for the destination, because a folder chooser already exists and a second one would be a
 * second set of keys to learn. What the chooser deliberately does not do is run anything: choosing pulls
 * `run-shell.ts` on demand, so opening this list never parses a template or starts the sandbox.
 *
 * Two modes are offered as a choice the reader can still change, and the third surface — replace this note
 * — is not: it arrives from a command that already named it, and a switch that quietly turned "replace"
 * into "insert" would be the worse kind of surprise.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { FolderClosed, LayoutTemplate } from 'lucide-react'
import type { NoteTemplate } from '@shared/types'
import type { MessageKey } from '@shared/locales/en-US'
import { LIMITS } from '@shared/constants'
import { cn } from '../../lib/cn'
import { compileQuery, queryKeeps } from '../../lib/query-match'
import { folderPathLabel } from '../../lib/folders'
import { usePinyinVersion } from '../../lib/pinyin'
import { isImeComposing } from '../../lib/ime'
import { Modal } from '../../components/overlay'
import { Button } from '../../components/primitives'
import { Field, Input, Segmented } from '../../components/form'
import { FilterInput } from '../../components/FilterInput'
import { t } from '../../lib/i18n'
import { useNotes } from '../../store/notes'
import { compareTemplates, useNoteTemplates } from '../../store/note-templates'
import { useSession } from '../../store/session'
import { useUi } from '../../store/ui'
import { FolderPicker } from '../folders/FolderPicker'
import {
  attachTemplaterPickerHost,
  closeTemplaterPicker,
  peekTemplaterPicker,
  subscribeTemplaterPicker,
  type TemplaterPickerMode,
} from './picker-request'

type ChosenMode = 'insert' | 'create'

const MODE_LABEL_KEY = {
  insert: 'templates.insert_into_note',
  create: 'templates.new_note_from_template',
} as const satisfies Record<ChosenMode, MessageKey>

const HINT_KEY = {
  insert: 'templater.picker.hint_insert',
  create: 'templater.picker.hint_create',
  replace: 'templater.picker.hint_replace',
} as const satisfies Record<TemplaterPickerMode, MessageKey>

/**
 * The chooser's mount point.
 *
 * It is a component rather than an imperative call because a dialog has to be in the React tree to keep the
 * app's one focus stack, and it is hosted by the template gallery today because that is the surface already
 * mounted for anything called "template" — `openTemplaterPicker` brings the gallery up when the reader came
 * from somewhere else.
 */
export function TemplaterPickerHost() {
  useEffect(attachTemplaterPickerHost, [])
  const request = useSyncExternalStore(subscribeTemplaterPicker, peekTemplaterPicker)
  if (!request) return null
  return <TemplatePicker key={request.mode} mode={request.mode} onClose={closeTemplaterPicker}/>
}

export function TemplatePicker({ mode, onClose }: { mode: TemplaterPickerMode; onClose: () => void }) {
  const owner = useSession((state) => state.user?.id ?? '')
  const templates = useNoteTemplates((state) => state.templates)
  const categories = useNoteTemplates((state) => state.categories)
  const hydrate = useNoteTemplates((state) => state.hydrate)
  const folders = useNotes((state) => state.folders)
  const [chosen, setChosen] = useState<ChosenMode>(mode === 'create' ? 'create' : 'insert')
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [folderId, setFolderId] = useState<string | null>(() => defaultFolderId())
  const [title, setTitle] = useState('')
  const [folderOpen, setFolderOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const rowId = useCallback((index: number) => `${listId}-row-${index}`, [listId])
  const pinyinVersion = usePinyinVersion()

  // The chooser is often the first thing to reach the library in a session, and an empty list is a lie when
  // the rows are simply not read yet. `hydrate` answers from what it already has for an account that is
  // loaded, so the gallery's own read and this one cannot produce two copies.
  useEffect(() => {
    if (!owner) return
    void hydrate(owner).catch((error) => {
      console.warn('[templater] the template library could not be read for the chooser', error)
    })
  }, [owner, hydrate])

  const compiled = useMemo(() => compileQuery(query), [query, pinyinVersion])
  const categoryNames = useMemo(() => new Map(categories.map((category) => [category.id, category.name])), [categories])
  const rows = useMemo(() => {
    // A name is what the reader types, but the plan asks that a category or a tag answer too: a library of
    // forty "Untitled" captures is found by what it is filed under.
    const subject = (template: NoteTemplate): string => [
      template.name,
      template.categoryId === null ? '' : categoryNames.get(template.categoryId) ?? '',
      ...template.tags,
    ].filter(Boolean).join(' ')
    return templates.filter((template) => queryKeeps(compiled, subject(template))).sort(compareTemplates)
  }, [categoryNames, compiled, templates])

  useEffect(() => {
    setCursor((current) => (rows.length === 0 ? 0 : Math.min(current, rows.length - 1)))
  }, [rows.length])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const choose = useCallback(async (template: NoteTemplate) => {
    if (running) return
    setRunning(true)
    const { confirmReplace, createNoteFromTemplate, insertTemplateIntoActiveNote, replaceActiveNoteWithTemplate } = await import('./run-shell')
    let written = false
    try {
      if (mode === 'replace') written = await confirmReplace(template) && await replaceActiveNoteWithTemplate(template)
      else if (chosen === 'create') written = await createNoteFromTemplate(template, { folderId, title })
      else written = await insertTemplateIntoActiveNote(template)
    }
    finally {
      setRunning(false)
    }
    // A run that refused stays open: the reader can pick another template without pressing the key again.
    if (written) onClose()
  }, [chosen, folderId, mode, onClose, running, title])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setCursor((current) => (rows.length === 0 ? 0 : (current + step + rows.length) % rows.length))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setCursor(event.key === 'Home' ? 0 : Math.max(0, rows.length - 1))
      return
    }
    if (event.key === 'Enter') {
      const template = rows[cursor]
      if (!template) return
      event.preventDefault()
      void choose(template)
    }
  }, [choose, cursor, rows])

  return (
    <>
      <Modal
        open
        onClose={onClose}
        dismissible={!running}
        title={t('templater.picker.title')}
        description={t(HINT_KEY[mode])}
        width={560}
      >
        <div className="space-y-2 pb-1">
          {mode === 'replace'
            ? <p className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('templater.cmd.replace')}</p>
            : (
                <Segmented
                  size="sm"
                  label={t('templater.picker.mode_label')}
                  value={chosen}
                  onChange={setChosen}
                  options={(Object.keys(MODE_LABEL_KEY) as ChosenMode[]).map((value) => ({ value, label: t(MODE_LABEL_KEY[value]) }))}
                />
              )}
          <FilterInput
            data-autofocus
            value={query}
            onChange={setQuery}
            query={compiled}
            label={t('templates.search_templates')}
            placeholder={t('templates.search_templates')}
            size="panel"
            escapeWhenEmpty="release"
            onKeyDown={onKeyDown}
            aria-controls={listId}
            aria-activedescendant={rows.length > 0 ? rowId(Math.min(cursor, rows.length - 1)) : undefined}
          />
          {chosen === 'create' && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label={t('templater.picker.note_name')} className="min-w-0 flex-1">
                <Input
                  value={title}
                  maxLength={LIMITS.titleMaxLength}
                  placeholder={t('templater.picker.name_placeholder')}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </Field>
              <Button
                variant="ghost"
                size="sm"
                icon={<FolderClosed size={13}/>}
                aria-haspopup="dialog"
                onClick={() => setFolderOpen(true)}
              >
                {folderPathLabel(folders, folderId) || t('folders.top_level')}
              </Button>
            </div>
          )}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={t('templates.all_templates')}
            className="max-h-[46vh] overflow-y-auto rounded-[var(--r-md)] border border-[var(--border-subtle)]"
          >
            {rows.length === 0 && templates.length === 0 && (
              <div className="px-3 py-6 text-center">
                <p className="text-[length:var(--text-12)] text-[var(--text-quaternary)]">{t('templates.no_templates')}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-3"
                  icon={<LayoutTemplate size={13}/>}
                  onClick={() => {
                    // Closed first, then opened: the chooser's own teardown puts the gallery back down when
                    // the command raised it, and that has to happen before this request to keep it up.
                    onClose()
                    useUi.getState().openPanel('templates')
                  }}
                >
                  {t('templates.open_template_library')}
                </Button>
              </div>
            )}
            {rows.length === 0 && templates.length > 0 && (
              <p className="px-3 py-6 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
                {t('templates.no_matching_templates')}
              </p>
            )}
            {rows.map((template, index) => (
              <TemplateRow
                key={template.id}
                template={template}
                index={index}
                id={rowId(index)}
                active={index === cursor}
                disabled={running}
                detail={template.categoryId === null ? template.description : categoryNames.get(template.categoryId) ?? template.description}
                onHover={() => setCursor(index)}
                onChoose={() => void choose(template)}
              />
            ))}
          </div>
          {running && <p role="status" className="text-[length:var(--text-11-5)] text-[var(--text-tertiary)]">{t('common.loading')}</p>}
        </div>
      </Modal>
      {folderOpen && (
        <FolderPicker
          open
          title={t('templater.picker.folder_label')}
          folders={folders}
          currentId={folderId}
          onSelect={setFolderId}
          onClose={() => setFolderOpen(false)}
        />
      )}
    </>
  )
}

/** Where a new note goes when the reader has not said: the folder they are in, else the top level. */
function defaultFolderId(): string | null {
  const ui = useUi.getState()
  const active = ui.activeNoteId ? useNotes.getState().notes[ui.activeNoteId] : null
  return active?.folderId ?? ui.folderId ?? null
}

function TemplateRow({ template, index, id, active, disabled, detail, onHover, onChoose }: {
  template: NoteTemplate
  index: number
  id: string
  active: boolean
  disabled: boolean
  detail: string
  onHover: () => void
  onChoose: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      id={id}
      aria-selected={active}
      disabled={disabled}
      data-row-index={index}
      onMouseEnter={onHover}
      onClick={onChoose}
      className={cn(
        'flex w-full min-h-11 items-center gap-2.5 border-b border-[var(--border-subtle)] px-2.5 py-2 text-left transition-colors last:border-b-0',
        'disabled:pointer-events-none disabled:opacity-40',
        active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
      )}
    >
      <span className={cn('shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)]')}>
        <LayoutTemplate size={14}/>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--text-12-5)] text-[var(--text-primary)]">{template.name}</span>
        {detail && <span className="mt-0.5 block truncate text-[length:var(--text-11)] text-[var(--text-quaternary)]">{detail}</span>}
      </span>
    </button>
  )
}
