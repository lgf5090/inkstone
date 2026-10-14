import { Hash, Settings2 } from 'lucide-react';
import { ORGANIZER_COLORS, organizerColorLabel } from '@shared/organizer-colors';
import { t } from '../../lib/i18n';
import { Swatch } from '../../components/color-swatch';

export function TagColorMenu({ color, onSelectColor, onManageTags }: {
    color?: string | null;
    onSelectColor: (color: string | null) => void;
    onManageTags?: () => void;
}) {
    return (<div className="w-[214px] rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 shadow-[var(--shadow-pop)] outline-none" onClick={(event) => event.stopPropagation()}>
      <div className="px-1 pt-0.5 pb-2 text-[length:var(--text-12)] font-medium text-[var(--text-secondary)]">{t('tags.color')}</div>
      <div className="grid grid-cols-6 gap-1.5 px-0.5">
        <Swatch color={null} label={t('tags.clear_color')} active={!color} onPick={() => onSelectColor(null)} icon={<Hash size={13}/>}/>
        {ORGANIZER_COLORS.map((value) => (<Swatch key={value} color={value} label={organizerColorLabel(value, t)} active={color === value} background={value} onPick={() => onSelectColor(value)}/>))}
      </div>
      {onManageTags && (<>
          <div role="separator" className="my-2 h-px bg-[var(--border-subtle)]"/>
          <button type="button" onClick={onManageTags} className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-left text-[length:var(--text-12-5)] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]">
            <Settings2 size={13} className="shrink-0 text-[var(--text-tertiary)]"/>
            <span className="truncate">{t('tags.manage')}</span>
          </button>
        </>)}
    </div>);
}
