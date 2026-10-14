import { useRef, useState } from 'react';
import { Ban, CircleSlash } from 'lucide-react';
import { ORGANIZER_COLORS, ORGANIZER_COLOR_MIN_CONTRAST, isOrganizerColor, organizerColorContrast, organizerColorLabel } from '@shared/organizer-colors';
import { t } from '../../lib/i18n';
import { cn } from '../../lib/cn';
import { normalizeHexColor } from '../../editor/text-format';
import { paintedSurface, pushRecentColor, useRecentColors } from '../../lib/format-colors';
import { ACCENT_COLOR_TOKEN, propertyColorCss, propertySwatchCss } from '@shared/property-style';
import { Swatch } from '../../components/color-swatch';
import { ColorWheelTrigger } from '../../components/color-field';

const PILL_PANEL_WIDTH = 226;

function propertyColorName(stored: string): string {
    if (stored === ACCENT_COLOR_TOKEN)
        return t('properties.color_accent');
    return isOrganizerColor(stored) ? organizerColorLabel(stored, t) : stored.toLocaleUpperCase();
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
    const ratio = shown === null || !surface ? null : organizerColorContrast(shown, surface);
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
        if (seen !== null && seen < ORGANIZER_COLOR_MIN_CONTRAST) {
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
    return (<div ref={panelRef} className="rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)] outline-none" style={{ width: PILL_PANEL_WIDTH }} onClick={(event) => event.stopPropagation()}>
      <div className="flex min-w-0 items-baseline justify-between gap-2 px-0.5 pt-0.5 pb-2">
        <span className="text-[12px] font-medium text-[var(--text-secondary)]">{label}</span>
        {shown && (<span className="flex min-w-0 items-center gap-1 text-[11px] text-[var(--text-quaternary)]">
            <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: tinted ? propertySwatchCss(shown) : propertyColorCss(shown) }} aria-hidden="true"/>
            <span className="truncate">{shown === ACCENT_COLOR_TOKEN ? t('properties.color_accent') : shown.toLocaleUpperCase()}</span>
          </span>)}
      </div>
      <div role="group" aria-label={label} className="grid grid-cols-6 gap-1.5 px-0.5 pb-1.5">
        <Swatch color={ACCENT_COLOR_TOKEN} label={t('properties.color_accent')} active={shown === ACCENT_COLOR_TOKEN} variant="format" checkClassName="text-[var(--text-primary)]" className="bg-[var(--accent-soft)]" onPick={() => pick(ACCENT_COLOR_TOKEN)}/>
        {ORGANIZER_COLORS.map(color => <Swatch key={color} color={color} label={propertyColorName(color)} active={shown === color} background={propertySwatchCss(color)} variant="format" checkClassName="text-[var(--text-primary)]" onPick={() => pick(color)}/>)}
      </div>
      {recent.length > 0 && (<>
          <div className="px-0.5 pb-1 text-[11px] font-medium text-[var(--text-tertiary)]">{t('workspace.recent_colors')}</div>
          <div role="group" aria-label={t('workspace.recent_colors')} className="grid grid-cols-6 gap-1.5 px-0.5 pb-1.5">
            {recent.map(color => <Swatch key={color} color={color} label={propertyColorName(color)} active={shown === color} background={propertySwatchCss(color)} variant="format" checkClassName="text-[var(--text-primary)]" onPick={() => pick(color)}/>)}
          </div>
        </>)}
      <div role="separator" className="my-1.5 h-px bg-[var(--border-subtle)]"/>
      <div className="flex items-center gap-1.5">
        <ColorWheelTrigger label={t('color.custom')} value={shown && shown !== ACCENT_COLOR_TOKEN ? shown : null} onChange={setDraft} onCommit={offer}/>
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
