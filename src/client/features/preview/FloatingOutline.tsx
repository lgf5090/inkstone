import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { GripHorizontal, ListTree, Minus, RotateCcw } from 'lucide-react';
import type { Heading } from '../../lib/markdown/renderer';
import { Tooltip } from '../../components/overlay';
import { t } from '../../lib/i18n';
import type { MessageKey } from '@shared/locales/en-US';
import type { OutlineTextDirectionName } from '@shared/types';
import { useUi } from '../../store/ui';
import { Outline } from './Outline';
import {
    CIRCLE_SIZE,
    CORNERS,
    DEFAULT_RATIO,
    OUTLINE_FLOAT_WIDTH,
    clampToBounds,
    cornerFor,
    panelBounds,
    panelHeight,
    passedThreshold,
    resolvePosition,
    snapToBounds,
    toRatio,
    type PanelCorner,
    type PanelPoint,
    type SnappedEdge,
} from './outline-float';

const CORNER_LABEL: Record<PanelCorner['id'], MessageKey> = {
    'top-left': 'outline.corner_top_left',
    'top-right': 'outline.corner_top_right',
    'bottom-left': 'outline.corner_bottom_left',
    'bottom-right': 'outline.corner_bottom_right',
};

const CORNER_DOT: Record<PanelCorner['id'], string> = {
    'top-left': 'left-0 top-0',
    'top-right': 'right-0 top-0',
    'bottom-left': 'bottom-0 left-0',
    'bottom-right': 'bottom-0 right-0',
};

interface DragGesture {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startLeft: number;
    startTop: number;
    active: boolean;
}

interface DragVisual {
    point: PanelPoint;
    edgeX: SnappedEdge;
    edgeY: SnappedEdge;
}

export function FloatingOutline({ headings, onSelect, scrollerRef, noteId, defaultLevel, showProgress, keepSearch, activeOverride, content, onContentChange, dragEdits, autoExpand, tooltipSide, truncateLength, markdownLabels, showReadingTime, readingSpeed, wordCount, hoverPeek, textDirection, collapsible = false, containerRef, }: {
    headings: Heading[];
    onSelect: (heading: Heading) => void;
    scrollerRef?: RefObject<HTMLElement | null>;
    noteId?: string;
    defaultLevel: number;
    showProgress: boolean;
    keepSearch: boolean;
    activeOverride?: string | null;
    content?: string;
    onContentChange?: (next: string) => void;
    dragEdits: boolean;
    autoExpand: 'off' | 'ancestors';
    tooltipSide: 'left' | 'right';
    truncateLength: number;
    markdownLabels: boolean;
    showReadingTime: boolean;
    readingSpeed: number;
    wordCount: number;
    hoverPeek: boolean;
    textDirection: OutlineTextDirectionName;
    /** Collapses to a dot the reader clicks open, the way the reference parks its circle. */
    collapsible?: boolean;
    containerRef: RefObject<HTMLElement | null>;
}) {
    const stored = useUi((state) => state.outlineFloatingPosition);
    const setLayout = useUi((state) => state.setLayout);
    const [box, setBox] = useState({ width: 0, height: 0 });
    const [drag, setDrag] = useState<DragVisual | null>(null);
    const [expanded, setExpanded] = useState(!collapsible);
    const gestureRef = useRef<DragGesture | null>(null);
    // A finished drag must not also count as the click that opens the panel.
    const movedRef = useRef(false);

    useEffect(() => {
        const container = containerRef.current;
        if (!container)
            return;
        const measure = () => {
            const rect = container.getBoundingClientRect();
            setBox((current) => Math.abs(current.width - rect.width) < 0.5 && Math.abs(current.height - rect.height) < 0.5
                ? current
                : { width: rect.width, height: rect.height });
        };
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        return () => observer.disconnect();
    }, [containerRef]);

    const height = panelHeight(box.height);
    const folded = collapsible && !expanded;
    const width = folded ? CIRCLE_SIZE : OUTLINE_FLOAT_WIDTH;
    const travel = folded ? CIRCLE_SIZE : height;
    const bounds = panelBounds(box.width, box.height, width, travel);
    const resting = resolvePosition(stored ?? DEFAULT_RATIO, bounds);
    const activeCorner = cornerFor(stored ?? DEFAULT_RATIO)?.id ?? null;
    const point = clampToBounds(drag?.point ?? resting, bounds);

    const commit = useCallback((next: PanelPoint) => {
        setLayout({ outlineFloatingPosition: toRatio(next, bounds, stored ?? DEFAULT_RATIO) });
    }, [bounds, stored, setLayout]);

    const abort = () => {
        gestureRef.current = null;
        setDrag(null);
    };

    const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0 || !event.isPrimary || gestureRef.current)
            return;
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        }
        catch {
            return;
        }
        movedRef.current = false;
        gestureRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startLeft: point.left,
            startTop: point.top,
            active: false,
        };
    };

    const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId)
            return;
        const deltaX = event.clientX - gesture.startClientX;
        const deltaY = event.clientY - gesture.startClientY;
        if (!gesture.active && !passedThreshold(deltaX, deltaY))
            return;
        gesture.active = true;
        movedRef.current = true;
        const snapped = snapToBounds({ left: gesture.startLeft + deltaX, top: gesture.startTop + deltaY }, bounds);
        setDrag({ point: snapped.position, edgeX: snapped.edgeX, edgeY: snapped.edgeY });
    };

    const onPointerUp = (event: ReactPointerEvent<HTMLElement>) => {
        const gesture = gestureRef.current;
        if (!gesture || gesture.pointerId !== event.pointerId)
            return;
        const final = drag;
        abort();
        if (gesture.active && final)
            commit(final.point);
    };

    useEffect(() => {
        if (!drag)
            return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape')
                abort();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [drag]);

    if (folded)
        return (<button type="button" data-outline-circle aria-label={t('outline.expand_panel')} onClick={() => {
                if (movedRef.current) {
                    movedRef.current = false;
                    return;
                }
                setExpanded(true);
            }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={abort} onLostPointerCapture={abort} className="absolute z-20 flex cursor-grab touch-none select-none items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-quaternary)] shadow-lg transition-colors hover:text-[var(--accent)] active:cursor-grabbing" style={{ left: point.left, top: point.top, width: CIRCLE_SIZE, height: CIRCLE_SIZE }}>
          <ListTree size={14} aria-hidden="true"/>
        </button>);

    return (<div className="absolute z-20 flex flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-lg" data-outline-floating style={{ left: point.left, top: point.top, width: OUTLINE_FLOAT_WIDTH, height }}>
      <div className="flex shrink-0 items-center gap-1 rounded-t-[var(--r-lg)] border-b border-[var(--border-subtle)] px-1.5 py-1">
        {/* The grip owns pointer capture: a handle that captured the pointer would retarget the
            click of every button in this row away from itself, and they would never fire. */}
        <div className="flex min-w-0 flex-1 cursor-grab touch-none select-none items-center gap-1 active:cursor-grabbing" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={abort} onLostPointerCapture={abort} onDoubleClick={() => setLayout({ outlineFloatingPosition: DEFAULT_RATIO })}>
          <GripHorizontal size={11} aria-hidden="true" className="text-[var(--text-quaternary)]"/>
          <span className="min-w-0 flex-1 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('outline.drag_hint')}</span>
        </div>
        {CORNERS.map((corner) => (<Tooltip key={corner.id} label={t(CORNER_LABEL[corner.id])} side="bottom">
            <button type="button" aria-label={t(CORNER_LABEL[corner.id])} aria-pressed={activeCorner === corner.id} onClick={() => setLayout({ outlineFloatingPosition: { x: corner.x, y: corner.y } })} className={`shrink-0 rounded-[var(--r-sm)] p-0.5 transition-colors hover:bg-[var(--bg-hover)] ${activeCorner === corner.id ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)] hover:text-[var(--text-primary)]'}`}>
              <span aria-hidden="true" className="relative block h-2.5 w-2.5 rounded-[2px] border border-current">
                <span className={`absolute h-1 w-1 rounded-full bg-current ${CORNER_DOT[corner.id]}`}/>
              </span>
            </button>
          </Tooltip>))}
        <Tooltip label={t('outline.reset_position')} side="bottom">
          <button type="button" aria-label={t('outline.reset_position')} onClick={() => setLayout({ outlineFloatingPosition: DEFAULT_RATIO })} className="shrink-0 rounded-[var(--r-sm)] p-0.5 text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <RotateCcw size={10}/>
          </button>
        </Tooltip>
        {collapsible && (<Tooltip label={t('outline.collapse_panel')} side="bottom">
            <button type="button" aria-label={t('outline.collapse_panel')} onClick={() => setExpanded(false)} className="shrink-0 rounded-[var(--r-sm)] p-0.5 text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
              <Minus size={10}/>
            </button>
          </Tooltip>)}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Outline headings={headings} onSelect={onSelect} scrollerRef={scrollerRef} noteId={noteId} defaultLevel={defaultLevel} showProgress={showProgress} keepSearch={keepSearch} activeOverride={activeOverride} content={content} onContentChange={onContentChange} dragEdits={dragEdits} autoExpand={autoExpand} tooltipSide={tooltipSide} truncateLength={truncateLength} markdownLabels={markdownLabels} showReadingTime={showReadingTime} readingSpeed={readingSpeed} wordCount={wordCount} hoverPeek={hoverPeek} textDirection={textDirection} className="h-full max-h-full w-full py-2 pr-2"/>
      </div>
      {drag?.edgeX && <span aria-hidden="true" className={cnGuide('vertical', drag.edgeX)}/>}
      {drag?.edgeY && <span aria-hidden="true" className={cnGuide('horizontal', drag.edgeY)}/>}
    </div>);
}

function cnGuide(axis: 'vertical' | 'horizontal', edge: 'min' | 'max'): string {
    const accent = 'pointer-events-none absolute bg-[var(--accent)]';
    if (axis === 'vertical')
        return `${accent} inset-y-0 w-0.5 ${edge === 'min' ? 'left-0' : 'right-0'}`;
    return `${accent} inset-x-0 h-0.5 ${edge === 'min' ? 'top-0' : 'bottom-0'}`;
}
