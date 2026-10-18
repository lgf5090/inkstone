/**
 * The data tab: importing and exporting the assistant's own records.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Download, FileText, Image, Trash2, Upload } from 'lucide-react'
import type { ChatAttachment } from '@shared/assistant'
import { MAX_BACKUP_BYTES } from '@shared/assistant'
import { formatBytes } from '@shared/byte-format'
import { t } from '../../lib/i18n'
import { api, ApiError } from '../../lib/api'
import { downloadTextFile } from '../../lib/export-note'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { SettingRow } from '../../components/form'
import { confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { useAssistant } from './assistant-store'
import { Group, LoadFailure } from './assistant-settings-shared'
import { formatInZone } from './time-format'
import { UsagePanel } from './AssistantUsagePanel'

const IMPORT_KEYS: Record<string, 'assistant.settings.import_conversations' | 'assistant.settings.import_messages' | 'assistant.settings.import_memories' | 'assistant.settings.import_tasks' | 'assistant.settings.import_projects' | 'assistant.settings.import_automations' | 'assistant.settings.import_notifications'> = {
  conversations: 'assistant.settings.import_conversations',
  messages: 'assistant.settings.import_messages',
  memories: 'assistant.settings.import_memories',
  tasks: 'assistant.settings.import_tasks',
  projects: 'assistant.settings.import_projects',
  automations: 'assistant.settings.import_automations',
  notifications: 'assistant.settings.import_notifications',
}

/**
 * How many files the list hands back.
 *
 * `GET /api/assistant/files` calls `store.listChatAttachments()` with its own default limit, so a reader
 * who has uploaded more than this is shown the newest files and nothing else — and the answer carries no
 * total to say how many were left out. The screen therefore states its own ceiling rather than letting a
 * list that stops read as a list that is empty.
 */
const FILE_LIST_LIMIT = 60

/**
 * The files a reader has uploaded into their chats.
 *
 * Every one of them is a stored object the reader pays for, and until now nothing in the interface could
 * name them: the uploads were only ever reachable from the turn that sent them, so a thread that was
 * deleted left its files behind with no trace. This is the list and the way out, on the tab the reader
 * already comes to for storage.
 *
 * A row carries no word about which conversation used it, so nothing here claims a file is unused — but the
 * route answers a delete with the number of turns it had to take the reference out of, and the toast says
 * that many rather than letting a quoted file read as a standalone one.
 */
export function ChatFileSpace() {
  const timezone = useAssistant((state) => state.settings?.timezone)
  const toast = useUi((state) => state.toast)
  const [files, setFiles] = useState<ChatAttachment[] | null>(null)
  // Kept apart from the list rather than derived from it: a refused read and an account with nothing in it
  // are two different facts, and the route's own reason travels with the first one only when it has one.
  const [failure, setFailure] = useState<{ detail: string | null } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  const load = useCallback(async () => {
    setFailure(null)
    try {
      setFiles((await api.assistant.chatFiles()).files)
    } catch (error) {
      // A refused list is not an empty one — the files are still stored, and saying so is the whole point.
      setFiles(null)
      setFailure({ detail: error instanceof ApiError ? error.serverMessage ?? null : null })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const remove = async (file: ChatAttachment) => {
    const label = t('assistant.settings.files_delete', { name: file.filename })
    if (!(await confirm({
      title: label,
      description: t('assistant.settings.files_delete_hint'),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    }))) return
    setRemoving(file.id)
    try {
      // The route answers with how many turns stopped naming this file when it was taken out of the
      // message rows. `api.assistant.deleteChatFile` still types only `{ deleted }`, so the answer is read
      // through the shape the route actually returns — a file that was quoted by four turns must not be
      // reported as one that belonged to nothing.
      const result: { deleted: boolean, referenced_by_turns?: number } = await api.assistant.deleteChatFile(file.id)
      const unlinked = Number.isFinite(result.referenced_by_turns) ? result.referenced_by_turns ?? 0 : 0
      setFiles((current) => (current ?? []).filter((entry) => entry.id !== file.id))
      toast({
        title: unlinked > 0
          ? t('assistant.settings.files_deleted_turns', { name: file.filename, count: unlinked })
          : t('assistant.settings.files_deleted', { name: file.filename }),
        tone: 'success',
      })
    } catch (error) {
      toast({
        title: t('assistant.toast.failed'),
        description: error instanceof ApiError ? error.serverMessage : undefined,
        tone: 'danger',
      })
    } finally {
      setRemoving(null)
    }
  }

  const total = (files ?? []).reduce((sum, file) => sum + file.size, 0)

  return (
    <Group title={t('assistant.settings.files')}>
      <div className="flex flex-col gap-1.5 py-2.5">
        <p className="text-[length:var(--text-11)] leading-snug text-[var(--text-quaternary)]">
          {t('assistant.settings.files_hint')}
        </p>

        {files === null && !failure && (
          <div role="status" aria-label={t('common.loading')} className="flex justify-center py-2">
            <Spinner />
          </div>
        )}

        {failure !== null && (
          <LoadFailure messageKey="assistant.settings.files_failed" detail={failure.detail} onRetry={() => void load()} />
        )}

        {files?.length === 0 && (
          <p className="py-1 text-[length:var(--text-11-5)] text-[var(--text-quaternary)]">
            {t('assistant.settings.files_empty')}
          </p>
        )}

        {files !== null && files.length > 0 && (
          <>
            <p className="text-[length:var(--text-11-5)] tabular-nums text-[var(--text-tertiary)]">
              {t('assistant.settings.files_summary', { count: files.length, size: formatBytes(total) })}
            </p>
            <ul aria-label={t('assistant.settings.files')} className="flex flex-col gap-1">
              {files.map((file) => {
                const label = t('assistant.settings.files_delete', { name: file.filename })
                return (
                  <li
                    key={file.id}
                    className="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-2 py-1.5"
                  >
                    {file.kind === 'image'
                      ? <Image size={13} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />
                      : <FileText size={13} className="shrink-0 text-[var(--text-quaternary)]" aria-hidden="true" />}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[length:var(--text-11-5)] text-[var(--text-secondary)]">{file.filename}</p>
                      <p className="truncate text-[length:var(--text-10-5)] tabular-nums text-[var(--text-quaternary)]">
                        {formatBytes(file.size)}
                        {' · '}
                        {formatInZone(file.createdAt, timezone)}
                      </p>
                    </div>
                    <IconButton
                      label={label}
                      size="xs"
                      aria-busy={removing === file.id}
                      disabled={removing !== null}
                      onClick={() => void remove(file)}
                    >
                      <Trash2 size={12} />
                    </IconButton>
                  </li>
                )
              })}
            </ul>
            {files.length >= FILE_LIST_LIMIT && (
              <p className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
                {t('assistant.settings.files_capped', { limit: FILE_LIST_LIMIT })}
              </p>
            )}
          </>
        )}
      </div>
    </Group>
  )
}

export function DataTab() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [file, setFile] = useState<File | null>(null)

  /**
   * The backup, downloaded by the page rather than followed as a link.
   *
   * A link cannot tell the reader how big the file it just handed them is, and size is the one thing that
   * decides whether the file can come back: the import reads a bounded request, so a backup past that
   * bound is a copy they would only find out about on the day they need it. The warning is a warning, not
   * a refusal — the data is theirs, and taking it is not something this screen gets to block.
   */
  const runExport = async () => {
    setExporting(true)
    try {
      const payload = await api.assistant.exportBackup()
      const text = JSON.stringify(payload, null, 2)
      const bytes = new TextEncoder().encode(text).byteLength
      downloadTextFile('inkstone-assistant-backup.json', text, 'application/json')
      useUi.getState().toast({
        title: t('assistant.settings.exported'),
        ...(bytes > MAX_BACKUP_BYTES
          ? {
              description: t('assistant.settings.export_too_large', { size: formatBytes(bytes), limit: formatBytes(MAX_BACKUP_BYTES) }),
              tone: 'warning' as const,
              duration: 12_000,
            }
          : {}),
      })
    } catch {
      useUi.getState().toast({ title: t('assistant.toast.failed'), tone: 'danger' })
    } finally {
      setExporting(false)
    }
  }

  /**
   * The summary is read back from the server rather than counted here, so the toast cannot claim a
   * merge that did not happen; the skipped notes are what an imported file was not allowed to change.
   */
  const runImport = async () => {
    if (!file) return
    setImporting(true)
    try {
      const payload = JSON.parse(await file.text())
      const result = await api.assistant.importBackup(payload)
      const counts = Object.entries(result.imported)
        .filter(([key, value]) => key !== 'skipped' && typeof value === 'number' && (value as number) > 0)
        .map(([key, value]) => t(IMPORT_KEYS[key] ?? 'assistant.settings.import_items', { count: value as number }))
      const notes = result.imported.skipped ?? []
      useUi.getState().toast({
        title: counts.length ? counts.join(' · ') : t('assistant.settings.import_nothing'),
        description: notes.length ? notes.join('; ') : undefined,
        tone: 'success',
        duration: 8000,
      })
      await useAssistant.getState().bootstrap(true)
    } catch (error) {
      // The route names what stopped it — the byte ceiling a restore can read, or how many rows had
      // already landed when a chunk failed. Swallowing that into a generic "failed" would leave the
      // reader with a half-restored account and no idea where it stopped.
      const detail = error instanceof ApiError ? error.serverMessage : undefined
      useUi.getState().toast({
        title: error instanceof SyntaxError ? t('assistant.settings.import_bad_json') : t('assistant.toast.failed'),
        description: detail,
        tone: 'danger',
        duration: detail ? 12000 : undefined,
      })
    } finally {
      setImporting(false)
      setFile(null)
    }
  }

  return (
    <>
      {/* The numbers come first: a reader who opens this tab is usually asking what the assistant has
          been costing, and the export and delete rows below are what they do about it. */}
      <UsagePanel />

      <Group title={t('assistant.settings.data')}>
        <SettingRow title={t('assistant.settings.export')} description={t('assistant.settings.export_hint')}>
          <Button size="sm" variant="secondary" loading={exporting} icon={<Download size={14} />} onClick={() => void runExport()}>
            {t('assistant.settings.export')}
          </Button>
        </SettingRow>
        <SettingRow
          title={t('assistant.settings.import')}
          description={file ? file.name : t('assistant.settings.import_hint')}
        >
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => fileRef.current?.click()}>
              {t('settings.select_file')}
            </Button>
            <Button size="sm" loading={importing} icon={<Upload size={14} />} disabled={!file} onClick={() => void runImport()}>
              {t('assistant.settings.import')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => {
                const picked = event.target.files?.[0] ?? null
                event.target.value = ''
                setFile(picked)
              }}
            />
          </div>
        </SettingRow>
      </Group>

      <ChatFileSpace />

      <Group title={t('assistant.settings.danger')}>
        <SettingRow title={t('assistant.settings.clear_chats')} description={t('assistant.settings.clear_chats_hint')}>
          <Button
            size="sm"
            variant="secondary"
            className="text-[var(--danger)]"
            onClick={() => {
              void confirm({
                title: t('assistant.settings.clear_chats'),
                description: t('assistant.settings.clear_danger_hint'),
                confirmLabel: t('assistant.settings.clear_chats'),
                tone: 'danger',
              }).then(async (yes) => {
                if (!yes) return
                await api.assistant.deleteConversations()
                useAssistant.getState().bootstrap(true)
              })
            }}
          >
            {t('assistant.settings.clear_chats')}
          </Button>
        </SettingRow>
        <SettingRow title={t('assistant.settings.clear_memories')} description={t('assistant.settings.clear_memories_hint')}>
          <Button
            size="sm"
            variant="secondary"
            className="text-[var(--danger)]"
            onClick={() => {
              void confirm({
                title: t('assistant.settings.clear_memories'),
                description: t('assistant.settings.clear_danger_hint'),
                confirmLabel: t('assistant.settings.clear_memories'),
                tone: 'danger',
              }).then(async (yes) => {
                if (!yes) return
                await api.assistant.clearMemories()
                await useAssistant.getState().loadMemories()
              })
            }}
          >
            {t('assistant.settings.clear_memories')}
          </Button>
        </SettingRow>
      </Group>
    </>
  )
}
