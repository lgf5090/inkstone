import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { GripHorizontal, RotateCcw } from 'lucide-react';
import type { Heading } from '../../lib/markdown/renderer';
import { Tooltip } from '../../components/overlay';
import { t } from '../../lib/i18n';
import { useUi } from '../../store/ui';
import { Outline } from './Outline';
import {
    DEFAULT_RATIO,
    OUTLINE_FLOAT_WIDTH,
    clampToBounds,
    panelBounds,
    panelHeight,
    passedThreshold,
    resolvePosition,
    snapToBounds,
    toRatio,
    type PanelPoint,
    type SnappedEdge,
} from './outline-float';

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

export function FloatingOutline({ headings, onSelect, scrollerRef, noteId, defaultLevel, showProgress, keepSearch, activeOverride, content, onContentChange, dragEdits, autoExpand, tooltipSide, truncateLength, containerRef, }: {
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
    containerRef: RefObject<HTMLElement | null>;
}) {
    const stored = useUi((state) => state.outlineFloatingPosition);
    const setLayout = useUi((state) => state.setLayout);
    const [box, setBox] = useState({ width: 0, height: 0 });
    const [drag, setDrag] = useState<DragVisual | null>(null);
    const gestureRef = useRef<DragGesture | null>(null);

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
    const bounds = panelBounds(box.width, box.height, OUTLINE_FLOAT_WIDTH, height);
    const resting = resolvePosition(stored ?? DEFAULT_RATIO, bounds);
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

    return (<div className="absolute z-20 flex flex-col rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] shadow-lg" data-outline-floating style={{ left: point.left, top: point.top, width: OUTLINE_FLOAT_WIDTH, height }}>
      <div className="flex shrink-0 cursor-grab touch-none select-none items-center gap-1 rounded-t-[var(--r-lg)] border-b border-[var(--border-subtle)] px-1.5 py-1 active:cursor-grabbing" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={abort} onLostPointerCapture={abort} onDoubleClick={() => setLayout({ outlineFloatingPosition: DEFAULT_RATIO })}>
        <GripHorizontal size={11} aria-hidden="true" className="text-[var(--text-quaternary)]"/>
        <span className="min-w-0 flex-1 truncate text-[length:var(--text-10-5)] text-[var(--text-quaternary)]">{t('outline.drag_hint')}</span>
        <Tooltip label={t('outline.reset_position')} side="bottom">
          <button type="button" aria-label={t('outline.reset_position')} onClick={() => setLayout({ outlineFloatingPosition: DEFAULT_RATIO })} className="shrink-0 rounded-[var(--r-sm)] p-0.5 text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <RotateCcw size={10}/>
          </button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Outline headings={headings} onSelect={onSelect} scrollerRef={scrollerRef} noteId={noteId} defaultLevel={defaultLevel} showProgress={showProgress} keepSearch={keepSearch} activeOverride={activeOverride} content={content} onContentChange={onContentChange} dragEdits={dragEdits} autoExpand={autoExpand} tooltipSide={tooltipSide} truncateLength={truncateLength} className="h-full max-h-full w-full py-2 pr-2"/>
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
