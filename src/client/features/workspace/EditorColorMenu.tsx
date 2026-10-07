import { useRef, useState } from 'react';
import { Ban, Check, Palette } from 'lucide-react';
import { ORGANIZER_COLOR_MESSAGE_KEYS } from '@shared/organizer-colors';
import { type MessageKey, t } from '../../lib/i18n';
import { cn } from '../../lib/cn';
import { normalizeHexColor } from '../../editor/text-format';
import {
    type ColorKind,
    colorContrast,
    isColorUsable,
    paletteOf,
    pushRecentColor,
    swatchColor,
    useRecentColors,
} from '../../lib/format-colors';

const PANEL_WIDTH = 226;

function colorName(kind: ColorKind, color: string): string {
    const key = (ORGANIZER_COLOR_MESSAGE_KEYS as Record<string, MessageKey | undefined>)[color];
    return key && kind === 'text' ? t(key) : color.toLocaleUpperCase();
}

/** The colour painted behind the panel, which is what a pick has to stand out from. */
function paintedSurface(node: HTMLElement | null): string {
    let current: HTMLElement | null = node;
    while (current) {
        const painted = getComputedStyle(current).backgroundColor;
        if (painted && painted !== 'transparent' && !/^rgba\([^)]*,\s*0\)$/.test(painted))
            return painted;
        current = current.parentElement;
    }
    return '';
}

function Swatch({ kind, color, active, onPick }: {
    kind: ColorKind;
    color: string;
    active: boolean;
    onPick: (color: string) => void;
}) {
    const name = colorName(kind, color);
    // Holding the field's focus down means a half-typed hex cannot commit underneath this click:
    // the swatch the user aimed at is the newer intent, and a blur here would apply the other one.
    return (<button type="button" aria-label={name} title={name} aria-pressed={active} onMouseDown={event => event.preventDefault()} onClick={() => onPick(color)} className={cn('flex size-7 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] transition-transform hover:scale-110', active && 'ring-2 ring-[var(--accent-ring)] ring-offset-1 ring-offset-[var(--bg-overlay)]')} style={{ backgroundColor: swatchColor(kind, color) }}>
      {active && <Check size={13} className={kind === 'text' ? 'text-white' : 'text-[var(--text-primary)]'} aria-hidden="true"/>}
    </button>);
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
    const ratio = shown === null ? null : colorContrast(shown, paintedSurface(panelRef.current));
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
        {paletteOf(kind).map(color => <Swatch key={color} kind={kind} color={color} active={shown === color} onPick={pick}/>)}
      </div>
      {recent.length > 0 && (<>
          <div role="separator" className="my-2 h-px bg-[var(--border-subtle)]"/>
          <div className="px-0.5 pb-1.5 text-[11px] font-medium text-[var(--text-tertiary)]">{t('workspace.recent_colors')}</div>
          <div role="group" aria-label={t('workspace.recent_colors')} className="grid grid-cols-6 gap-1.5 px-0.5">
            {recent.map(color => <Swatch key={color} kind={kind} color={color} active={shown === color} onPick={pick}/>)}
          </div>
        </>)}
      <div role="separator" className="my-2 h-px bg-[var(--border-subtle)]"/>
      <div className="flex items-center gap-1.5">
        <label className="relative flex size-7 shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] text-[var(--text-tertiary)] transition-colors hover:border-[var(--border-default)] hover:text-[var(--text-secondary)]">
          <Palette size={13} aria-hidden="true"/>
          <span className="sr-only">{t('color.custom')}</span>
          <input type="color" value={shown ?? '#888888'} onChange={event => setDraft(event.target.value.toLocaleLowerCase())} onBlur={event => offer(event.target.value)} aria-label={t('color.custom')} className="absolute inset-0 size-full cursor-pointer opacity-0"/>
        </label>
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
