import { lazy, memo, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BrainCircuit, Cloud, Database, Info, Keyboard, Link2, Palette, RefreshCw, Search, Type, UserRound, X, } from 'lucide-react';
import { ACCENTS } from '@shared/constants';
import { cn } from '../../lib/cn';
import { splitByRanges } from '../../lib/fuzzy';
import { Input } from '../../components/form';
import { Tooltip, useDialogFocus, useEscape, useLockScroll } from '../../components/overlay';
import { Button, IconButton } from '../../components/primitives';
import { SettingsLoading } from './SettingsLoading';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { AppearanceSettings } from './AppearanceSettings';
import { useUi } from '../../store/ui';
import { useSession } from '../../store/session';
import { useLocaleResources } from '../../lib/i18n';
import { UI_STORAGE_KEY } from '../../lib/runtime';
import { scheduleSettingsWarmup, settingsLoaders, warmSettingsSection, type SettingsSection } from './sections';
import { countBySection, searchSettings, type SettingsSearchHit } from './settingsSearch';
import { t } from "../../lib/i18n";
type Section = SettingsSection;
const AppearancePage = memo(AppearanceSettings);
export const SECTIONS: {
    id: Section;
    label: () => string;
    icon: React.ReactNode;
}[] = [
    { id: 'appearance', label: () => t("settings.appearance"), icon: <Palette size={14}/> },
    { id: 'editor', label: () => t("settings.editor"), icon: <Type size={14}/> },
    { id: 'backup', label: () => t("settings.backup"), icon: <Cloud size={14}/> },
    { id: 'sync', label: () => t("settings.sync"), icon: <RefreshCw size={14}/> },
    { id: 'mcp', label: () => t("settings.mcp"), icon: <BrainCircuit size={14}/> },
    { id: 'account', label: () => t("settings.account"), icon: <UserRound size={14}/> },
    { id: 'data', label: () => t("settings.data"), icon: <Database size={14}/> },
    { id: 'shares', label: () => t("share.shared_notes"), icon: <Link2 size={14}/> },
    { id: 'about', label: () => t("settings.about"), icon: <Info size={14}/> },
];
function HitTitle({ hit }: {
    hit: SettingsSearchHit;
}) {
    return <>
      {splitByRanges(hit.title, hit.ranges).map((part, index) => part.hit
        ? <mark key={index} className="rounded-[2px] bg-[var(--accent-softer)] font-semibold text-[var(--accent)]">{part.text}</mark>
        : <span key={index}>{part.text}</span>)}
    </>;
}
export function SettingsPanel({ onClose }: {
    onClose: () => void;
}) {
    const userId = useSession((s) => s.user?.id);
    const storageKey = `${UI_STORAGE_KEY}:settings-section:${userId ?? 'anonymous'}`;
    const [section, setSection] = useState<Section>(() => {
        try {
            const saved = localStorage.getItem(storageKey);
            return SECTIONS.find((item) => item.id === saved)?.id ?? 'appearance';
        } catch { return 'appearance'; }
    });
    const [visited, setVisited] = useState<Section[]>([section]);
    const selectSection = (next: Section) => {
        warmSettingsSection(next);
        setVisited((current) => current.includes(next) ? current : [...current, next]);
        setSection(next);
        try { localStorage.setItem(storageKey, next); } catch { }
    };
    const openPanel = useUi((s) => s.openPanel);
    const panelRef = useRef<HTMLDivElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const resultsRef = useRef<HTMLDivElement>(null);
    const [query, setQuery] = useState('');
    const [target, setTarget] = useState<{
        page: Section;
        title: string;
    } | null>(null);
    useLocaleResources();
    const searching = query.trim().length > 0;
    const hits = useMemo(() => searchSettings(query), [query]);
    const counts = useMemo(() => countBySection(hits), [hits]);
    const groups = useMemo(() => SECTIONS
      .map((item) => ({ item, rows: hits.filter((hit) => hit.entry.section === item.id) }))
      .filter((group) => group.rows.length > 0), [hits]);
    const titleId = useId();
    const clearSearch = () => {
        setQuery('');
        searchRef.current?.focus();
    };
    const openHit = (hit: SettingsSearchHit) => {
        setQuery('');
        setTarget({ page: hit.entry.section, title: hit.title });
        selectSection(hit.entry.section);
    };
    const focusResults = (step: 1 | -1) => {
        const nodes = [...resultsRef.current?.querySelectorAll<HTMLElement>('[data-settings-hit]') ?? []];
        if (!nodes.length)
            return false;
        const current = document.activeElement;
        const index = nodes.indexOf(current as HTMLElement);
        const next = step > 0
            ? nodes[index + 1] ?? nodes[0]
            : nodes[index - 1] ?? nodes[nodes.length - 1];
        next?.focus();
        return true;
    };
    useEscape(true, () => {
        if (searching)
            clearSearch();
        else
            onClose();
    });
    useLockScroll(true);
    useDialogFocus(true, panelRef);
    useEffect(() => { scheduleSettingsWarmup(0) }, []);
    useEffect(() => {
        if (!target)
            return;
        let timer = 0;
        let tries = 0;
        const attempt = () => {
            const page = panelRef.current?.querySelector<HTMLElement>(`[data-settings-page="${target.page}"]`);
            const row = page
                ? [...page.querySelectorAll<HTMLElement>('[data-setting-title]')]
                    .find((node) => node.dataset.settingTitle === target.title)
                : null;
            if (row) {
                row.scrollIntoView({ block: 'center', behavior: 'smooth' });
                row.dataset.settingsTarget = '';
                window.setTimeout(() => { delete row.dataset.settingsTarget; }, 1600);
                setTarget(null);
                return;
            }
            tries += 1;
            if (tries > 40) {
                setTarget(null);
                return;
            }
            timer = window.setTimeout(attempt, 80);
        };
        attempt();
        return () => window.clearTimeout(timer);
    }, [target]);
    return createPortal(<div className="app-viewport-fixed fixed z-[210] flex items-center justify-center md:p-8">
      <div className="anim-fade absolute inset-0 bg-[var(--scrim)]" onClick={onClose} aria-hidden="true"/>

      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            searchRef.current?.focus();
            searchRef.current?.select();
        }
      }} className="anim-pop relative flex h-full w-full max-w-[880px] flex-col overflow-hidden bg-[var(--bg-overlay)] pt-[env(safe-area-inset-top)] shadow-[var(--shadow-modal)] outline-none md:max-h-[720px] md:flex-row md:rounded-[var(--r-2xl)] md:border md:border-[var(--border-default)] md:pt-0">
        { }
        <nav className="flex w-full shrink-0 flex-col border-b border-[var(--border-subtle)] bg-[var(--bg-sunken)] p-2 md:w-[172px] md:border-r md:border-b-0">
          <div id={titleId} className="px-2 py-1.5 text-[13.5px] font-semibold tracking-[-0.012em] md:py-2.5">{t("common.settings")}</div>
          <div className="mb-2 md:mb-2.5">
            <Input ref={searchRef} type="text" value={query} spellCheck={false} autoComplete="off" placeholder={t("settings.search_placeholder")} aria-label={t("settings.search_placeholder")} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                  event.stopPropagation();
                  clearSearch();
                  return;
              }
              if (event.key === 'ArrowDown' || event.key === 'Enter') {
                  if (event.key === 'ArrowDown' && focusResults(1))
                      event.preventDefault();
                  else if (event.key === 'Enter' && hits[0]) {
                      event.preventDefault();
                      openHit(hits[0]);
                  }
              }
            }} leading={<Search size={13} aria-hidden="true" className="pointer-events-none"/>} trailing={searching
              ? <button type="button" aria-label={t("settings.search_clear")} onClick={clearSearch} className="flex size-4 items-center justify-center rounded-full text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
                  <X size={12} aria-hidden="true"/>
                </button>
              : null}/>
          </div>
          <div className="flex gap-1 overflow-x-auto pb-1 md:block md:space-y-px md:overflow-visible md:pb-0">
            {(searching ? SECTIONS.filter((item) => counts.has(item.id)) : SECTIONS).map((item) => (<button key={item.id} type="button" aria-current={section === item.id && !searching ? 'page' : undefined} onPointerEnter={() => warmSettingsSection(item.id)} onFocus={() => warmSettingsSection(item.id)} onClick={() => {
              setQuery('');
              selectSection(item.id);
            }} className={cn('flex h-10 shrink-0 items-center gap-2 rounded-[var(--r-md)] px-2.5 text-left text-[12.5px] md:h-[30px] md:w-full md:gap-2.5 md:px-2', 'transition-colors duration-[var(--dur-fast)]', section === item.id && !searching
                ? 'bg-[var(--accent-soft)] font-medium text-[var(--text-primary)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]')}>
                <span className={cn('shrink-0', section === item.id && !searching ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')}>
                  {item.icon}
                </span>
                {item.label()}
                {searching && <span className="ml-auto hidden shrink-0 text-[11px] tabular-nums text-[var(--text-quaternary)] md:inline">{counts.get(item.id)}</span>}
              </button>))}
            <button type="button" onClick={() => {
                onClose();
                openPanel('shortcuts');
            }} className="flex h-10 shrink-0 items-center gap-2.5 rounded-[var(--r-md)] px-2.5 text-left text-[12.5px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] md:hidden">
              <Keyboard size={14}/>{t("settings.keyboard_shortcuts")}
            </button>
          </div>

          <div className="flex-1"/>
          <button type="button" onClick={() => {
            onClose();
            openPanel('shortcuts');
        }} className="hidden h-[30px] w-full items-center gap-2.5 rounded-[var(--r-md)] px-2 text-left text-[12.5px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] md:flex">
            <Keyboard size={14}/>{t("settings.keyboard_shortcuts")}</button>
        </nav>

        { }
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-4 md:px-5">
            <h2 className="text-[14px] font-semibold tracking-[-0.012em]">
              {searching ? t("settings.search_results") : SECTIONS.find((s) => s.id === section)?.label()}
            </h2>
            <Tooltip label={t("common.close")} combo="escape" side="left">
              <IconButton label={t("common.close")} size="sm" onClick={onClose}>
                <X size={15}/>
              </IconButton>
            </Tooltip>
          </header>

          {searching && <div ref={resultsRef} aria-label={t("settings.search_results")} onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (focusResults(event.key === 'ArrowDown' ? 1 : -1))
                    event.preventDefault();
            }
            else if (event.key === 'ArrowLeft') {
                event.preventDefault();
                searchRef.current?.focus();
            }
          }} className="min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-[calc(16px+env(safe-area-inset-bottom))] md:px-5 md:py-4">
            {hits.length === 0
              ? <p className="py-10 text-center text-[12.5px] text-[var(--text-tertiary)]">{t("settings.search_no_results")}</p>
              : <>
                  <p className="mb-3 text-[11.5px] text-[var(--text-quaternary)]">{t("settings.search_found", { count: hits.length })}</p>
                  {groups.map((group) => (<section key={group.item.id} className="mb-4 last:mb-0">
                      <h3 className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
                        <span className="shrink-0">{group.item.icon}</span>
                        {group.item.label()}
                      </h3>
                      {group.rows.map((hit) => (<button key={`${hit.entry.section}:${hit.entry.titleKey}`} type="button" data-settings-hit="" onClick={() => openHit(hit)} className="flex w-full items-start gap-3 rounded-[var(--r-md)] px-2.5 py-2 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] focus-visible:outline-none">
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-medium text-[var(--text-primary)]">
                              <HitTitle hit={hit}/>
                            </span>
                            {hit.detail && <span className="mt-0.5 block truncate text-[11.5px] text-[var(--text-tertiary)]">{hit.detail}</span>}
                          </span>
                        </button>))}
                    </section>))}
                </>}
          </div>}

          {visited.map((page) => (<div key={page} data-settings-page={page} hidden={page !== section || searching} inert={page !== section || searching} aria-hidden={page !== section || searching} className={cn('min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-[calc(16px+env(safe-area-inset-bottom))] md:px-5 md:py-4', (page !== section || searching) && 'hidden')}>
            {page === 'appearance' ? <AppearancePage accents={ACCENTS}/> : <SettingsPage section={page}/>}
          </div>))}
        </div>
      </div>
    </div>, document.body);
}

export const SettingsPage = memo(function SettingsPage({ section }: { section: Exclude<Section, 'appearance'> }) {
    const [attempt, setAttempt] = useState(0);
    const Page = useMemo(() => lazy(settingsLoaders[section]), [section, attempt]);
    return (<ErrorBoundary key={attempt} fallback={<div role="alert" className="space-y-3 py-4 text-[12.5px] text-[var(--text-secondary)]">
      <p>{t('app.section_unavailable')}</p>
      <Button size="sm" onClick={() => setAttempt((current) => current + 1)}>{t('common.retry')}</Button>
    </div>}>
      <Suspense fallback={<SettingsLoading />}><Page /></Suspense>
    </ErrorBoundary>);
});
