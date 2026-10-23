import { useSyncExternalStore } from 'react';
import type { ShareTimelineRange } from '@shared/share-hub';

/**
 * The share hub's own reading preferences.
 *
 * They live here rather than in the account settings on purpose: all three change what *this* screen
 * shows — which links count as gone quiet, how often the numbers are re-read, which window a reading
 * opens on — and none of them changes what a visitor gets. A hub that opens in another tab reads the
 * same remembered answer because both halves read one key.
 */
export const SHARE_HUB_PREFS_STORAGE_KEY = 'inkstone.share-hub.preferences.v1';

/** Days without a read before the hub calls a link stale; 0 turns the report off. */
export const STALE_LINK_DAY_OPTIONS = [0, 30, 90, 180, 365] as const;
/** How often the hub re-reads its numbers, in ms; 0 leaves the reading as it loaded it. */
export const AUTO_REFRESH_MS_OPTIONS = [0, 45_000, 120_000, 300_000] as const;
/** The windows a timeline reading answers for, in the order the picker lists them. */
export const SHARE_TIMELINE_RANGES = ['24h', '7d', '30d', 'all'] as const;

export const DEFAULT_SHARE_HUB_PREFS = {
  staleLinkDays: 90 as number,
  autoRefreshMs: 45_000 as number,
  defaultRange: '30d' as ShareTimelineRange,
};

export interface ShareHubPreferences {
  staleLinkDays: number;
  autoRefreshMs: number;
  defaultRange: ShareTimelineRange;
}

const listeners = new Set<() => void>();

function readStorage(): Storage | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** A stored number trusted only if it is one the picker offers — anything else is the default. */
function listedNumber(value: unknown, options: readonly number[], fallback: number): number {
  return typeof value === 'number' && options.includes(value) ? value : fallback;
}

function listedRange(value: unknown, fallback: ShareTimelineRange): ShareTimelineRange {
  return typeof value === 'string' && (SHARE_TIMELINE_RANGES as readonly string[]).includes(value)
    ? value as ShareTimelineRange
    : fallback;
}

export function parseShareHubPrefs(raw: string | null): ShareHubPreferences {
  if (!raw) return { ...DEFAULT_SHARE_HUB_PREFS };
  let parsed: Partial<ShareHubPreferences> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<ShareHubPreferences>;
  }
  catch {
    // A corrupt or hand-edited entry falls back to the defaults below: the remembered preferences are
    // a convenience, and a panel that read nothing is a worse outcome than one reading defaults.
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SHARE_HUB_PREFS };
  return {
    staleLinkDays: listedNumber(parsed.staleLinkDays, STALE_LINK_DAY_OPTIONS, DEFAULT_SHARE_HUB_PREFS.staleLinkDays),
    autoRefreshMs: listedNumber(parsed.autoRefreshMs, AUTO_REFRESH_MS_OPTIONS, DEFAULT_SHARE_HUB_PREFS.autoRefreshMs),
    defaultRange: listedRange(parsed.defaultRange, DEFAULT_SHARE_HUB_PREFS.defaultRange),
  };
}

let currentPreferences = parseShareHubPrefs(readStorage()?.getItem(SHARE_HUB_PREFS_STORAGE_KEY) ?? null);

export function loadShareHubPrefs(): ShareHubPreferences {
  return currentPreferences;
}

export function saveShareHubPrefs(patch: Partial<ShareHubPreferences>): void {
  currentPreferences = { ...currentPreferences, ...patch };
  const storage = readStorage();
  if (storage) {
    // Persistence only: the value every reader gets is `currentPreferences`, replaced above, and the
    // listeners run whatever this write answers. A refused write costs the next load its remembered
    // settings, not the change the reader just made.
    try {
      storage.setItem(SHARE_HUB_PREFS_STORAGE_KEY, JSON.stringify(currentPreferences));
    }
    catch {
      // Storage full or unavailable; the in-memory preference above is what the app is already using.
    }
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useShareHubPrefs(): ShareHubPreferences {
  return useSyncExternalStore(subscribe, loadShareHubPrefs, loadShareHubPrefs);
}
