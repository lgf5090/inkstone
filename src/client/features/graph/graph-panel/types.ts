import type { GraphNode } from '@shared/types'

export interface CanvasNode extends GraphNode {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  pinned?: boolean
  colorGroup: string | null
}

export interface CanvasEdge {
  a: CanvasNode
  b: CanvasNode
}

export interface Palette {
  edge: string
  edgeDim: string
  node: string
  accent: string
  label: string
  font: string
  background: string
}

export interface CanvasState {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  scale: number
  offsetX: number
  offsetY: number
  dragging: { node: CanvasNode | null; startX: number; startY: number; ox: number; oy: number } | null
  pointers: Map<number, { x: number; y: number }>
  pinch: { distance: number; scale: number; centerX: number; centerY: number } | null
  frame: number
  raf: number
  needsFit: boolean
  initialized: boolean
  palette: Palette
  emphasis: { id: string | null; neighbours: Set<string> }
  searchHits: ReadonlySet<string> | null
  schedule: (() => void) | null
}

export interface GraphCanvasControls {
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  selectNode: (id: string) => void
  centerOn: (id: string) => void
  scale: () => number
}

export interface GraphCanvasCallbacks {
  onOpenNote: (id: string) => void
  onCreateNote: (title: string) => void
  onOpenNoteToRight?: (id: string) => void
  onShowBacklinks?: (id: string) => void
  onMakeLocalCenter?: (id: string) => void
  onPinChange?: (id: string) => void
  onExcludeChange?: (id: string) => void
  onFilterByTag?: (name: string) => void
}
