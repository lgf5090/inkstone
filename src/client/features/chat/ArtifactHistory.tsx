/**
 * The versions of one draft.
 *
 * A draft the assistant can rewrite is only safe if the text it replaced is still reachable. The list
 * is metadata — version, who wrote it, when — because a hundred thousand characters times fifty versions
 * is not a list; the body is read for the one version the reader picks. Restoring appends, it does not
 * rewind: the way forward stays in the history, and the current text is the next version's parent.
 */
import { useEffect, useMemo, useState } from 'react'
import { GitCompare, History, Loader2, RotateCcw } from 'lucide-react'
import type { AssistantArtifact, AssistantArtifactVersion, AssistantArtifactVersionSource } from '@shared/assistant'
import type { MessageKey } from '../../lib/i18n'
import { t } from '../../lib/i18n'
import { relativeTime } from '../../lib/time'
import { cn } from '../../lib/cn'
import { Button, IconButton, Spinner } from '../../components/primitives'
import { Modal, confirm } from '../../components/overlay'
import { useUi } from '../../store/ui'
import { ArtifactBody } from './ArtifactBody'
import { buildWriteDiff, WriteDiffView } from './editor-ai-diff'
import { LoadFailure } from './assistant-settings-shared'
import { useAssistant } from './assistant-store'

/** Above this, a character-level diff costs more than it tells; the two versions are still readable. */
const MAX_DIFF_CHARS = 40_000

const SOURCE_KEYS: Record<AssistantArtifactVersionSource, MessageKey> = {
  user: 'assistant.canvas.source_user',
  assistant: 'assistant.canvas.source_assistant',
  restore: 'assistant.canvas.source_restore',
  import: 'assistant.canvas.source_import',
}

export function ArtifactHistory({ artifact, onClose }: {
  artifact: AssistantArtifact
  onClose: () => void
}) {
  const versions = useAssistant((state) => state.artifactVersions[artifact.id])
  const loadVersions = useAssistant((state) => state.loadArtifactVersions)
  const readVersion = useAssistant((state) => state.readArtifactVersion)
  const restoreVersion = useAssistant((state) => state.restoreArtifactVersion)
  const toast = useUi((state) => state.toast)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AssistantArtifactVersion | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [comparing, setComparing] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setLoadError(null)
    void loadVersions(artifact.id).catch((error: unknown) => {
      if (alive) setLoadError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      alive = false
    }
  }, [artifact.id, loadVersions, attempt])

  // The current version is the one most readers want to see first; a history that opens on a blank pane
  // makes them pick a row to find out what they were already looking at.
  useEffect(() => {
    if (selectedId || !versions?.length) return
    const head = versions[0]!
    setSelectedId(head.id)
    void read(head.id)
  }, [versions, selectedId])

  const read = (versionId: string): void => {
    setLoading(true)
    setDetailError(null)
    setComparing(false)
    void readVersion(artifact.id, versionId)
      .then((version) => setDetail(version))
      .catch((error: unknown) => setDetailError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }

  const select = (version: AssistantArtifactVersion): void => {
    setSelectedId(version.id)
    read(version.id)
  }

  const diff = useMemo(() => {
    if (!comparing || !detail?.content) return null
    if (detail.content.length > MAX_DIFF_CHARS || artifact.content.length > MAX_DIFF_CHARS) return 'too-long' as const
    return buildWriteDiff(artifact.content, detail.content)
  }, [comparing, detail?.content, artifact.content])

  const restore = async (): Promise<void> => {
    if (!detail) return
    const agreed = await confirm({
      title: t('assistant.canvas.restore_title', { version: detail.version }),
      description: t('assistant.canvas.restore_hint'),
      confirmLabel: t('assistant.canvas.restore'),
    })
    if (!agreed) return
    setRestoring(true)
    try {
      await restoreVersion(artifact.id, detail.id)
      toast({ title: t('assistant.canvas.restored'), tone: 'success' })
      onClose()
    } catch (error) {
      toast({
        title: t('assistant.canvas.restore_failed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      })
    } finally {
      setRestoring(false)
    }
  }

  const isCurrent = detail?.version === artifact.version
  const sourceLabel = (source: AssistantArtifactVersionSource): string => t(SOURCE_KEYS[source])

  return (
    <Modal
      open
      onClose={onClose}
      title={t('assistant.canvas.history')}
      description={t('assistant.canvas.history_hint')}
      width={860}
      footer={<Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>}
    >
      {loadError ? (
        <LoadFailure
          messageKey="assistant.canvas.history_failed"
          detail={loadError}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : !versions ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : !versions.length ? (
        <p className="py-10 text-center text-[length:var(--text-12)] text-[var(--text-quaternary)]">
          {t('assistant.canvas.history_empty')}
        </p>
      ) : (
        <div className="grid min-h-0 gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label={t('assistant.canvas.history')} className="max-h-[46vh] overflow-y-auto md:max-h-[58vh]">
            <ul className="flex flex-col gap-px">
              {versions.map((version) => {
                const active = version.id === selectedId
                return (
                  <li key={version.id}>
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      onClick={() => select(version)}
                      className={cn(
                        'flex w-full min-w-0 flex-col items-start gap-0.5 rounded-[var(--r-sm)] px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)]',
                        active ? 'bg-[var(--bg-inset)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <span className="flex w-full items-center gap-1.5">
                        <span className="shrink-0 font-medium tabular-nums">{`v${version.version}`}</span>
                        <span className="min-w-0 truncate text-[length:var(--text-11)] text-[var(--text-tertiary)]">
                          {sourceLabel(version.source)}
                        </span>
                        {version.version === artifact.version && (
                          <span className="ml-auto shrink-0 rounded-[var(--r-sm)] bg-[var(--accent-soft)] px-1 text-[length:var(--text-10)] text-[var(--accent-on-soft)]">
                            {t('assistant.canvas.history_current')}
                          </span>
                        )}
                      </span>
                      <span className="text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{relativeTime(version.createdAt)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>
          <div className="flex min-h-0 min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-1">
              <span className="min-w-0 truncate text-[length:var(--text-12)] font-medium text-[var(--text-primary)]">
                {detail ? `v${detail.version} · ${sourceLabel(detail.source)}` : t('assistant.canvas.history_pick')}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<GitCompare size={12} />}
                  disabled={!detail?.content || isCurrent}
                  onClick={() => setComparing((value) => !value)}
                >
                  {comparing ? t('assistant.canvas.history_hide_diff') : t('assistant.canvas.history_compare')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={restoring ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                  disabled={!detail || isCurrent || restoring}
                  onClick={() => void restore()}
                >
                  {t('assistant.canvas.restore')}
                </Button>
              </div>
            </div>
            {detailError ? (
              <LoadFailure
                messageKey="assistant.canvas.history_version_failed"
                detail={detailError}
                onRetry={() => { if (selectedId) read(selectedId) }}
              />
            ) : loading || !detail ? (
              <div className="flex justify-center py-10"><Spinner /></div>
            ) : comparing ? (
              diff === 'too-long' ? (
                <p className="rounded-[var(--r-md)] bg-[var(--bg-inset)] p-3 text-[length:var(--text-12)] leading-relaxed text-[var(--text-tertiary)]">
                  {t('assistant.canvas.history_too_long')}
                </p>
              ) : diff ? (
                <div className="max-h-[46vh] overflow-auto rounded-[var(--r-md)] border border-[var(--border-subtle)] p-2 md:max-h-[54vh]">
                  <WriteDiffView diff={diff} />
                </div>
              ) : null
            ) : (
              <div className="h-[46vh] overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-sunken)] md:h-[54vh]">
                <ArtifactBody content={detail.content ?? ''} title={detail.title} />
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

/** The header control that opens the history; the editor owns the open state. */
export function HistoryButton({ onOpen }: { onOpen: () => void }) {
  return (
    <IconButton label={t('assistant.canvas.history')} size="sm" onClick={onOpen}>
      <History size={13} />
    </IconButton>
  )
}
