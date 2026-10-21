import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { CalendarClock, Eye, EyeOff, MapPin, Maximize2, Mic, Minimize2, Paperclip, Square, X } from 'lucide-react'
import {
  MEMO_ATTACHMENT_MAX_BYTES,
  MEMO_CONTENT_MAX_BYTES,
  MEMO_DEFAULT_VISIBILITY,
} from '@shared/memos/constants'
import {
  MEMO_VISIBILITIES,
  type Memo,
  type MemoAttachment,
  type MemoCreateInput,
  type MemoLocation,
  type MemoPatchInput,
  type MemoVisibility,
} from '@shared/memos/types'
import { DatePicker, TimeField } from '../../../components/date-picker'
import { Modal } from '../../../components/overlay'
import { Button, IconButton, Spinner } from '../../../components/primitives'
import { Select } from '../../../components/form'
import { cn } from '../../../lib/cn'
import { t, type MessageKey } from '../../../lib/i18n'
import { fullTime } from '../../../lib/time'
import { useSession } from '../../../store/session'
import { useUi } from '../../../store/ui'
import { memoAi, memoTranscriptionTarget } from '../ai-client'
import { memosApi } from '../api'
import { memoErrorMessage, memoIsAbortError } from '../errors'
import { prepareMemoAttachment } from '../image-metadata'
import { memoPlaceLabel } from '../location'
import { formatMediaDuration } from '../media'
import { loadMemoDraft, useMemos } from '../state'
import { useMemoDraft } from '../use-memo-draft'
import { useMemoPreferences } from '../use-memo-preferences'
import { useMemoRecorder } from '../use-memo-recorder'
import { useMemoSpaces } from '../use-memo-spaces'
import { attachmentMarkdown } from './memo-editor-format'
import { memoDateValue, memoLocalTimestamp, memoTimeValue } from './memo-time'
import { LocationPicker } from './LocationPicker'
import { MemoBody } from './MemoBody'
import { MemoEditor, type MemoEditorHandle } from './MemoEditor'

const VISIBILITY_KEYS: Record<MemoVisibility, MessageKey> = {
  private: 'memos.visibility.private',
  protected: 'memos.visibility.protected',
  public: 'memos.visibility.public',
}

const INBOX_DRAFT_SCOPE = 'inbox'
const MEGABYTE = 1024 * 1024

function sameLocation(first: MemoLocation | null, second: MemoLocation | null): boolean {
  if (!first || !second) return first === second
  return first.latitude === second.latitude
    && first.longitude === second.longitude
    && first.placeholder === second.placeholder
}

export function memoComposerDraftScope(spaceId: string | null | undefined): string {
  return `new:${spaceId ?? INBOX_DRAFT_SCOPE}`
}

export interface MemoComposerProps {
  memo?: Memo
  spaceId?: string | null
  initialCreatedAt?: number
  onSaved?: (memo: Memo) => void
  onCancel?: () => void
}

interface UploadingFile {
  key: number
  name: string
}

export function MemoComposer({
  memo,
  spaceId = null,
  initialCreatedAt,
  onSaved,
  onCancel,
}: MemoComposerProps): ReactElement {
  const editing = memo !== undefined
  const userId = useSession((state) => state.user?.id ?? 'guest')
  const scope = useRef(memoComposerDraftScope(spaceId)).current
  const [restored] = useState(() => (editing ? null : loadMemoDraft(userId, scope)))
  const startingCreatedAt = useRef(
    memo?.createdAt
    ?? (typeof initialCreatedAt === 'number' && Number.isFinite(initialCreatedAt)
      ? Math.floor(initialCreatedAt)
      : Math.floor(Date.now() / 1000)),
  ).current
  const revRef = useRef(memo?.rev ?? 0)
  const spaces = useMemoSpaces()
  const { preferences } = useMemoPreferences()
  const editorRef = useRef<MemoEditorHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadKey = useRef(0)
  const uploadingRef = useRef(0)
  const attachmentIdsRef = useRef<string[]>(restored?.attachmentIds ?? [])
  const reasonId = useId()
  const previousSpaceProp = useRef(spaceId)

  const [text, setText] = useState(memo?.content ?? restored?.content ?? '')
  const [visibility, setVisibility] = useState<MemoVisibility>(
    memo?.visibility ?? restored?.visibility ?? MEMO_DEFAULT_VISIBILITY,
  )
  const [space, setSpace] = useState<string | null>(
    memo?.spaceId ?? spaceId ?? restored?.spaceId ?? null,
  )
  const [location, setLocation] = useState<MemoLocation | null>(
    memo?.location ?? restored?.location ?? null,
  )
  const [locationOpen, setLocationOpen] = useState(false)
  const [attachmentIds, setAttachmentIds] = useState<string[]>(restored?.attachmentIds ?? [])
  const [createdAt, setCreatedAt] = useState(startingCreatedAt)
  const [saving, setSaving] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [focusMode, setFocusMode] = useState(false)
  const [timeOpen, setTimeOpen] = useState(false)
  const [uploading, setUploading] = useState<UploadingFile[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const recorder = useMemoRecorder()
  const [transcribing, setTranscribing] = useState(false)
  const transcribeAbort = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const conflict = useMemos((state) => state.conflict)
  const clearConflict = useMemos((state) => state.clearConflict)
  const conflictHere = editing && conflict?.memoId === memo.id ? conflict : null

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      transcribeAbort.current?.abort()
    }
  }, [])

  const { error: recorderError, clearError: clearRecorderError } = recorder

  useEffect(() => {
    if (!recorderError) return
    useUi.getState().toast({ title: t(recorderError), tone: 'warning' })
    clearRecorderError()
  }, [recorderError, clearRecorderError])

  useEffect(() => {
    if (memo) revRef.current = memo.rev
  }, [memo])

  useEffect(() => {
    if (memo || previousSpaceProp.current === spaceId) return
    previousSpaceProp.current = spaceId
    setSpace(spaceId)
  }, [memo, spaceId])

  const { clearDraft } = useMemoDraft({
    userId,
    scope,
    enabled: !editing,
    value: text,
    attachmentIds,
    location,
    spaceId: space,
    visibility,
  })

  const byteLength = useMemo(() => new TextEncoder().encode(text).length, [text])
  const isEmpty = text.trim().length === 0
  const tooLarge = byteLength > MEMO_CONTENT_MAX_BYTES
  const uploadPending = uploading.length > 0
  const saveDisabled = saving || uploadPending || transcribing || tooLarge || isEmpty || Boolean(conflictHere)
  const disabledReason = tooLarge
    ? t('memos.composer.too_large')
    : uploadPending
      ? t('memos.composer.uploading_hint')
      : transcribing
        ? t('memos.composer.voice_transcribing')
        : isEmpty && attempted
          ? t('memos.composer.empty')
          : null

  const dateValue = memoDateValue(createdAt)
  const timeValue = memoTimeValue(createdAt)

  const setDate = (value: string): void => {
    if (!value) return
    const next = memoLocalTimestamp(value, timeValue)
    if (next !== null) setCreatedAt(next)
  }

  const setTime = (value: string): void => {
    const next = memoLocalTimestamp(dateValue, value)
    if (next !== null) setCreatedAt(next)
  }

  const appendSnippet = (snippet: string): void => {
    if (editorRef.current) {
      editorRef.current.insert(snippet)
      return
    }
    setText((current) => (current.trim() ? `${current.replace(/\s+$/, '')}\n${snippet}` : snippet))
  }

  const transcribeRecording = async (file: File): Promise<void> => {
    const controller = new AbortController()
    transcribeAbort.current = controller
    setTranscribing(true)
    try {
      const target = memoTranscriptionTarget(await memoAi.providers(controller.signal))
      if (!target) {
        useUi.getState().toast({
          title: t('memos.composer.voice_no_provider'),
          description: t('memos.composer.voice_no_provider_hint'),
          tone: 'warning',
        })
        return
      }
      const form = new FormData()
      form.set('file', file)
      form.set('providerId', target.providerId)
      form.set('model', target.model)
      const result = await memoAi.transcribe(form, controller.signal)
      if (controller.signal.aborted) return
      if (!result.text.trim()) {
        useUi.getState().toast({ title: t('memos.composer.voice_empty'), tone: 'warning' })
        return
      }
      appendSnippet(result.text)
      useUi.getState().toast({ title: t('memos.composer.voice_transcribed'), tone: 'success' })
    } catch (error) {
      if (memoIsAbortError(error) || controller.signal.aborted) return
      useUi.getState().toast({
        title: t('memos.composer.voice_failed'),
        description: memoErrorMessage(error),
        tone: 'danger',
      })
    } finally {
      if (transcribeAbort.current === controller) transcribeAbort.current = null
      if (mountedRef.current) setTranscribing(false)
    }
  }

  const toggleRecording = async (): Promise<void> => {
    if (recorder.status === 'recording') {
      const file = await recorder.stop()
      if (!mountedRef.current) return
      if (!file) {
        useUi.getState().toast({ title: t('memos.composer.voice_empty'), tone: 'warning' })
        return
      }
      await transcribeRecording(file)
      return
    }
    if (recorder.status !== 'idle' || saving || uploadPending || transcribing) return
    const refusal = await recorder.start()
    if (refusal && mountedRef.current) {
      useUi.getState().toast({ title: t(refusal), tone: 'warning' })
    }
  }

  const uploadOne = async (file: File): Promise<void> => {
    let attachment: MemoAttachment | null = null
    try {
      const prepared = await prepareMemoAttachment(file, {
        saveMediaMetadata: preferences.saveMediaMetadata,
      })
      const uploaded = await memosApi.attachments.upload({
        file: prepared.file,
        thumbnail: prepared.thumbnail,
        metadata: prepared.metadata,
        memoId: memo?.id ?? null,
      })
      attachment = uploaded
      appendSnippet(attachmentMarkdown(uploaded))
      attachmentIdsRef.current = [...attachmentIdsRef.current, uploaded.id]
      setAttachmentIds((current) => [...current, uploaded.id])
    } catch (error) {
      if (attachment) {
        try {
          await memosApi.attachments.delete(attachment.id)
        } catch (cleanupError) {
          console.warn('[inkstone] Could not roll back a failed memo attachment insertion', cleanupError)
        }
      }
      useUi.getState().toast({
        title: t('memos.composer.upload_failed', { name: file.name }),
        description: memoErrorMessage(error),
        tone: 'danger',
      })
    }
  }

  const uploadFiles = async (files: File[]): Promise<void> => {
    if (saving || files.length === 0) return
    const accepted: File[] = []
    for (const file of files) {
      if (file.size > MEMO_ATTACHMENT_MAX_BYTES) {
        useUi.getState().toast({
          title: t('memos.composer.upload_too_large', {
            name: file.name,
            limit: Math.floor(MEMO_ATTACHMENT_MAX_BYTES / MEGABYTE),
          }),
          tone: 'warning',
        })
        continue
      }
      accepted.push(file)
    }
    for (const file of accepted) {
      const key = ++uploadKey.current
      uploadingRef.current += 1
      setUploading((current) => [...current, { key, name: file.name }])
      try {
        await uploadOne(file)
      } finally {
        uploadingRef.current -= 1
        setUploading((current) => current.filter((item) => item.key !== key))
      }
    }
  }

  const submit = async (): Promise<void> => {
    setAttempted(true)
    setSaveError(null)
    if (saving || uploadingRef.current > 0 || transcribing || tooLarge || isEmpty || conflictHere) return
    setSaving(true)
    const state = useMemos.getState()
    let saved: Memo | null
    if (memo) {
      const input: MemoPatchInput = { rev: revRef.current, content: text }
      if (visibility !== memo.visibility) input.visibility = visibility
      if (space !== memo.spaceId) input.spaceId = space
      if (createdAt !== memo.createdAt) input.createdAt = createdAt
      if (!sameLocation(location, memo.location)) input.location = location
      saved = await state.patch(memo.id, input)
    } else {
      const input: MemoCreateInput = {
        content: text,
        visibility,
        spaceId: space,
        location,
        createdAt,
      }
      if (attachmentIdsRef.current.length > 0) input.attachmentIds = attachmentIdsRef.current
      saved = await state.create(input)
    }
    setSaving(false)
    if (!saved) {
      const current = useMemos.getState()
      if (!(current.conflict && current.conflict.memoId === memo?.id)) {
        const message = current.mutationError ?? t('memos.composer.failed')
        setSaveError(message)
        useUi.getState().toast({
          title: t('memos.composer.failed'),
          description: message,
          tone: 'danger',
        })
      }
      return
    }
    revRef.current = saved.rev
    useUi.getState().toast({
      title: t(editing ? 'memos.composer.saved' : 'memos.composer.created'),
      tone: 'success',
    })
    if (!editing) {
      clearDraft()
      setText('')
      attachmentIdsRef.current = []
      setAttachmentIds([])
      setCreatedAt(Math.floor(Date.now() / 1000))
      setLocation(null)
      setAttempted(false)
      setShowPreview(false)
    }
    onSaved?.(saved)
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void submit()
  }

  const reloadConflict = (): void => {
    if (!conflictHere?.memo) return
    setText(conflictHere.memo.content)
    setVisibility(conflictHere.memo.visibility)
    setSpace(conflictHere.memo.spaceId)
    setCreatedAt(conflictHere.memo.createdAt)
    setLocation(conflictHere.memo.location)
    revRef.current = conflictHere.memo.rev
    clearConflict()
  }

  const keepLocalConflict = (): void => {
    if (conflictHere?.memo) revRef.current = conflictHere.memo.rev
    clearConflict()
  }

  const form = (
    <form
      onSubmit={onSubmit}
      className={cn(
        'rounded-[var(--r-lg)] border bg-[var(--bg-surface)] p-2.5 shadow-sm',
        dragActive ? 'border-[var(--accent)]' : 'border-[var(--border-subtle)]',
      )}
      data-memo-composer=""
    >
      {showPreview ? (
        <div className="min-h-24 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2 py-1.5">
          {text.trim() ? (
            <MemoBody content={text} className="text-[length:var(--text-12-5)]" />
          ) : (
            <p className="text-[length:var(--text-12)] text-[var(--text-quaternary)]">
              {t('memos.composer.preview_empty')}
            </p>
          )}
        </div>
      ) : (
        <MemoEditor
          ref={editorRef}
          value={text}
          label={t(editing ? 'memos.composer.edit_label' : 'memos.composer.label')}
          placeholder={t('memos.composer.placeholder')}
          onChange={setText}
          onSubmit={() => void submit()}
          onFiles={(files) => void uploadFiles(files)}
          onDragActiveChange={setDragActive}
          autoFocus={focusMode || editing}
          disabled={saving}
        />
      )}
      {recorder.status !== 'idle' || transcribing ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]"
        >
          {recorder.status === 'recording' ? (
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[var(--danger)]" />
          ) : (
            <Spinner size={12} />
          )}
          <span className="min-w-0 truncate">
            {recorder.status === 'starting'
              ? t('memos.composer.voice_requesting')
              : recorder.status === 'stopping'
                ? t('memos.composer.voice_stopping')
                : recorder.status === 'recording'
                  ? t('memos.composer.voice_recording')
                  : t('memos.composer.voice_transcribing')}
          </span>
          {recorder.status === 'recording' ? (
            <time
              aria-hidden="true"
              className="shrink-0 tabular-nums text-[var(--text-quaternary)]"
            >
              {formatMediaDuration(recorder.seconds)}
            </time>
          ) : null}
        </div>
      ) : null}
      {uploading.length > 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="mt-1.5 flex min-w-0 items-center gap-1.5 text-[length:var(--text-11)] text-[var(--text-tertiary)]"
        >
          <Spinner size={12} />
          <span className="min-w-0 truncate">
            {t('memos.composer.uploading', { name: uploading.map((file) => file.name).join(', ') })}
          </span>
        </div>
      ) : null}
      {conflictHere ? (
        <div role="alert" className="mt-2 rounded-[var(--r-sm)] bg-[var(--danger-soft)] px-2 py-1.5">
          <p className="text-[length:var(--text-11-5)] leading-relaxed text-[var(--danger)]">
            {t('memos.composer.conflict')}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {conflictHere.memo ? (
              <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={reloadConflict}>
                {t('memos.composer.reload')}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={keepLocalConflict}>
              {t(conflictHere.memo ? 'memos.composer.keep_local' : 'memos.composer.dismiss')}
            </Button>
          </div>
        </div>
      ) : null}
      {saveError ? (
        <p role="alert" className="mt-2 text-[length:var(--text-11-5)] leading-relaxed text-[var(--danger)]">
          {saveError}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Select
          aria-label={t('memos.composer.visibility')}
          value={visibility}
          onChange={(event) => {
            const next = MEMO_VISIBILITIES.find((value) => value === event.target.value)
            if (next) setVisibility(next)
          }}
          className="h-8 w-24 text-[length:var(--text-11-5)] md:h-7"
        >
          {MEMO_VISIBILITIES.map((value) => (
            <option key={value} value={value}>{t(VISIBILITY_KEYS[value])}</option>
          ))}
        </Select>
        <Select
          aria-label={t('memos.composer.space')}
          value={space ?? ''}
          onChange={(event) => setSpace(event.target.value || null)}
          className="h-8 w-28 text-[length:var(--text-11-5)] md:h-7"
        >
          <option value="">{t('memos.composer.space_none')}</option>
          {spaces.status === 'error' ? (
            <option value="__unavailable" disabled>{t('memos.composer.spaces_unavailable')}</option>
          ) : null}
          {(spaces.data ?? []).map((item) => (
            <option key={item.id} value={item.id}>{item.title}</option>
          ))}
          {space && !(spaces.data ?? []).some((item) => item.id === space) ? (
            <option value={space}>{t('memos.composer.space_unknown')}</option>
          ) : null}
        </Select>
        <span className="inline-flex min-w-0 items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          <time dateTime={new Date(createdAt * 1000).toISOString()} className="truncate">
            {fullTime(createdAt * 1000)}
          </time>
          <IconButton
            label={t('memos.composer.edit_time')}
            size="xs"
            active={timeOpen}
            onClick={() => setTimeOpen((value) => !value)}
          >
            <CalendarClock size={12} />
          </IconButton>
        </span>
        {timeOpen ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <DatePicker
              label={t('memos.composer.timestamp')}
              value={dateValue}
              onChange={setDate}
              className="w-36"
            />
            <span className="block w-24">
              <TimeField
                label={t('memos.composer.timestamp')}
                value={timeValue}
                onChange={setTime}
              />
            </span>
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton
            label={t(
              recorder.status === 'recording' || recorder.status === 'stopping'
                ? 'memos.composer.voice_stop'
                : 'memos.composer.voice_record',
            )}
            size="sm"
            active={recorder.status === 'recording' || recorder.status === 'stopping'}
            disabled={saving
              || uploadPending
              || transcribing
              || recorder.status === 'starting'
              || recorder.status === 'stopping'}
            onClick={() => void toggleRecording()}
          >
            {recorder.status === 'recording' || recorder.status === 'stopping'
              ? <Square size={13} />
              : <Mic size={14} />}
          </IconButton>
          <IconButton
            label={t('memos.composer.location')}
            size="sm"
            active={Boolean(location)}
            onClick={() => setLocationOpen(true)}
          >
            <MapPin size={14} />
          </IconButton>
          <IconButton
            label={t('memos.composer.attach')}
            size="sm"
            disabled={saving}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={14} />
          </IconButton>
          <IconButton
            label={t(showPreview ? 'memos.composer.hide_preview' : 'memos.composer.show_preview')}
            size="sm"
            active={showPreview}
            onClick={() => setShowPreview((value) => !value)}
          >
            {showPreview ? <EyeOff size={14} /> : <Eye size={14} />}
          </IconButton>
          <IconButton
            label={t(focusMode ? 'memos.composer.exit_focus' : 'memos.composer.focus')}
            size="sm"
            active={focusMode}
            onClick={() => setFocusMode((value) => !value)}
          >
            {focusMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </IconButton>
          {onCancel ? (
            <Button size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
              {t('memos.composer.cancel')}
            </Button>
          ) : null}
          <Button
            type="submit"
            size="sm"
            variant="primary"
            loading={saving}
            disabled={saveDisabled}
            aria-describedby={disabledReason ? reasonId : undefined}
          >
            {saving ? t('memos.composer.saving') : t('memos.composer.save')}
          </Button>
        </div>
      </div>
      {location ? (
        <div className="mt-1 flex min-w-0 items-center gap-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          <MapPin size={11} aria-hidden="true" />
          <span className="min-w-0 truncate">{memoPlaceLabel(location)}</span>
          <IconButton label={t('memos.composer.location_clear')} size="xs" onClick={() => setLocation(null)}>
            <X size={11} />
          </IconButton>
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          void uploadFiles(files)
        }}
      />
      {disabledReason ? (
        <p id={reasonId} className="mt-1 text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">
          {disabledReason}
        </p>
      ) : (
        <p className="mt-1 hidden text-[length:var(--text-10-5)] text-[var(--text-quaternary)] sm:block">
          {t('memos.composer.hint')}
        </p>
      )}
    </form>
  )

  const locationPicker = locationOpen ? (
    <LocationPicker
      value={location}
      onChange={setLocation}
      onClose={() => setLocationOpen(false)}
      enableReverseGeocode={preferences.enableReverseGeocoding}
    />
  ) : null

  if (focusMode) {
    return (
      <Modal
        open
        onClose={() => setFocusMode(false)}
        title={t(editing ? 'memos.composer.edit_label' : 'memos.composer.label')}
        description={t('memos.composer.hint')}
        width={720}
      >
        {form}
        {locationPicker}
      </Modal>
    )
  }
  return <>{form}{locationPicker}</>
}
