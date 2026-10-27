import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Loader2, Music, Upload } from 'lucide-react'
import type { AttachmentWithUsage } from '@shared/types'
import { Button } from '../../components/primitives'
import { FilterInput } from '../../components/FilterInput'
import { Modal } from '../../components/overlay'
import { api } from '../../lib/api'
import { cn } from '../../lib/cn'
import { t } from '../../lib/i18n'
import { kindFromMime } from '../../lib/inkpad/element-kind'
import { compileQuery, queryKeepsRows, queryMatches } from '../../lib/query-match'
import { usePinyinVersion } from '../../lib/pinyin'
import { useUi } from '../../store/ui'

const RESULT_LIMIT = 120

export interface PickedInkFile {
    id: string
    filename: string
    mime: string
    url: string
}

export function InkFilePicker({ open, noteId, onClose, onPick }: {
    open: boolean
    noteId?: string
    onClose: () => void
    onPick: (file: PickedInkFile) => void
}) {
    const toast = useUi((state) => state.toast)
    const pinyinVersion = usePinyinVersion()
    const [files, setFiles] = useState<AttachmentWithUsage[] | null>(null)
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [query, setQuery] = useState('')
    const [busy, setBusy] = useState(false)
    const [failed, setFailed] = useState(false)
    const fileInput = useRef<HTMLInputElement>(null)
    const epoch = useRef(0)

    const loadPage = useCallback(async (cursor: string | undefined, stamp: number) => {
        try {
            const result = await api.files.list(cursor)
            if (stamp !== epoch.current) return
            setFailed(false)
            setFiles((previous) => {
                if (!cursor) return result.files
                const seen = new Set((previous ?? []).map((file) => file.id))
                return [...(previous ?? []), ...result.files.filter((file) => !seen.has(file.id))]
            })
            setNextCursor(result.nextCursor ?? null)
        } catch {
            if (stamp === epoch.current) {
                setFailed(true)
                setFiles((current) => current ?? [])
            }
        }
    }, [])

    useEffect(() => {
        if (!open) {
            epoch.current += 1
            setFiles(null)
            setQuery('')
            setNextCursor(null)
            setFailed(false)
            return
        }
        const stamp = ++epoch.current
        setFiles(null)
        setQuery('')
        setFailed(false)
        void loadPage(undefined, stamp)
    }, [open, loadPage])

    const available = useMemo(() => (files ?? []).filter((file) => kindFromMime(file.mime, file.filename) !== null), [files])
    const filter = useMemo(() => compileQuery(query), [query])
    const shown = useMemo(() => {
        if (queryKeepsRows(filter)) return available.slice(0, RESULT_LIMIT)
        const scored: Array<{ file: AttachmentWithUsage; score: number }> = []
        for (const file of available) {
            const match = queryMatches(filter, file.filename)
            if (match) scored.push({ file, score: match.score })
        }
        scored.sort((a, b) => b.score - a.score)
        return scored.slice(0, RESULT_LIMIT).map((entry) => entry.file)
    }, [available, filter, pinyinVersion])

    const choose = (file: PickedInkFile) => {
        onPick(file)
        onClose()
    }

    const upload = async (file: File) => {
        const kind = kindFromMime(file.type, file.name)
        if (!kind) {
            toast({ title: t('ink.file.unsupported'), tone: 'warning' })
            return
        }
        setBusy(true)
        try {
            const saved = await api.files.upload(file, noteId)
            choose({ id: saved.id, filename: saved.filename, mime: saved.mime, url: saved.url })
        } catch (error) {
            toast({
                title: t('ink.file.upload_failed'),
                description: error instanceof Error ? error.message : String(error),
                tone: 'danger',
            })
        } finally {
            setBusy(false)
        }
    }

    return (
        <Modal open={open} onClose={onClose} title={t('ink.file.title')} width={620}>
            <div className="flex min-h-0 flex-col gap-3">
                <div className="flex items-center gap-2">
                    <FilterInput
                        size="panel"
                        value={query}
                        onChange={setQuery}
                        query={filter}
                        label={t('ink.file.search')}
                        placeholder={t('ink.file.search')}
                        className="mt-0 min-w-0 flex-1"
                    />
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy}
                        onClick={() => fileInput.current?.click()}
                        className="shrink-0"
                    >
                        {busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                        {t('ink.file.upload')}
                    </Button>
                    <input
                        ref={fileInput}
                        type="file"
                        accept="image/*,application/pdf,audio/*"
                        hidden
                        onChange={(event) => {
                            const file = event.target.files?.[0]
                            event.target.value = ''
                            if (file) void upload(file)
                        }}
                    />
                </div>
                {files === null && <p className="py-6 text-center text-[length:var(--text-12-5)] text-[var(--text-quaternary)]">{t('ink.file.loading')}</p>}
                {files !== null && failed && <p className="py-6 text-center text-[length:var(--text-12-5)] text-[var(--danger)]">{t('ink.file.failed')}</p>}
                {files !== null && !failed && available.length === 0 && <p className="py-6 text-center text-[length:var(--text-12-5)] text-[var(--text-quaternary)]">{t('ink.file.empty')}</p>}
                {files !== null && !failed && available.length > 0 && shown.length === 0 && <p className="py-6 text-center text-[length:var(--text-12-5)] text-[var(--text-quaternary)]">{t('ink.file.no_match')}</p>}
                {shown.length > 0 && (
                    <div role="group" aria-label={t('ink.file.title')} className="grid max-h-72 grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 overflow-y-auto p-0.5">
                        {shown.map((file) => (
                            <button
                                key={file.id}
                                type="button"
                                title={file.filename}
                                aria-label={file.filename}
                                onClick={() => choose({ id: file.id, filename: file.filename, mime: file.mime, url: file.url })}
                                className={cn('flex min-w-0 flex-col gap-1 overflow-hidden rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-1.5 text-left transition-shadow hover:ring-2 hover:ring-[var(--accent-ring)]')}
                            >
                                <span className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-[var(--r-xs)] bg-[var(--bg-surface)] text-[var(--text-tertiary)]">
                                    {kindFromMime(file.mime, file.filename) === 'image'
                                        ? <img src={file.url} alt="" loading="lazy" decoding="async" className="size-full object-contain" />
                                        : kindFromMime(file.mime, file.filename) === 'pdf' ? <FileText size={22} /> : <Music size={22} />}
                                </span>
                                <span className="truncate text-[length:var(--text-11)] text-[var(--text-secondary)]">{file.filename}</span>
                            </button>
                        ))}
                    </div>
                )}
                {nextCursor && files !== null && (
                    <button type="button" onClick={() => void loadPage(nextCursor ?? undefined, epoch.current)} className="self-start rounded-[var(--r-sm)] px-2 py-1 text-[length:var(--text-12)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]">
                        {t('ink.file.more')}
                    </button>
                )}
            </div>
        </Modal>
    )
}
