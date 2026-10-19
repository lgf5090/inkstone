/**
 * The change a canvas rewrite would make, before it is made.
 *
 * The range is resolved again here rather than trusted from the moment the request was sent: the reader
 * may have typed while the model was thinking, and a replacement that landed a paragraph off would
 * overwrite words they wrote. The same refusal the note editor uses is enough.
 */
import { useMemo } from 'react'
import { t } from '../../lib/i18n'
import { Button } from '../../components/primitives'
import { Modal } from '../../components/overlay'
import { applyCanvasAi, type CanvasWriteRequest } from './canvas-ai'
import { buildWriteDiff, WriteDiffView } from './editor-ai-diff'

export function CanvasAiPreview({ request, label, answer, content, saving, onApply, onClose }: {
  request: CanvasWriteRequest
  label: string
  answer: string
  content: string
  saving: boolean
  onApply: (content: string) => void
  onClose: () => void
}) {
  const write = useMemo(() => applyCanvasAi(content, request, answer), [content, request, answer])
  const diff = useMemo(() => (write.status === 'ok' ? buildWriteDiff(content, write.content) : null), [write, content])
  return (
    <Modal
      open
      onClose={onClose}
      title={`${label} · ${t('assistant.canvas.ai_title')}`}
      description={t('assistant.canvas.ai_hint')}
      width={720}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          disabled={!diff || !diff.changed || saving}
          onClick={() => { if (write.status === 'ok') onApply(write.content) }}
        >
          {t('assistant.canvas.ai_apply')}
        </Button>
      </>}
    >
      {write.status === 'stale'
        ? <p role="alert" className="text-[length:var(--text-12)] leading-relaxed text-[var(--warning)]">{t('assistant.canvas.ai_stale')}</p>
        : diff
          ? <div className="max-h-[60vh] overflow-auto"><WriteDiffView diff={diff} /></div>
          : null}
    </Modal>
  )
}
