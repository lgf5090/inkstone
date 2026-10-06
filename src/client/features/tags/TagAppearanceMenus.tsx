import { Check, Hash, Settings2 } from 'lucide-react';
import { ORGANIZER_COLORS, organizerColorLabel } from '@shared/organizer-colors';
import { cn } from '../../lib/cn';
import { t } from '../../lib/i18n';

const SWATCH_SIZE = 'size-7';

export function TagColorMenu({ color, onSelectColor, onManageTags }: {
    color?: string | null;
    onSelectColor: (color: string | null) => void;
    onManageTags?: () => void;
}) {
    return (<div className="w-[214px] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)] outline-none" onClick={(event) => event.stopPropagation()}>
      <div className="px-1 pt-0.5 pb-2 text-[12px] font-medium text-[var(--text-secondary)]">{t('tags.color')}</div>
      <div className="grid grid-cols-6 gap-1.5 px-0.5">
        <button type="button" aria-label={t('tags.clear_color')} title={t('tags.clear_color')} aria-pressed={!color} onClick={() => onSelectColor(null)} className={cn('flex', SWATCH_SIZE, 'items-center justify-center rounded-full border bg-[var(--bg-base)] transition-transform hover:scale-110', !color
                ? 'border-[var(--accent)] text-[var(--accent)] ring-2 ring-[var(--accent-ring)]'
                : 'border-[var(--border-default)] text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]')}>
          <Hash size={13}/>
        </button>
        {ORGANIZER_COLORS.map((value) => (<button key={value} type="button" aria-label={organizerColorLabel(value, t)} title={organizerColorLabel(value, t)} aria-pressed={color === value} onClick={() => onSelectColor(value)} className={cn('flex', SWATCH_SIZE, 'items-center justify-center rounded-full transition-transform hover:scale-110', color === value && 'ring-2 ring-[var(--accent-ring)] ring-offset-2 ring-offset-[var(--bg-overlay)]')} style={{ backgroundColor: value }}>
              {color === value && <Check size={13} className="text-white"/>}
            </button>))}
      </div>
      {onManageTags && (<>
          <div role="separator" className="my-2 h-px bg-[var(--border-subtle)]"/>
          <button type="button" onClick={onManageTags} className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[12.5px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]">
            <Settings2 size={13} className="shrink-0 text-[var(--text-tertiary)]"/>
            <span className="truncate">{t('tags.manage')}</span>
          </button>
        </>)}
    </div>);
}
