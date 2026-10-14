import { useRef, useState } from 'react';
import { Ban } from 'lucide-react';
import { isOrganizerColor, organizerColorContrast, organizerColorLabel } from '@shared/organizer-colors';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';
import { normalizeHexColor } from '../../editor/text-format';
import {
    type ColorKind,
    isColorUsable,
    paintedSurface,
    paletteOf,
    pushRecentColor,
    swatchColor,
    useRecentColors,
} from '../../lib/format-colors';
import { Swatch } from '../../components/color-swatch';
import { ColorWheelTrigger } from '../../components/color-field';

const PANEL_WIDTH = 226;

function colorName(kind: ColorKind, color: string): string {
    return kind === 'text' && isOrganizerColor(color) ? organizerColorLabel(color, t) : color.toLocaleUpperCase();
}

export function EditorColorPanel({ kind, current, onPick }: {
    kind: ColorKind;
    /** What the button already stands for, so reopening the panel points at it rather than at nothing. */
    current?: string | null;
    onPick: (color: string | null) => void;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    const committed = useRef(false);
    const [draft, setDraft] = useState('');
    const [refused, setRefused] = useState(false);
    const recent = useRecentColors()[kind].filter(color => !paletteOf(kind).includes(color));
    const shown = normalizeHexColor(draft) ?? current ?? null;
    const ratio = shown === null ? null : organizerColorContrast(shown, paintedSurface(panelRef.current));
    const pick = (color: string) => {
        // One commit per appearance. Committing closes the panel, and tearing a focused field down
        // fires its blur — a second offer of the half-typed value would land on top of this pick.
        if (committed.current)
            return;
        committed.current = true;
        pushRecentColor(kind, color);
        onPick(color);
    };
    const offer = (value: string) => {
        const next = normalizeHexColor(value);
        if (next === null) {
            setRefused(value.trim().length > 0);
            return;
        }
        setDraft(next);
        if (!isColorUsable(kind, next, paintedSurface(panelRef.current))) {
            setRefused(true);
            return;
        }
        setRefused(false);
        pick(next);
    };
    const hint = refused
        ? (shown === null ? t('workspace.color_custom_hint') : t('color.contrast_too_low'))
        : ratio === null
            ? t('workspace.color_custom_hint')
            : t('color.contrast_ratio_value0', { value0: ratio.toFixed(1) });
    return (<div ref={panelRef} className="p-1" style={{ width: PANEL_WIDTH }}>
      <div className="flex min-w-0 items-baseline justify-between gap-2 px-0.5 pt-0.5 pb-2">
        <span className="text-[12px] font-medium text-[var(--text-secondary)]">{t(kind === 'text' ? 'workspace.text_color' : 'workspace.highlight_color')}</span>
        {shown && (<span className="flex min-w-0 items-center gap-1 text-[11px] text-[var(--text-quaternary)]">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: swatchColor(kind, shown) }} aria-hidden="true"/>
            <span className="truncate">{shown.toLocaleUpperCase()}</span>
          </span>)}
      </div>
      <div role="group" aria-label={t('workspace.color_palette')} className="grid grid-cols-6 gap-1.5 px-0.5">
        {paletteOf(kind).map(color => <Swatch key={color} color={color} label={colorName(kind, color)} active={shown === color} background={swatchColor(kind, color)} variant="format" checkClassName={kind === 'text' ? 'text-white' : 'text-[var(--text-primary)]'} onPick={() => pick(color)}/>)}
      </div>
      {recent.length > 0 && (<>
          <div role="separator" className="my-2 h-px bg-[var(--border-subtle)]"/>
          <div className="px-0.5 pb-1.5 text-[11px] font-medium text-[var(--text-tertiary)]">{t('workspace.recent_colors')}</div>
          <div role="group" aria-label={t('workspace.recent_colors')} className="grid grid-cols-6 gap-1.5 px-0.5">
            {recent.map(color => <Swatch key={color} color={color} label={colorName(kind, color)} active={shown === color} background={swatchColor(kind, color)} variant="format" checkClassName={kind === 'text' ? 'text-white' : 'text-[var(--text-primary)]'} onPick={() => pick(color)}/>)}
          </div>
        </>)}
      <div role="separator" className="my-2 h-px bg-[var(--border-subtle)]"/>
      <div className="flex items-center gap-1.5">
        <ColorWheelTrigger label={t('color.custom')} value={shown} onChange={setDraft} onCommit={offer}/>
        <input type="text" value={draft} onChange={event => setDraft(event.target.value)} onBlur={event => offer(event.target.value)} onKeyDown={(event) => {
                // Enter hands the field over rather than offering itself: the panel is about to
                // unmount, and a second offer of the same colour would read as the toggle-off.
                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                }
            }} placeholder="#rrggbb" spellCheck={false} autoComplete="off" aria-label={t('workspace.color_custom_value')} className={cn('h-7 min-w-0 flex-1 rounded-[var(--r-sm)] border bg-[var(--bg-base)] px-2 font-mono text-[11.5px] uppercase text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]', refused
                ? 'border-[var(--danger)]'
                : 'border-[var(--border-subtle)] focus:border-[var(--accent)]')}/>
      </div>
      <p className={cn('px-0.5 pt-1 text-[11px]', refused ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]')}>{hint}</p>
      <button type="button" onClick={() => onPick(null)} className="mt-1.5 flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]">
        <Ban size={13} className="shrink-0 text-[var(--text-tertiary)]"/>
        <span className="truncate">{t('workspace.clear_color')}</span>
      </button>
    </div>);
}
