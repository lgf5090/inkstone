export type InkTool =
    | 'pen'
    | 'pencil'
    | 'marker'
    | 'highlighter'
    | 'eraser'
    | 'lasso'
    | 'line'
    | 'arrow'
    | 'rectangle'
    | 'ellipse'

export type InkPaperStyle = 'grid' | 'dots' | 'lines' | 'cornell' | 'music' | 'weekly' | 'blank'

export interface InkPoint {
    x: number
    y: number
    /** Pressure after the low-pass filter; 0.2~0.9. */
    p: number
    /** Pointer timestamp, kept for Inkpad file compatibility. */
    t: number
}

export interface InkStroke {
    id: string
    /** The reference parser accepts all ten tool names; stored strokes are normally the six brushes. */
    tool: InkTool
    /** A validated CSS colour; imported files usually carry hex. */
    color: string
    width: number
    points: InkPoint[]
    /** Note title, URL or /n/<id>; the protocol is checked when it is opened. */
    link?: string
}

export interface InkShape {
    id: string
    type: 'line' | 'arrow' | 'rectangle' | 'ellipse'
    color: string
    width: number
    start: { x: number; y: number }
    end: { x: number; y: number }
    link?: string
}

export type InkElementKind = 'markdown' | 'pdf' | 'image' | 'audio' | 'text'

export interface InkElement {
    id: string
    kind: InkElementKind
    /** Display / fallback name: note title or attachment filename; empty for a text card. */
    path: string
    /** Note card: target note id; old files without one resolve by title. */
    noteId?: string
    /** Attachment card: target attachment id; old files without one resolve by filename. */
    fileId?: string
    /**
     * Attachment card: /api/files/<fileId> (or the same-origin address in an old file).
     * It must be serialized: attachment pruning scans note bodies for this address.
     */
    url?: string
    mime?: string
    text?: string
    x: number
    y: number
    width: number
    height: number
    /** Intrinsic image width / height; written after the image loads. */
    aspectRatio?: number
    locked?: boolean
    pageCount?: number
    pageAspect?: number
    fitPdfPages?: boolean
}

export interface InkBookmark {
    id: string
    name: string
    x: number
    y: number
    zoom: number
}

export interface InkViewport {
    x: number
    y: number
    zoom: number
}

export interface InkDocument {
    format: 'inkpad'
    version: 1
    strokes: InkStroke[]
    shapes: InkShape[]
    elements: InkElement[]
    bookmarks?: InkBookmark[]
    viewport?: InkViewport
}
