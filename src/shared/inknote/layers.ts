/** Layers on one page: the ordered list, the layer an item belongs to and a stable default. */
import type { InknoteLayer, InknotePageContent } from './types'

export const DEFAULT_LAYER_ID = 'layer-1'
export const INKNOTE_LAYERS_MAX = 20

const DEFAULT_LAYERS: readonly InknoteLayer[] = [{ id: DEFAULT_LAYER_ID, name: '', visible: true }]

/** The page's layers, bottom first; a page written before layers existed reads as one default layer. */
export function layersOf(content: InknotePageContent): readonly InknoteLayer[] {
  return content.layers?.length ? content.layers : DEFAULT_LAYERS
}

/** Write the default layer onto a page that has none, and pin unassigned ink to the bottom layer. */
export function ensureLayers(content: InknotePageContent): InknoteLayer[] {
  if (!content.layers?.length) content.layers = DEFAULT_LAYERS.map((layer) => ({ ...layer }))
  const base = content.layers[0]!.id
  for (const item of content.strokes) if (!item.layer) item.layer = base
  for (const item of content.texts) if (!item.layer) item.layer = base
  for (const item of content.images) if (!item.layer) item.layer = base
  return content.layers
}

/** The layer id an item draws on; an item without one belongs to the bottom layer. */
export function layerIdOf(item: { layer?: string } | null | undefined, layers: readonly InknoteLayer[]): string {
  const id = item?.layer
  if (id && layers.some((layer) => layer.id === id)) return id
  return layers[0]?.id ?? DEFAULT_LAYER_ID
}

/** Whether an item is on a layer the reader can currently see. */
export function isLayerVisible(item: { layer?: string } | null | undefined, layers: readonly InknoteLayer[]): boolean {
  const id = layerIdOf(item, layers)
  return layers.some((layer) => layer.id === id && layer.visible)
}

export function newLayerId(): string {
  return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}
