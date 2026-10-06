import { useSyncExternalStore } from 'react';

export const CALENDAR_PREFS_STORAGE_KEY = 'inkstone.calendar-tree-preferences.v1';

export interface CalendarTreePreferences {
    calendarVisible: boolean;
    todoVisible: boolean;
    inboxVisible: boolean;
    showEmptyPeriods: boolean;
}

const DEFAULT_PREFERENCES: CalendarTreePreferences = {
    calendarVisible: true,
    todoVisible: true,
    inboxVisible: true,
    showEmptyPeriods: false,
};

const listeners = new Set<() => void>();

function readStorage(): Storage | null {
    return typeof localStorage === 'undefined' ? null : localStorage;
}

function booleanPreference(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

export function loadCalendarPrefs(storage: Storage | null = readStorage()): CalendarTreePreferences {
    if (!storage)
        return { ...DEFAULT_PREFERENCES };
    try {
        const raw = storage.getItem(CALENDAR_PREFS_STORAGE_KEY);
        if (!raw)
            return { ...DEFAULT_PREFERENCES };
        const parsed = JSON.parse(raw) as Partial<CalendarTreePreferences>;
        return {
            calendarVisible: booleanPreference(parsed.calendarVisible, DEFAULT_PREFERENCES.calendarVisible),
            todoVisible: booleanPreference(parsed.todoVisible, DEFAULT_PREFERENCES.todoVisible),
            inboxVisible: booleanPreference(parsed.inboxVisible, DEFAULT_PREFERENCES.inboxVisible),
            showEmptyPeriods: booleanPreference(parsed.showEmptyPeriods, DEFAULT_PREFERENCES.showEmptyPeriods),
        };
    }
    catch {
        return { ...DEFAULT_PREFERENCES };
    }
}

let currentPreferences = loadCalendarPrefs();

export function saveCalendarPrefs(patch: Partial<CalendarTreePreferences>): void {
    currentPreferences = { ...currentPreferences, ...patch };
    const storage = readStorage();
    if (storage) {
        try {
            storage.setItem(CALENDAR_PREFS_STORAGE_KEY, JSON.stringify(currentPreferences));
        }
        catch {
        }
    }
    for (const listener of listeners)
        listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getSnapshot(): CalendarTreePreferences {
    return currentPreferences;
}

export function useCalendarTreePreferences(): CalendarTreePreferences {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
