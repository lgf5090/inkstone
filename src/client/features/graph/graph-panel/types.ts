import type { GraphNode, GraphResponse } from '@shared/types'

/**
 * A node kind the graph feature knows about and the note schema does not.
 *
 * A conversation is not a note, so it has no `GraphNode.kind` of its own in the shared type: what the notes
 * app stores, what its graph route answers, and what its link index can point at are all note-shaped, and
 * widening that union would make the notebook's storage answer for a table it does not own. The threads are
 * merged in here, in the one module that draws them, from the assistant's own reads — so the extra kind
 * lives on this side of the boundary, and a `GraphNode` still flows into it unchanged.
 */
export type SceneNodeKind = GraphNode['kind'] | 'conversation'

/** A graph node as the canvas sees it: the route's rows, plus the threads merged in beside them. */
export interface SceneNode extends Omit<GraphNode, 'kind'> {
  kind: SceneNodeKind
}

/** The same answer, with the threads in it. Every field but the nodes is the route's own. */
export interface SceneResponse extends Omit<GraphResponse, 'nodes'> {
  nodes: SceneNode[]
}

export interface CanvasNode extends SceneNode {
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
  /** Pressed on a thread: the panel decides what opening a conversation means, the canvas only names it. */
  onOpenConversation?: (threadId: string) => void
  onOpenNoteToRight?: (id: string) => void
  onShowBacklinks?: (id: string) => void
  onMakeLocalCenter?: (id: string) => void
  onPinChange?: (id: string) => void
  onExcludeChange?: (id: string) => void
  onFilterByTag?: (name: string) => void
}
