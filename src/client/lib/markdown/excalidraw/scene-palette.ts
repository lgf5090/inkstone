/**
 * Literal colours written into Excalidraw scenes and handed to the canvas engine.
 *
 * Scene JSON is rendered outside this page's CSS cascade, so `var(--pele-*)` is not a colour the engine
 * can use. Keep the serialized values here, matching the colours they replaced, rather than growing
 * another set of inline literals in each converter or starter.
 */
export const EXCALIDRAW_SCENE_PALETTE = {
    background: '#ffffff',
    foreground: '#1e1e1e',
    nodeFill: '#e0e7ff',
    nodeStroke: '#4338ca',
    decisionFill: '#fef3c7',
    connector: '#4f46e5',
    connectorLabel: '#6366f1',
    lifeline: '#94a3b8',
    sequenceLabel: '#334155',
    highlight: 'rgba(0,118,255,1)',
    transparent: 'transparent',
} as const;
