import { useState } from 'react';
import { Check, FolderClosed, Settings2, Smile } from 'lucide-react';
import { ORGANIZER_COLORS, organizerColorLabel } from '@shared/organizer-colors';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';

export const FOLDER_ICON_CHOICES = [
    '📁', '📚', '💼', '🧠', '💡', '🎯',
    '🗂️', '✨', '🚀', '📝', '📌', '🏷️',
    '⭐', '🔥', '☕', '🎨', '📦', '🛠️'
] as const;

const SWATCH_SIZE = 'size-7';

function MenuPanel({ label, children }: {
    label: string;
    children: React.ReactNode;
}) {
    return (<div className="w-[214px] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)] outline-none" onClick={(event) => event.stopPropagation()}>
      <div className="px-1 pt-0.5 pb-2 text-[12px] font-medium text-[var(--text-secondary)]">{label}</div>
      {children}
    </div>);
}

function SwatchButton({ active, label, color, onPick, children }: {
    active: boolean;
    label: string;
    color: string | null;
    onPick: () => void;
    children: React.ReactNode;
}) {
    return (<button type="button" aria-label={label} title={label} aria-pressed={active} onClick={onPick} className={cn('flex', SWATCH_SIZE, 'items-center justify-center rounded-full transition-transform hover:scale-110', color === null && 'border bg-[var(--bg-base)]', active
            ? color === null
                ? 'border-[var(--accent)] text-[var(--accent)] ring-2 ring-[var(--accent-ring)]'
                : 'ring-2 ring-[var(--accent-ring)] ring-offset-2 ring-offset-[var(--bg-overlay)]'
            : color === null && 'border-[var(--border-default)] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]')} style={color ? { backgroundColor: color } : undefined}>
      {children}
    </button>);
}

export function FolderColorMenu({ color, onSelectColor, onManageFolders }: {
    color?: string | null;
    onSelectColor: (color: string | null) => void;
    onManageFolders?: () => void;
}) {
    const label = t("folders.color");
    return (<MenuPanel label={label}>
      <div className="grid grid-cols-6 gap-1.5 px-0.5">
        <SwatchButton active={!color} label={t("folders.no_color")} color={null} onPick={() => onSelectColor(null)}>
          <FolderClosed size={13}/>
        </SwatchButton>
        {ORGANIZER_COLORS.map((value) => (<SwatchButton key={value} active={color === value} label={organizerColorLabel(value, t)} color={value} onPick={() => onSelectColor(value)}>
            {color === value && <Check size={13} className="text-white"/>}
          </SwatchButton>))}
      </div>
      {onManageFolders && (<>
          <div role="separator" className="my-2 h-px bg-[var(--border-subtle)]"/>
          <button type="button" onClick={onManageFolders} className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]">
            <Settings2 size={13} className="shrink-0 text-[var(--text-tertiary)]"/>
            <span className="truncate">{t("folders.manage_folders")}</span>
          </button>
        </>)}
    </MenuPanel>);
}

function firstGrapheme(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    const segmented = typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function'
        ? null
        : Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed), (part) => part.segment);
    return (segmented?.[0] ?? Array.from(trimmed)[0]) ?? null;
}

export function FolderIconMenu({ icon, onSelectIcon }: {
    icon?: string | null;
    onSelectIcon: (icon: string | null, source: 'grid' | 'custom') => void;
}) {
    const label = t("folders.icon");
    const [custom, setCustom] = useState('');
    const pickCustom = (value: string) => {
        const grapheme = firstGrapheme(value);
        setCustom('');
        if (grapheme)
            onSelectIcon(grapheme, 'custom');
    };
    return (<MenuPanel label={label}>
      <div className="grid grid-cols-6 gap-1.5 px-0.5">
        <button type="button" aria-label={t("folders.no_icon")} title={t("folders.no_icon")} aria-pressed={!icon} onClick={() => onSelectIcon(null, 'grid')} className={cn('flex', SWATCH_SIZE, 'items-center justify-center rounded-[var(--r-sm)] border bg-[var(--bg-base)] transition-transform hover:scale-110', !icon
            ? 'border-[var(--accent)] text-[var(--accent)] ring-2 ring-[var(--accent-ring)]'
            : 'border-[var(--border-default)] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]')}>
          <FolderClosed size={13}/>
        </button>
        {FOLDER_ICON_CHOICES.map((choice) => (<button key={choice} type="button" aria-label={choice} title={choice} aria-pressed={icon === choice} onClick={() => onSelectIcon(choice, 'grid')} className={cn('flex', SWATCH_SIZE, 'items-center justify-center rounded-[var(--r-sm)] border text-[14px] leading-none transition-transform hover:scale-110', icon === choice
            ? 'border-[var(--accent)] bg-[var(--accent-soft)] ring-2 ring-[var(--accent-ring)]'
            : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:border-[var(--border-default)]')}>
            {choice}
          </button>))}
      </div>
      <div role="separator" className="my-2 h-px bg-[var(--border-subtle)]"/>
      <form className="relative flex items-center" onSubmit={(event) => {
            event.preventDefault();
            pickCustom(custom);
        }}>
        <Smile size={13} aria-hidden="true" className="pointer-events-none absolute left-2 text-[var(--text-quaternary)]"/>
        <span className="sr-only">{t("folders.custom_icon_placeholder")}</span>
        <input type="text" value={custom} onChange={(event) => {
            setCustom(event.target.value);
            pickCustom(event.target.value);
        }} placeholder={t("folders.custom_icon_placeholder")} aria-label={t("folders.custom_icon_placeholder")} className="h-7 w-full rounded-[var(--r-sm)] border border-[var(--border-subtle)] bg-[var(--bg-base)] pr-2 pl-6 text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)]"/>
      </form>
    </MenuPanel>);
}
