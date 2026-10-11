import { create } from 'zustand';
import type { MindmapDocumentDirection } from '../../lib/markdown/mindmap';

export interface MindmapSettingsState {
  /** Folder a new file lands in when nothing else decided, by id or name. Empty means "where the reader is". */
  folder: string;
  /** Note whose body a new file starts from, by title or id. Empty means the library's empty map. */
  templateFilePath: string;
  filenamePrefix: string;
  filenameDateFormat: string;
  useElixirExtension: boolean;
  autoSaveIntervalMs: number;
  /** Following a link from a map opens the note beside it rather than over the map. */
  openInAdjacentPane: boolean;
  defaultDirection: MindmapDocumentDirection;
  compact: boolean;
  updateSettings: (partial: Partial<Omit<MindmapSettingsState, 'updateSettings' | 'resetSettings'>>) => void;
  resetSettings: () => void;
}

const STORAGE_KEY = 'inkstone:mindmap-settings';

const DEFAULT_SETTINGS = {
  folder: '',
  templateFilePath: '',
  filenamePrefix: 'Mindmap ',
  filenameDateFormat: 'YYYY-MM-DD HH.mm.ss',
  useElixirExtension: true,
  autoSaveIntervalMs: 600,
  openInAdjacentPane: true,
  defaultDirection: 2 as MindmapDocumentDirection,
  compact: false,
};

function sanitize(parsed: Record<string, unknown>): typeof DEFAULT_SETTINGS {
  const next = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]) {
    const value = parsed[key];
    if (value === undefined)
      continue;
    const fallback = DEFAULT_SETTINGS[key];
    // A stored value of the wrong shape is dropped rather than cast: the drawer reads
    // `direction` off the file without checking it again, and a string there draws NaN.
    if (typeof value === typeof fallback)
      (next as Record<string, unknown>)[key] = value;
  }
  if (![0, 1, 2, 3].includes(next.defaultDirection))
    next.defaultDirection = DEFAULT_SETTINGS.defaultDirection;
  if (!Number.isFinite(next.autoSaveIntervalMs) || next.autoSaveIntervalMs < 100)
    next.autoSaveIntervalMs = DEFAULT_SETTINGS.autoSaveIntervalMs;
  return next;
}

function loadInitialSettings(): typeof DEFAULT_SETTINGS {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_SETTINGS;
    return sanitize(parsed as Record<string, unknown>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(data: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
  }
}

export const useMindmapSettingsStore = create<MindmapSettingsState>((set) => ({
  ...loadInitialSettings(),

  updateSettings: (partial) => {
    set((state) => {
      const next = { ...state, ...partial };
      persistSettings(next);
      return next;
    });
  },

  resetSettings: () => {
    persistSettings(DEFAULT_SETTINGS);
    set({ ...DEFAULT_SETTINGS });
  },
}));
