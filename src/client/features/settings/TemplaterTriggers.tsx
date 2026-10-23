/**
 * Settings → Templater: the lists that decide which template runs unasked.
 *
 * Every row here is a pair of references — a folder and a template, a pattern and a template — and the shared
 * normaliser (`@shared/constants` `normalizeTemplaterSettings`) is what finally decides whether a row survives,
 * because it is the one place the server, the worker, and this screen agree. The panel therefore writes a whole
 * list on every edit instead of repairing rows locally: a half-valid row is dropped by that normaliser, and a
 * control that kept what the store threw away would be the worst kind of lie on this screen.
 *
 * The root folder is a choice, not a missing half — a rule filed at the root fires on every new note — so it is
 * drawn as its own labelled option rather than an empty box.
 */
import { useEffect, useMemo, useState } from 'react'
import { FolderClosed, Plus, Trash2 } from 'lucide-react'
import type { Folder, NoteTemplate, TemplaterSettings } from '@shared/types'
import { LIMITS } from '@shared/constants'
import { Button, IconButton } from '../../components/primitives'
import { Field, Input, Select, SettingRow } from '../../components/form'
import { t } from '../../lib/i18n'
import { folderPathLabel } from '../../lib/folders'
import { compareTemplates, useNoteTemplates } from '../../store/note-templates'
import { useNotes } from '../../store/notes'
import { useSession } from '../../store/session'

/** The library as the three reference lists want it: every template, in the order the gallery uses. */
export function useTemplaterLibrary(): { templates: NoteTemplate[], read: boolean } {
  const templates = useNoteTemplates((state) => state.templates)
  const read = useNoteTemplates((state) => state.hydrated)
  const owner = useSession((state) => state.user?.id ?? '')
  const hydrate = useNoteTemplates((state) => state.hydrate)
  useEffect(() => {
    if (!owner || read) return
    // Logged, not swallowed — the same way the other three mounts that hydrate this library say so.
    void hydrate(owner).catch((error: unknown) => {
      console.warn('[templater] the settings lists could not hydrate the library', error)
    })
  }, [owner, read, hydrate])
  return { templates: useMemo(() => [...templates].sort(compareTemplates), [templates]), read }
}

/** Folders in the order a reader scans them: by path, root-first. */
function useSortedFolders(): Folder[] {
  const folders = useNotes((state) => state.folders)
  return useMemo(() => [...folders].sort((a, b) =>
    folderPathLabel(folders, a.id).localeCompare(folderPathLabel(folders, b.id))), [folders])
}

export function TemplaterTriggers({
  templater,
  update,
}: {
  templater: TemplaterSettings
  update: (patch: Partial<TemplaterSettings>) => void
}) {
  const { templates, read } = useTemplaterLibrary()
  const folders = useSortedFolders()
  const rules = { templates, read, folders }

  // Only the list the chosen mode actually consults is drawn: a folder rule cannot fire while the mode says
  // "by pattern", and showing both asks the reader to keep that distinction in their head. The other list's
  // rows stay in the settings blob, so switching back restores them.
  return (
    <>
      {templater.fileCreationMode === 'folder' && <FolderRules templater={templater} update={update} {...rules}/>}
      {templater.fileCreationMode === 'regex' && <PatternRules templater={templater} update={update} {...rules}/>}
      <IgnoredFolders templater={templater} update={update} folders={folders}/>
    </>
  )
}

/** The folder rule list: which folder, which template, and the row's own delete. */
function FolderRules({
  templater,
  update,
  folders,
  templates,
  read,
}: {
  templater: TemplaterSettings
  update: (patch: Partial<TemplaterSettings>) => void
  folders: Folder[]
  templates: NoteTemplate[]
  read: boolean
}) {
  const rows = templater.folderTemplates
  // The row's title stays a literal `t(...)` even though the group's label below reuses the same words: the
  // search index's anchor check reads literals out of this directory's source, and a title passed in as a
  // variable is a setting the reader can search for and then not be jumped to.
  return (
    <>
      <SettingRow
        title={t('settings.templater_folder_triggers')}
        description={<Hint text={t('settings.templater_folder_triggers_desc')} count={rows.length} max={LIMITS.templaterFolderTriggersMax}/>}
        className="border-t-0">
        <AddTrigger
          disabled={rows.length >= LIMITS.templaterFolderTriggersMax}
          onAdd={() => update({
            folderTemplates: [...rows, { folderId: folders[0]?.id ?? null, templateId: templates[0]?.id ?? '' }],
          })}/>
      </SettingRow>
      {rows.map((row, index) => (
        <div
          key={`${row.templateId}:${index}`}
          role="group"
          aria-label={t('settings.templater_folder_triggers')}
          className="mb-2 grid gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <FolderField
            folders={folders}
            value={row.folderId}
            onChange={(folderId) => update({
              folderTemplates: rows.map((entry, at) => (at === index ? { ...entry, folderId } : entry)),
            })}/>
          <TemplateField
            templates={templates}
            libraryRead={read}
            value={row.templateId}
            onChange={(templateId) => update({
              folderTemplates: rows.map((entry, at) => (at === index ? { ...entry, templateId } : entry)),
            })}/>
          <DeleteRow onDelete={() => update({ folderTemplates: rows.filter((_, at) => at !== index) })}/>
        </div>
      ))}
    </>
  )
}

/** The pattern rule list: a path pattern, a template, and the row's own delete. */
function PatternRules({
  templater,
  update,
  templates,
  read,
}: {
  templater: TemplaterSettings
  update: (patch: Partial<TemplaterSettings>) => void
  folders: Folder[]
  templates: NoteTemplate[]
  read: boolean
}) {
  const rows = templater.fileTemplates
  return (
    <>
      <SettingRow
        title={t('settings.templater_regex_triggers')}
        description={<Hint text={t('settings.templater_regex_triggers_desc')} count={rows.length} max={LIMITS.templaterFileTriggersMax}/>}
        className="border-t-0">
        <AddTrigger
          disabled={rows.length >= LIMITS.templaterFileTriggersMax}
          onAdd={() => update({
            fileTemplates: [...rows, { regex: '^Journal/', templateId: templates[0]?.id ?? '' }],
          })}/>
      </SettingRow>
      {rows.map((row, index) => (
        <div
          key={`${row.templateId}:${index}`}
          role="group"
          aria-label={t('settings.templater_regex_triggers')}
          className="mb-2 grid gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
          <RegexField
            value={row.regex}
            onChange={(regex) => update({
              fileTemplates: rows.map((entry, at) => (at === index ? { ...entry, regex } : entry)),
            })}/>
          <TemplateField
            templates={templates}
            libraryRead={read}
            value={row.templateId}
            onChange={(templateId) => update({
              fileTemplates: rows.map((entry, at) => (at === index ? { ...entry, templateId } : entry)),
            })}/>
          <DeleteRow onDelete={() => update({ fileTemplates: rows.filter((_, at) => at !== index) })}/>
        </div>
      ))}
    </>
  )
}

function DeleteRow({ onDelete }: { onDelete: () => void }) {
  return (
    <IconButton label={t('common.delete')} size="sm" variant="danger" onClick={onDelete}>
      <Trash2 size={13}/>
    </IconButton>
  )
}

/** The add button doubles as the limit readout: disabled and counted, it says why it is disabled. */
function AddTrigger({ disabled, onAdd }: { disabled: boolean; onAdd: () => void }) {
  return (
    <Button size="sm" icon={<Plus size={13}/>} disabled={disabled} onClick={onAdd}>
      {t('templater.trigger.add')}
    </Button>
  )
}

function Hint({ text, count, max }: { text: string, count?: number, max?: number }) {
  return (
    <span className="block space-y-0.5">
      <span className="block">{text}</span>
      {count !== undefined && max !== undefined && (
        <span className="block text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">
          {t('templater.trigger.limit', { value0: String(count), value1: String(max) })}
        </span>
      )}
    </span>
  )
}

function FolderField({
  folders,
  value,
  onChange,
}: {
  folders: Folder[]
  value: string | null
  onChange: (folderId: string | null) => void
}) {
  const label = t('templater.trigger.folder')
  const gone = value !== null && !folders.some((folder) => folder.id === value)
  return (
    <Field label={label}>
      <Select aria-label={label} value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}>
        <option value="">{t('templater.trigger.root')}</option>
        {folders.map((folder) => (
          <option key={folder.id} value={folder.id}>{folderPathLabel(folders, folder.id)}</option>
        ))}
      </Select>
      {gone && <Gone text={t('templater.trigger.folder_gone')}/>}
    </Field>
  )
}

function TemplateField({
  templates,
  libraryRead,
  value,
  onChange,
}: {
  templates: NoteTemplate[]
  libraryRead: boolean
  value: string
  onChange: (templateId: string) => void
}) {
  const label = t('templater.trigger.template')
  // Before the library has been read a row simply has not arrived yet; saying "gone" then would be a lie
  // about a template the reader can see in the gallery one second later.
  const gone = value !== '' && libraryRead && !templates.some((template) => template.id === value)
  return (
    <Field label={label}>
      <Select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {templates.length === 0 && <option value="">{t('templater.trigger.no_library')}</option>}
        {templates.map((template) => (
          <option key={template.id} value={template.id}>{template.name}</option>
        ))}
      </Select>
      {gone && <Gone text={t('templater.trigger.template_gone')}/>}
    </Field>
  )
}

function Gone({ text }: { text: string }) {
  return <span className="mt-1 block text-[length:var(--text-11)] text-[var(--text-quaternary)]">{text}</span>
}

/**
 * The pattern box, with the one thing this screen can honestly say about it.
 *
 * The trigger test is `new RegExp(pattern)` on the path the index answers with, so an unusable pattern is not
 * a preference the app quietly ignores — it is a rule that never fires. The box says so under itself instead of
 * refusing the keystroke, because a reader is mid-word far more often than they are finished.
 */
function RegexField({ value, onChange }: { value: string; onChange: (regex: string) => void }) {
  const label = t('templater.trigger.regex')
  const broken = useMemo(() => {
    if (value.trim() === '') return false
    try {
      new RegExp(value)
      return false
    }
    catch {
      return true
    }
  }, [value])
  return (
    <Field label={label} hint={broken ? t('templater.trigger.regex_invalid') : undefined}>
      <Input
        aria-label={label}
        value={value}
        className="font-mono"
        spellCheck={false}
        maxLength={LIMITS.templaterRegexMaxLength}
        placeholder={t('templater.trigger.regex_placeholder')}
        onChange={(event) => onChange(event.target.value)}/>
    </Field>
  )
}

/** The folders whose new notes no trigger may touch, whatever the mode above them says. */
function IgnoredFolders({
  templater,
  update,
  folders,
}: {
  templater: TemplaterSettings
  update: (patch: Partial<TemplaterSettings>) => void
  folders: Folder[]
}) {
  const [pending, setPending] = useState('')
  const ignored = templater.ignoreFoldersOnCreation
  const available = folders.filter((folder) => !ignored.includes(folder.id))

  return (
    <SettingRow
      title={t('settings.templater_ignored_folders')}
      description={ignored.length === 0
        ? <Hint text={t('settings.templater_ignored_folders_desc')}/>
        : (
          <span className="block space-y-1.5">
            <span className="block">{t('settings.templater_ignored_folders_desc')}</span>
            <span role="group" aria-label={t('settings.templater_ignored_folders')} className="flex flex-wrap gap-1.5">
              {ignored.map((folderId) => {
                const path = folderPathLabel(folders, folderId)
                const known = folders.some((folder) => folder.id === folderId)
                return (
                  <span
                    key={folderId}
                    className="inline-flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] py-1 pr-1 pl-2 text-[length:var(--text-12)]">
                    <FolderClosed size={11} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]"/>
                    <span className="max-w-[16ch] truncate" title={path}>{known ? path : t('templater.trigger.folder_gone')}</span>
                    <IconButton
                      label={t('templater.ignored.remove')}
                      size="sm"
                      onClick={() => update({ ignoreFoldersOnCreation: ignored.filter((id) => id !== folderId) })}>
                      <Trash2 size={12}/>
                    </IconButton>
                  </span>
                )
              })}
            </span>
          </span>
        )}
      className="border-t-0">
      <span className="flex items-end gap-2">
        <Select
          aria-label={t('templater.ignored.add')}
          className="w-[170px] max-w-full"
          value={pending}
          onChange={(event) => setPending(event.target.value)}>
          <option value="">{t('templater.ignored.choose')}</option>
          {available.map((folder) => (
            <option key={folder.id} value={folder.id}>{folderPathLabel(folders, folder.id)}</option>
          ))}
        </Select>
        <Button
          size="sm"
          icon={<Plus size={13}/>}
          disabled={pending === '' || ignored.length >= LIMITS.templaterIgnoredFoldersMax}
          onClick={() => {
            if (pending === '') return
            update({ ignoreFoldersOnCreation: [...ignored, pending] })
            setPending('')
          }}>
          {t('templater.ignored.add')}
        </Button>
      </span>
    </SettingRow>
  )
}
