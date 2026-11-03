/**
 * A full-size look at a diagram an answer already drew.
 *
 * The click is delegated from the document because the diagram lives inside Markdown the assistant wrote,
 * not inside a React tree this app owns. The viewer clones the rendered SVG; it never re-renders the source,
 * so what the reader sees is the same diagram that was on the page.
 */
import { useEffect, useRef, useState } from 'react'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { Modal, Tooltip } from '../../components/overlay'
import { IconButton } from '../../components/primitives'
import { t } from '../../lib/i18n'

export function MermaidViewer() {
  const [svg, setSvg] = useState<string | null>(null)
  const [scale, setScale] = useState(1)
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null
      const block = target?.closest<HTMLElement>('[data-mermaid]')
      const rendered = block?.querySelector('svg')
      if (!block || !rendered) return
      event.preventDefault()
      setSvg(rendered.outerHTML)
      setScale(1)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])
  useEffect(() => {
    if (!svg || !hostRef.current) return
    hostRef.current.innerHTML = svg
    const rendered = hostRef.current.querySelector('svg')
    rendered?.removeAttribute('height')
    rendered?.setAttribute('width', '100%')
  }, [svg])
  const close = () => setSvg(null)
  return (
    <Modal open={svg !== null} onClose={close} title={t('assistant.chat.diagram')} width={900}>
      <div className="flex items-center justify-end gap-1 pb-2">
        <Tooltip label={t('common.zoom_out')}>
          <IconButton label={t('common.zoom_out')} size="sm" onClick={() => setScale((value) => Math.max(0.4, value - 0.2))}><Minus size={13} /></IconButton>
        </Tooltip>
        <span className="w-12 text-center text-[length:var(--text-11)] tabular-nums text-[var(--text-quaternary)]">{Math.round(scale * 100)}%</span>
        <Tooltip label={t('common.zoom_in')}>
          <IconButton label={t('common.zoom_in')} size="sm" onClick={() => setScale((value) => Math.min(3, value + 0.2))}><Plus size={13} /></IconButton>
        </Tooltip>
        <Tooltip label={t('assistant.chat.diagram_reset')}>
          <IconButton label={t('assistant.chat.diagram_reset')} size="sm" onClick={() => setScale(1)}><RotateCcw size={13} /></IconButton>
        </Tooltip>
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-[var(--r-md)] bg-[var(--bg-inset)] p-3">
        <div ref={hostRef} style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: `${100 / scale}%` }} />
      </div>
    </Modal>
  )
}
