import { useRef, useState } from 'react';
import { Ban, CircleSlash, Check, Palette } from 'lucide-react';
import { ORGANIZER_COLORS, ORGANIZER_COLOR_MESSAGE_KEYS, organizerColorContrast } from '@shared/organizer-colors';
import type { MessageKey } from '../../lib/i18n';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';
import { normalizeHexColor } from '../../editor/text-format';
import { colorContrast, pushRecentColor, useRecentColors } from '../../lib/format-colors';
import { ACCENT_COLOR_TOKEN, propertyColorCss, propertySwatchCss } from '@shared/property-style';

const PILL_PANEL_WIDTH = 226;

export function propertyColorName(stored: string): string {
    if (stored === ACCENT_COLOR_TOKEN)
        return t('properties.color_accent');
    const key = (ORGANIZER_COLOR_MESSAGE_KEYS as Record<string, MessageKey | undefined>)[stored];
    return key ? t(key) : stored.toLocaleUpperCase();
}

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

function Swatch({ color, active, onPick }: {
    color: string;
    active: boolean;
    onPick: (color: string) => void;
}) {
    const name = propertyColorName(color);
    return (<button type="button" aria-label={name} title={name} aria-pressed={active} onMouseDown={event => event.preventDefault()} onClick={() => onPick(color)} className={cn('flex size-7 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] transition-transform hover:scale-110', active && 'ring-2 ring-[var(--accent-ring)] ring-offset-1 ring-offset-[var(--bg-overlay)]')} style={{ backgroundColor: propertySwatchCss(color) }}>
      {active && <Check size={13} className="text-[var(--text-primary)]" aria-hidden="true"/>}
    </button>);
}

export function PropertyColorPanel({ label, current, tinted, onPick }: {
    label: string;
    current: string | null;
    tinted: boolean;
    onPick: (color: string | null) => void;
}) {
    const panelRef = useRef<HTMLDivElement>(null);
    const committed = useRef(false);
    const [draft, setDraft] = useState('');
    const [refused, setRefused] = useState(false);
    const recent = useRecentColors().text.filter(color => !ORGANIZER_COLORS.includes(color as (typeof ORGANIZER_COLORS)[number]));
    const shown = normalizeHexColor(draft) ?? current;
    const surface = paintedSurface(panelRef.current);
    const ratio = shown === null || !surface ? null : colorContrast(shown, surface);
    const pick = (color: string) => {
        if (committed.current)
            return;
        committed.current = true;
        if (color !== ACCENT_COLOR_TOKEN)
            pushRecentColor('text', color);
        onPick(color);
    };
    const offer = (value: string) => {
        const next = normalizeHexColor(value);
        if (next === null) {
            setRefused(value.trim().length > 0);
            return;
        }
        const seen = organizerColorContrast(next, surface);
        if (seen !== null && seen < 3) {
            setRefused(true);
            setDraft(next);
            return;
        }
        setDraft(next);
        setRefused(false);
        pick(next);
    };
    const hint = refused
        ? t('color.contrast_too_low')
        : ratio === null
            ? t('workspace.color_custom_hint')
            : t('color.contrast_ratio_value0', { value0: ratio.toFixed(1) });
    return (<div ref={panelRef} className="p-1" style={{ width: PILL_PANEL_WIDTH }}>
      <div className="flex min-w-0 items-baseline justify-between gap-2 px-0.5 pt-0.5 pb-2">
        <span className="text-[12px] font-medium text-[var(--text-secondary)]">{label}</span>
        {shown && (<span className="flex min-w-0 items-center gap-1 text-[11px] text-[var(--text-quaternary)]">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tinted ? propertySwatchCss(shown) : propertyColorCss(shown) }} aria-hidden="true"/>
            <span className="truncate">{shown === ACCENT_COLOR_TOKEN ? t('properties.color_accent') : shown.toLocaleUpperCase()}</span>
          </span>)}
      </div>
      <div role="group" aria-label={label} className="grid grid-cols-6 gap-1.5 px-0.5 pb-1.5">
        <button type="button" aria-label={t('properties.color_accent')} title={t('properties.color_accent')} aria-pressed={shown === ACCENT_COLOR_TOKEN} onMouseDown={event => event.preventDefault()} onClick={() => pick(ACCENT_COLOR_TOKEN)} className={cn('flex size-7 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--accent-soft)] transition-transform hover:scale-110', shown === ACCENT_COLOR_TOKEN && 'ring-2 ring-[var(--accent-ring)] ring-offset-1 ring-offset-[var(--bg-overlay)]')}>
          {shown === ACCENT_COLOR_TOKEN && <Check size={13} className="text-[var(--text-primary)]" aria-hidden="true"/>}
        </button>
        {ORGANIZER_COLORS.map(color => <Swatch key={color} color={color} active={shown === color} onPick={pick}/>)}
      </div>
      {recent.length > 0 && (<>
          <div className="px-0.5 pb-1 text-[11px] font-medium text-[var(--text-tertiary)]">{t('workspace.recent_colors')}</div>
          <div role="group" aria-label={t('workspace.recent_colors')} className="grid grid-cols-6 gap-1.5 px-0.5 pb-1.5">
            {recent.map(color => <Swatch key={color} color={color} active={shown === color} onPick={pick}/>)}
          </div>
        </>)}
      <div role="separator" className="my-1.5 h-px bg-[var(--border-subtle)]"/>
      <div className="flex items-center gap-1.5">
        <label className="relative flex size-7 shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-[var(--border-subtle)] text-[var(--text-tertiary)] transition-colors hover:border-[var(--border-default)] hover:text-[var(--text-secondary)]">
          <Palette size={13} aria-hidden="true"/>
          <span className="sr-only">{t('color.custom')}</span>
          <input type="color" value={shown && shown !== ACCENT_COLOR_TOKEN ? shown : '#888888'} onChange={event => setDraft(event.target.value.toLocaleLowerCase())} onBlur={event => offer(event.target.value)} aria-label={t('color.custom')} className="absolute inset-0 size-full cursor-pointer opacity-0"/>
        </label>
        <input type="text" value={draft} onChange={event => setDraft(event.target.value)} onBlur={event => offer(event.target.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                }
            }} placeholder="#rrggbb" spellCheck={false} autoComplete="off" aria-label={t('workspace.color_custom_value')} className={cn('h-7 min-w-0 flex-1 rounded-[var(--r-sm)] border bg-[var(--bg-base)] px-2 font-mono text-[11.5px] uppercase text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)]', refused
            ? 'border-[var(--danger)]'
            : 'border-[var(--border-subtle)] focus:border-[var(--accent)]')}/>
      </div>
      <p className={cn('px-0.5 pt-1 text-[11px]', refused ? 'text-[var(--danger)]' : 'text-[var(--text-quaternary)]')}>{hint}</p>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <button type="button" onClick={() => onPick('none')} className="flex items-center gap-1.5 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]">
          <CircleSlash size={13} className="shrink-0 text-[var(--text-tertiary)]"/>
          <span className="truncate">{t('properties.color_none')}</span>
        </button>
        <button type="button" onClick={() => onPick(null)} className="flex items-center gap-1.5 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]">
          <Ban size={13} className="shrink-0 text-[var(--text-tertiary)]"/>
          <span className="truncate">{t('properties.color_default')}</span>
        </button>
      </div>
    </div>);
}
