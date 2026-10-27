import type { InkBookmark, InkDocument, InkElement, InkPaperStyle, InkTool } from '../../lib/inkpad/types'

export interface InkEngineSettings {
    paperStyle: InkPaperStyle
    pressureResponse: 'fixed' | 'subtle' | 'natural'
}

export type InkErrorCode = 'canvas_unavailable' | 'unsupported_file'

export interface InkEngineHost {
    /** The engine reads paper style and pressure response on demand. */
    settings(): InkEngineSettings
    onDirty(): void
    onViewportChange(zoom: number): void
    onToolChange(tool: InkTool): void
    onSelectionChange(count: number, hasLink: boolean): void
    onElementsChange(): void
    onQuickMenu(x: number, y: number): void
    /** The engine holds no interface copy; it hands the shell a code to translate. */
    onError(code: InkErrorCode, detail?: string): void
    openNote(target: string, options?: { adjacent?: boolean }): void
    openUrl(url: string): void
}

export interface InkEngine {
    mount(canvas: HTMLCanvasElement, hostEl: HTMLElement): void
    destroy(): void
    /** The shell parses first; the engine never parses the 1.9 MB body a second time. */
    load(document: InkDocument): void
    serialize(): string
    setTool(tool: InkTool): void
    setInk(color: string, width: number): void
    refreshAppearance(): void
    elements(): readonly InkElement[]
    bookmarks(): readonly InkBookmark[]
    zoom(): number
    /** Called by React after it commits the two card layers. */
    layoutElements(): void
    undo(): void
    redo(): void
    canUndo(): boolean
    canRedo(): boolean
    frameContent(): boolean
    resetZoom(): void
    selectionCount(): number
    hasSelectionLink(): boolean
    deleteSelection(): void
    duplicateSelection(): void
    applyColorToSelection(): void
    convertSelection(type: 'line' | 'rectangle' | 'ellipse'): void
    linkSelection(link: string | null): void
    openSelectionLink(): void
    addBookmark(name: string): void
    goToBookmark(id: string): void
    deleteBookmark(id: string): void
    insertNote(note: { id: string; title: string }): void
    insertFile(file: { id: string; filename: string; mime: string; url: string }): void
    insertText(text: string): void
    removeElement(id: string): void
    toggleElementLock(id: string): void
    bringElementToFront(id: string): void
    sendElementToBack(id: string): void
    patchElement(
        id: string,
        patch: Partial<Pick<InkElement, 'noteId' | 'fileId' | 'url' | 'mime' | 'text' | 'aspectRatio' | 'fitPdfPages' | 'height'>>,
        options?: { history?: boolean },
    ): void
    startElementGesture(id: string, mode: 'move' | 'resize', event: PointerEvent, captureTarget: HTMLElement): void
    moveElementBy(id: string, dx: number, dy: number): void
    resizeElementBy(id: string, dx: number, dy: number): void
    exportSvgString(): string | null
    exportPngBlob(): Promise<Blob | null>
    exportSelectionPngBlob(): Promise<Blob | null>
}
