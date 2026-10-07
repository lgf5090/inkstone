import { useRef } from 'react';
import { FolderClosed, Tags } from 'lucide-react';
import type { SidebarTab } from '@shared/types';
import { SIDEBAR_TABS } from '@shared/constants';
import { cn } from '../../lib/cn';
import { t, type MessageKey } from '../../lib/i18n';
import { useUi } from '../../store/ui';

interface TabSpec {
    id: SidebarTab;
    labelKey: MessageKey;
    icon: React.ReactNode;
}

export const SIDEBAR_PANEL_ID = 'sidebar-panel'

export function tabId(tab: SidebarTab): string {
    return `sidebar-tab-${tab}`;
}

/**
 * The strip's own order and set. `SIDEBAR_TABS` stays the authority for what is a legal
 * stored value, so a tab dropped from here still loads into the default rather than into
 * a blank body.
 */
const TAB_SPECS: TabSpec[] = [
    { id: 'library', labelKey: 'sidebar.tab_library', icon: <FolderClosed size={14}/> },
    { id: 'tags', labelKey: 'sidebar.tab_tags', icon: <Tags size={14}/> },
];

/** What the strip actually offers; the store's `SIDEBAR_TABS` is the wider legal-value set. */
export const SIDEBAR_TAB_IDS: SidebarTab[] = TAB_SPECS.map((spec) => spec.id);

export function SidebarTabStrip() {
    const active = useUi((s) => s.sidebarTab);
    const select = useUi((s) => s.setSidebarTab);
    const ref = useRef<HTMLDivElement>(null);

    const focusIndex = (index: number) => {
        const tabs = ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [];
        const target = tabs[(index + tabs.length) % tabs.length];
        if (!target)
            return;
        target.focus();
        const id = SIDEBAR_TABS.find((tab) => tab === target.dataset.tab);
        if (id)
            select(id);
    };

    const positionOf = () => {
        const tabs = [...ref.current?.querySelectorAll('[role="tab"]') ?? []];
        const focused = tabs.findIndex((tab) => tab === document.activeElement);
        return focused >= 0 ? focused : TAB_SPECS.findIndex((spec) => spec.id === active);
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        const at = positionOf();
        if (event.key === 'ArrowRight')
            focusIndex(at + 1);
        else if (event.key === 'ArrowLeft')
            focusIndex(at - 1);
        else if (event.key === 'Home')
            focusIndex(0);
        else if (event.key === 'End')
            focusIndex(TAB_SPECS.length - 1);
        else
            return;
        event.preventDefault();
    };

    return (<div ref={ref} role="tablist" aria-label={t('sidebar.tabs_aria')} onKeyDown={onKeyDown} className="flex shrink-0 items-center gap-0.5 border-b border-[var(--border-subtle)] px-1.5 py-1">
      {TAB_SPECS.map((spec) => {
        const label = t(spec.labelKey);
        const selected = spec.id === active;
        return (<button key={spec.id} type="button" role="tab" id={tabId(spec.id)} data-tab={spec.id} aria-selected={selected} aria-controls={SIDEBAR_PANEL_ID} tabIndex={selected ? 0 : -1} title={label} onClick={() => select(spec.id)} className={cn('flex size-6 shrink-0 items-center justify-center rounded-[var(--r-sm)] transition-colors', selected
            ? 'bg-[var(--bg-active)] text-[var(--text-primary)]'
            : 'text-[var(--text-quaternary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]')}>
            <span className="sr-only">{label}</span>
            {spec.icon}
          </button>);
      })}
    </div>);
}
