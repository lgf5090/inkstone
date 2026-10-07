import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronDown } from 'lucide-react';
import type { DateRangeFilter } from '@shared/types';
import { cn } from '../../lib/cn';
import { localizedParams, t, useLocale, useLocaleResources } from '../../lib/i18n';
import { useNow } from '../../lib/hooks';
import { weekStartFor } from '../../lib/time';
import { useNotes } from '../../store/notes';
import { useUi } from '../../store/ui';
import { ActivityCalendarMemo } from '../../components/activity-calendar';
import { buildActivityProjectionCached } from '../../lib/calendar-activity';
import { useYearGridColumns } from '../../lib/year-grid-prefs';
import { CalendarView, loadCalendarPersist, saveCalendarPersist } from './calendar-persist';
import { createDiaryNote } from './diary-note';

function useCalendarPersist() {
    const calendarJump = useUi((s) => s.calendarJump);
    const [persisted] = useState(loadCalendarPersist);
    const [collapsed, setCollapsed] = useState(persisted.collapsed);
    const [view, setView] = useState<CalendarView>(persisted.view);
    const [cursor, setCursor] = useState(() => {
        const now = new Date();
        return { year: now.getFullYear(), month: now.getMonth() };
    });
    useEffect(() => {
        saveCalendarPersist({ collapsed, view });
    }, [collapsed, view]);
    useEffect(() => {
        if (!calendarJump)
            return;
        setView('month');
        setCursor({ year: calendarJump.year, month: calendarJump.month });
        useUi.getState().consumeCalendarJump(calendarJump.nonce);
    }, [calendarJump]);
    return { collapsed, setCollapsed, view, setView, cursor, setCursor };
}

function SidebarCalendarHeader({ headerTitle, showTodayChip, collapsed, onToggle }: {
    headerTitle: string;
    showTodayChip: boolean;
    collapsed: boolean;
    onToggle: () => void;
}) {
    return (<div className="flex items-center gap-[var(--sp-1)] px-[var(--sp-0-5)]">
        <button type="button" aria-expanded={!collapsed} onClick={onToggle} className="flex min-w-0 items-center gap-[var(--sp-1)] rounded-[var(--r-sm)] px-[var(--sp-1)] py-[var(--sp-0-5)] text-left transition-colors hover:bg-[var(--bg-hover)]">
            <CalendarDays size={12} className="shrink-0 text-[var(--text-quaternary)]"/>
            <span className="truncate text-[length:var(--text-11)] font-semibold text-[var(--text-secondary)]">{headerTitle}</span>
            {showTodayChip && (<span className="shrink-0 rounded-full bg-[var(--accent-soft)] px-[var(--sp-1-5)] py-px text-[length:var(--text-9)] font-medium text-[var(--accent)]">{t('sidebar.calendar_today')}</span>)}
            <ChevronDown size={11} className={cn('shrink-0 text-[var(--text-quaternary)] transition-transform duration-[var(--dur-fast)]', collapsed && '-rotate-90')}/>
        </button>
    </div>);
}

interface CalendarBodyProps {
    locale: string;
    now: Date;
    view: CalendarView;
    setView: (view: CalendarView) => void;
    cursor: { year: number; month: number };
    setCursor: (cursor: { year: number; month: number }) => void;
}

// The whole-vault projection, the diary lookup and every click handler live here so
// that collapsing the block unmounts the derivation with it, and so an unrelated
// sidebar re-render cannot re-run the header's formatting.
function SidebarCalendarBody({ locale, now, view, setView, cursor, setCursor }: CalendarBodyProps) {
    const localeResources = useLocaleResources();
    const notes = useNotes((s) => s.notes);
    const openNote = useNotes((s) => s.openNote);
    const toast = useUi((s) => s.toast);
    const dateFilter = useUi((s) => s.dateFilter);
    const yearGridColumns = useYearGridColumns();
    const calendarJumpNonce = useUi((s) => s.calendarJump?.nonce ?? 0);
    const weekStart = weekStartFor(locale);
    const diaryTitle = useCallback((key: string) => t('sidebar.diary_title_value0', { value0: key }), []);
    const { counts, noteIdByTitle, notesByDay, latestEditKey } = useMemo(() => buildActivityProjectionCached(notes), [notes]);
    const getDiaryId = useCallback((key: string) => {
        // A diary keeps the title it was written under, so the lookup has to answer in
        // every shipped language: one per locale, current first.
        for (const title of localizedParams('sidebar.diary_title_value0', { value0: key })) {
            const id = noteIdByTitle.get(title);
            if (id)
                return id;
        }
        return null;
    }, [noteIdByTitle, localeResources]);
    const applyDateFilter = useCallback((range: DateRangeFilter | null) => {
        useUi.getState().setDateFilter(range);
    }, []);
    const handleDayClick = useCallback(async (key: string, diaryId: string | null) => {
        const current = useUi.getState().dateFilter;
        const isSameSingleDay = current !== null && current.start === key && current.end === key;
        applyDateFilter(isSameSingleDay ? null : { start: key, end: key });
        if (diaryId) {
            openNote(diaryId);
            toast({ title: t('sidebar.calendar_diary_opened_value0', { value0: key }), tone: 'success' });
            return;
        }
        await createDiaryNote(key, diaryTitle);
    }, [applyDateFilter, diaryTitle, openNote, toast]);
    const onDayClick = useCallback((key: string, diaryId: string | null) => {
        void handleDayClick(key, diaryId);
    }, [handleDayClick]);
    const onDaySelect = useCallback((key: string) => applyDateFilter({ start: key, end: key }), [applyDateFilter]);
    const onRangeSelect = useCallback((start: string, end: string) => applyDateFilter({ start, end }), [applyDateFilter]);
    const onGapDayClick = useCallback((key: string) => applyDateFilter({ start: key, end: key }), [applyDateFilter]);
    const onNoteClick = useCallback((noteId: string) => {
        openNote(noteId);
    }, [openNote]);
    return (<ActivityCalendarMemo counts={counts} notesByDay={notesByDay} getDiaryId={getDiaryId} locale={locale} weekStart={weekStart} today={now} selectedRange={dateFilter} latestEditKey={latestEditKey} view={view} onViewChange={setView} cursor={cursor} onCursorChange={setCursor} columnsPreference={yearGridColumns} jumpFlash={calendarJumpNonce} onDayClick={onDayClick} onDaySelect={onDaySelect} onRangeSelect={onRangeSelect} onGapDayClick={onGapDayClick} onNoteClick={onNoteClick}/>);
}

export function SidebarCalendar() {
    const locale = useLocale();
    const { collapsed, setCollapsed, view, setView, cursor, setCursor } = useCalendarPersist();
    const nowStamp = useNow();
    const now = useMemo(() => new Date(nowStamp), [nowStamp]);
    const isCurrentMonth = cursor.year === now.getFullYear() && cursor.month === now.getMonth();
    const showTodayChip = view === 'year' ? cursor.year === now.getFullYear() : isCurrentMonth;
    const monthTitle = useMemo(() => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(new Date(cursor.year, cursor.month, 1)), [cursor, locale]);
    const headerTitle = view === 'year' ? String(cursor.year) : monthTitle;
    return (<section aria-label={t('sidebar.calendar_title')} className="mb-[var(--sp-2-5)]">
        <SidebarCalendarHeader headerTitle={headerTitle} showTodayChip={showTodayChip} collapsed={collapsed} onToggle={() => setCollapsed((value) => !value)}/>
        {!collapsed && (<SidebarCalendarBody locale={locale} now={now} view={view} setView={setView} cursor={cursor} setCursor={setCursor}/>)}
    </section>);
}
