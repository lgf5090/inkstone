/**
 * The linter's row menu entries, as the note list and the folder tree build them.
 *
 * Two things are worth a test: the whole group is missing when the reader switched the linter off,
 * and the second entry says the opposite of itself once it has been used. That second one is the
 * defect this file exists to keep out — a menu that keeps offering "leave this alone" for a row the
 * linter already leaves alone tells the reader the app is not listening.
 */
import { act, createElement, type ReactElement } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants';
import type { LinterSettings } from '@shared/linter';
import type { Folder, NoteSummary } from '@shared/types';
import { initI18n } from '../../lib/i18n';
import { useNotes } from '../../store/notes';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import type { MenuItem } from '../../components/overlay';
import { useLintFolderMenuItems, useLintNoteMenuItems } from './useLintMenuItems';

const driveCalls: Array<[string, string]> = [];
vi.mock('../../lib/linter/drive', () => ({
  lintAndReport: async (noteId: string, quiet: boolean) => {
    driveCalls.push(['lintAndReport', `${noteId}:${quiet}`]);
  },
  lintFolderById: async (folderId: string) => {
    driveCalls.push(['lintFolderById', folderId]);
  },
}));

let root: Root;
let container: HTMLDivElement;
let noteItems: MenuItem[] = [];
let folderItems: MenuItem[] = [];
let patches: Array<Record<string, unknown>>;

function noteSummary(id: string, title: string, folderId: string | null): NoteSummary {
  return {
    id,
    title,
    excerpt: '',
    folderId,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 1,
    position: 0,
    createdAt: Date.UTC(2026, 0, 1),
    updatedAt: Date.UTC(2026, 0, 2),
    deletedAt: null,
  };
}

const FOLDERS: Folder[] = [
  { id: 'f1', parentId: null, name: 'Inbox', icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0 },
];

function Probe() {
  noteItems = useLintNoteMenuItems('n1');
  folderItems = useLintFolderMenuItems('f1');

  return null;
}

function setLinter(patch: Partial<LinterSettings> = {}): void {
  act(() => {
    useSession.setState({
      settings: mergeSettings({ linter: { ...DEFAULT_SETTINGS.linter, ...patch } }),
    });
  });
}

function render(): void {
  act(() => {
    root.render(createElement(Probe));
  });
}

async function click(item: MenuItem): Promise<void> {
  if (!item.onSelect) {
    throw new Error(`the ${item.id} entry has nothing to do`);
  }
  await act(async () => {
    item.onSelect?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  driveCalls.length = 0;
  patches = [];
  noteItems = [];
  folderItems = [];
  await initI18n();
  useNotes.setState({ notes: { n1: noteSummary('n1', 'Note One', 'f1') }, folders: FOLDERS, contents: {} });
  useSession.setState({
    updateSettings: (patch: Record<string, unknown>) => {
      patches.push(patch);
      useSession.setState({ settings: mergeSettings(patch) });

      return Promise.resolve();
    },
  });
  useUi.setState({ toast: () => '' });
  setLinter();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  render();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe('the group is the linter switch', () => {
  it('is missing from both rows when the reader turned the linter off', () => {
    setLinter({ enabled: false });
    render();

    expect(noteItems).toEqual([]);
    expect(folderItems).toEqual([]);
  });

  it('appears on both rows when it is on', () => {
    expect(noteItems.map((item) => item.label)).toEqual(['Format this note', 'Leave this note alone']);
    expect(folderItems.map((item) => item.label)).toEqual(['Format the notes in this folder', 'Leave this folder alone']);
    expect(noteItems[0].separatorBefore).toBe(true);
    expect(folderItems[0].separatorBefore).toBe(true);
  });
});

describe('formatting a row', () => {
  it('names the row it was built for, not the note the editor holds', async () => {
    await click(noteItems[0]);

    expect(driveCalls).toEqual([['lintAndReport', 'n1:false']]);
  });

  it('asks for the folder the row is', async () => {
    await click(folderItems[0]);

    expect(driveCalls).toEqual([['lintFolderById', 'f1']]);
  });
});

describe('leaving a row alone', () => {
  it('says the opposite once the entry landed, and the opposite again when undone', async () => {
    await click(noteItems[1]);

    expect(patches).toHaveLength(1);
    expect((patches[0].linter as LinterSettings).filesToIgnore).toEqual([
      { label: 'Note One', match: '^Inbox/Note One$', flags: '' },
    ]);

    render();
    expect(noteItems.map((item) => item.label)).toEqual(['Format this note', 'Format this note again']);

    await click(noteItems[1]);
    render();

    expect((patches[1].linter as LinterSettings).filesToIgnore).toEqual([]);
    expect(noteItems.map((item) => item.label)).toEqual(['Format this note', 'Leave this note alone']);
  });

  it('reads a list the settings page edited, not only its own toggle', () => {
    setLinter({ foldersToIgnore: ['Inbox'] });
    render();

    expect(folderItems[1].label).toBe('Format this folder again');
  });

  it('swaps the eye for its open self when the row is already left alone', () => {
    setLinter({ filesToIgnore: [{ label: 'Note One', match: '^Inbox/Note One$', flags: '' }] });
    render();

    expect(componentOf(noteItems[1])).toBe(Eye);
    expect(componentOf(folderItems[1])).toBe(EyeOff);
  });
});

function componentOf(item: MenuItem): unknown {
  const icon = item.icon as ReactElement | null;
  if (!icon) {
    throw new Error(`the ${item.id} entry has no icon`);
  }

  return icon.type;
}
