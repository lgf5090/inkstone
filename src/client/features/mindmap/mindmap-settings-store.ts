import { create } from 'zustand';
// Direct module paths rather than the barrel: this store is read by the settings panel and by
// the note-creation path, neither of which has any business pulling in the map's DOM registry.
import { type MindmapDocumentDirection } from '../../lib/markdown/mindmap/document';
import { MINDMAP_UNDO_STEP_LIMIT } from '../../lib/markdown/mindmap/nodes';

export interface MindmapSettingsState {
  /** Folder a new file lands in when nothing else decided, by id or name. Empty means "where the reader is". */
  folder: string;
  /** Note whose body a new file starts from, by title or id. Empty means the library's empty map. */
  templateFilePath: string;
  filenamePrefix: string;
  filenameDateFormat: string;
  useElixirExtension: boolean;
  autoSaveIntervalMs: number;
  /**
   * How many undo steps a map keeps before its history is dropped. The library snapshots the
   * whole document per step with no ceiling of its own, so this is what keeps a long session
   * on a big map from growing without bound; 0 means keep everything.
   */
  undoHistoryLimit: number;
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
  undoHistoryLimit: MINDMAP_UNDO_STEP_LIMIT,
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
  // Whole steps only, and 0 means "no ceiling" rather than "no history", so a negative or a
  // fractional stored value is the reader's intent no longer and falls back rather than asking
  // the drawer for something it cannot do.
  if (!Number.isInteger(next.undoHistoryLimit) || next.undoHistoryLimit < 0 || next.undoHistoryLimit > 1000)
    next.undoHistoryLimit = DEFAULT_SETTINGS.undoHistoryLimit;
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
