/** Per-page layers: order, visibility, naming and whether new ink lands on the layer. */
import { useMemo } from 'react'
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react'
import type { InknoteLayer, InknotePage } from '@shared/inknote/types'
import { ensureLayers, INKNOTE_LAYERS_MAX, layerIdOf, layersOf, newLayerId } from '@shared/inknote/layers'
import { serializePageContent } from '@shared/inknote/parse'
import { t } from '../../../lib/i18n'
import { cn } from '../../../lib/cn'
import { Button } from '../../../components/primitives'
import { Modal, confirm, prompt } from '../../../components/overlay'
import { TooltipIconButton } from '../../../components/tooltip-icon-button'
import { useInknoteStore } from '../store'
import { useUi } from '../../../store/ui'

interface Props {
  open: boolean
  onClose: () => void
  page: InknotePage | null
  activeLayerId: string | null
  onActiveLayer: (id: string) => void
}

export function LayersDialog({ open, onClose, page, activeLayerId, onActiveLayer }: Props) {
  const toast = useUi((state) => state.toast)
  const replacePageContent = useInknoteStore((state) => state.replacePageContent)
  const recordContentHistory = useInknoteStore((state) => state.recordContentHistory)
  const savePage = useInknoteStore((state) => state.savePage)
  const layers = useMemo(() => page ? layersOf(page.content) : [], [page])
  const topFirst = useMemo(() => [...layers].reverse(), [layers])

  const commit = (next: InknoteLayer[], removeLayerId?: string) => {
    if (!page) return
    const content = page.content
    const before = serializePageContent(content)
    ensureLayers(content)
    content.layers = next
    if (removeLayerId) {
      content.strokes = content.strokes.filter((stroke) => layerIdOf(stroke, next) !== removeLayerId)
      content.texts = content.texts.filter((text) => layerIdOf(text, next) !== removeLayerId)
      content.images = content.images.filter((image) => layerIdOf(image, next) !== removeLayerId)
    }
    const after = serializePageContent(content)
    if (before === after) return
    recordContentHistory(page.id, before, after, 'layer')
    replacePageContent(page.id, { ...content })
    void savePage(page.id)
  }

  const add = () => {
    if (!page) return
    const next = [...layers, { id: newLayerId(), name: '', visible: true }]
    commit(next)
    onActiveLayer(next[next.length - 1]!.id)
  }

  const rename = async (layer: InknoteLayer) => {
    const name = await prompt({ title: t('inknote.layers.rename'), defaultValue: layer.name, placeholder: t('inknote.layers.name_placeholder') })
    if (name === null) return
    const trimmed = name.trim().slice(0, 60)
    commit(layers.map((entry) => entry.id === layer.id ? { ...entry, name: trimmed } : entry))
  }

  const toggle = (layer: InknoteLayer) => {
    const next = layers.map((entry) => entry.id === layer.id ? { ...entry, visible: !entry.visible } : entry)
    commit(next)
    if (activeLayerId === layer.id && !layer.visible) {
      // Never leave new ink pointed at a layer the reader cannot see.
      const fallback = next.find((entry) => entry.visible)
      if (fallback) onActiveLayer(fallback.id)
    }
  }

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= layers.length) return
    const next = [...layers]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    commit(next)
  }

  const remove = async (layer: InknoteLayer) => {
    if (layers.length <= 1) { toast({ title: t('inknote.layers.delete_last') }); return }
    const ok = await confirm({ title: t('inknote.layers.delete'), description: t('inknote.layers.delete_confirm'), confirmLabel: t('inknote.delete') })
    if (!ok) return
    const index = layers.findIndex((entry) => entry.id === layer.id)
    const next = layers.filter((entry) => entry.id !== layer.id)
    commit(next, layer.id)
    if (activeLayerId === layer.id) {
      const fallback = next[Math.max(0, Math.min(index, next.length - 1))]
      if (fallback) onActiveLayer(fallback.id)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('inknote.layers.title')} width={460}>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 text-[length:var(--text-11)] leading-relaxed text-[var(--text-tertiary)]">{t('inknote.layers.hint')}</p>
          <Button size="sm" variant="secondary" icon={<Plus size={13}/>} disabled={!page || layers.length >= INKNOTE_LAYERS_MAX} onClick={add}>{t('inknote.layers.add')}</Button>
        </div>
        {layers.length === 0 && <p className="py-4 text-center text-[length:var(--text-12)] text-[var(--text-tertiary)]">{t('inknote.layers.empty')}</p>}
        <div className="max-h-[52vh] space-y-1 overflow-y-auto" role="list">
          {topFirst.map((layer) => {
            const index = layers.findIndex((entry) => entry.id === layer.id)
            const active = (activeLayerId ?? layers[0]?.id) === layer.id
            return (
              <div key={layer.id} role="listitem" className={cn('flex items-center gap-1 rounded-[var(--r-sm)] border px-1.5 py-1', active ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border-subtle)]')}>
                <button type="button" aria-pressed={active} aria-label={t('inknote.layers.active')} onClick={() => onActiveLayer(layer.id)} className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--r-xs)] px-1 py-0.5 text-left">
                  <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', active ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]')} />
                  <span className="min-w-0 truncate text-[length:var(--text-12)]">{layer.name || t('inknote.layers.default_name', { index: String(index + 1) })}</span>
                  {active && <span className="shrink-0 rounded-full border border-[var(--accent)] px-1 text-[length:var(--text-9)] text-[var(--accent-on-soft)]">{t('inknote.layers.active')}</span>}
                </button>
                <TooltipIconButton label={layer.visible ? t('inknote.layers.hide') : t('inknote.layers.show')} size="xs" onClick={() => toggle(layer)}>{layer.visible ? <Eye size={12}/> : <EyeOff size={12}/>}</TooltipIconButton>
                <TooltipIconButton label={t('inknote.layers.up')} size="xs" disabled={index >= layers.length - 1} onClick={() => move(index, 1)}><ArrowUp size={12}/></TooltipIconButton>
                <TooltipIconButton label={t('inknote.layers.down')} size="xs" disabled={index <= 0} onClick={() => move(index, -1)}><ArrowDown size={12}/></TooltipIconButton>
                <TooltipIconButton label={t('inknote.layers.rename')} size="xs" onClick={() => void rename(layer)}><Pencil size={12}/></TooltipIconButton>
                <TooltipIconButton label={t('inknote.layers.delete')} size="xs" disabled={layers.length <= 1} onClick={() => void remove(layer)}><Trash2 size={12}/></TooltipIconButton>
              </div>
            )
          })}
        </div>
      </div>
    </Modal>
  )
}
