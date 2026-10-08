/**
 * The two lists that keep the linter away, read and written the way a row menu does it.
 *
 * A menu has to know whether the row it is on is already ignored, and the answer has to be the same
 * one a run uses, or the reader is shown "leave this alone" for a note the run already leaves alone.
 * So the entries are compared through `isLinterIgnoredPath`, and the pinned path regex is what a
 * rename is measured against.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants';
import type { LinterSettings } from '@shared/linter';
import type { Folder, NoteSummary } from '@shared/types';
import { t } from '../i18n';
import { useNotes } from '../../store/notes';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { folderIsIgnored, noteIsIgnored, stampOf, toggleFolderIgnored, toggleNoteIgnored } from './ignore-state';

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
  { id: 'f2', parentId: 'f1', name: 'Deep', icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0 },
];

function setLinter(patch: Partial<LinterSettings>): void {
  useSession.setState({
    settings: mergeSettings({ linter: { ...DEFAULT_SETTINGS.linter, ...patch } }),
  });
}

function linter(): LinterSettings {
  return useSession.getState().settings.linter;
}

let patches: Array<{ linter?: Partial<LinterSettings> }>;
let toasts: string[];

beforeEach(() => {
  localStorage.clear();
  patches = [];
  toasts = [];
  useNotes.setState({
    notes: {
      n1: noteSummary('n1', 'Note One', 'f2'),
      n2: noteSummary('n2', 'A+B', 'f1'),
      gone: noteSummary('gone', 'Trashed', null),
    },
    folders: FOLDERS,
  });
  useUi.setState({ toast: (input: { title: string }) => { toasts.push(input.title); return '' } });
  useSession.setState({
    updateSettings: (patch: Record<string, unknown>) => {
      patches.push(patch as { linter?: Partial<LinterSettings> });

      return Promise.resolve();
    },
  });
  setLinter({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the path the ignore lists are read against', () => {
  it('is the folder trail and the title, joined', () => {
    expect(stampOf('n1')?.path).toBe('Inbox/Deep/Note One');
    expect(stampOf('n2')?.path).toBe('Inbox/A+B');
  });

  it('gives a note in the trash no stamp at all', () => {
    useNotes.setState((state) => ({ notes: { ...state.notes, gone: { ...state.notes.gone, deletedAt: Date.UTC(2026, 0, 3) } } }));

    expect(stampOf('gone')).toBeNull();
    expect(noteIsIgnored(linter(), 'gone')).toBe(false);
  });
});

describe('noteIsIgnored', () => {
  it('agrees with the run when an entry names the note', () => {
    setLinter({ filesToIgnore: [{ label: 'Note One', match: '^Inbox/Deep/Note One$', flags: '' }] });

    expect(noteIsIgnored(linter(), 'n1')).toBe(true);
    expect(noteIsIgnored(linter(), 'n2')).toBe(false);
  });

  it('escapes the path it pins, so a title of A+B matches only A+B', () => {
    toggleNoteIgnored('n2');
    const entry = linterOfPatch().filesToIgnore[0];
    expect(entry.match).toBe('^Inbox/A\\+B$');
    useSession.setState({ settings: mergeSettings({ linter: { ...linter(), filesToIgnore: [entry] } }) });

    expect(noteIsIgnored(linter(), 'n2')).toBe(true);
    expect(noteIsIgnored(linter(), 'n1')).toBe(false);
  });

  it('refuses a pattern the safety check would not run', () => {
    setLinter({ filesToIgnore: [{ label: 'hostile', match: '(a+)+$', flags: '' }] });

    expect(noteIsIgnored(linter(), 'n1')).toBe(false);
  });
});

describe('folderIsIgnored', () => {
  it('reads the folder the note hangs under, and its ancestors', () => {
    setLinter({ foldersToIgnore: ['Inbox'] });

    expect(folderIsIgnored(linter(), 'f1')).toBe(true);
    expect(folderIsIgnored(linter(), 'f2')).toBe(true);
  });

  it('is false for a folder nobody named', () => {
    expect(folderIsIgnored(linter(), 'f2')).toBe(false);
  });
});

describe('toggling from a row', () => {
  it('adds the note entry by its pinned path and says so', () => {
    toggleNoteIgnored('n1');

    expect(linterOfPatch().filesToIgnore).toEqual([{ label: 'Note One', match: '^Inbox/Deep/Note One$', flags: '' }]);
    expect(toasts).toEqual([t('linter.ignore_added', { name: 'Note One' })]);
  });

  it('takes the same entry back off, and only that one', () => {
    const other = { label: 'other', match: '^Elsewhere$', flags: '' };
    setLinter({ filesToIgnore: [other] });

    toggleNoteIgnored('n1');
    setLinter({ filesToIgnore: linterOfPatch().filesToIgnore });
    expect(linter().filesToIgnore).toHaveLength(2);

    toggleNoteIgnored('n1');

    expect(linterOfPatch().filesToIgnore).toEqual([other]);
    expect(toasts).toEqual([
      t('linter.ignore_added', { name: 'Note One' }),
      t('linter.ignore_removed', { name: 'Note One' }),
    ]);
  });

  it('stops the note being ignored once it is renamed', () => {
    toggleNoteIgnored('n1');
    setLinter({ filesToIgnore: linterOfPatch().filesToIgnore });
    expect(noteIsIgnored(linter(), 'n1')).toBe(true);

    useNotes.setState((state) => ({ notes: { ...state.notes, n1: { ...state.notes.n1, title: 'Renamed' } } }));

    expect(noteIsIgnored(linter(), 'n1')).toBe(false);
  });

  it('adds and removes a folder by name, leaving the note list alone', () => {
    toggleFolderIgnored('f2');

    expect(linterOfPatch().foldersToIgnore).toEqual(['Deep']);
    expect(linterOfPatch().filesToIgnore).toEqual([]);

    setLinter({ foldersToIgnore: linterOfPatch().foldersToIgnore });
    toggleFolderIgnored('f2');

    expect(linterOfPatch().foldersToIgnore).toEqual([]);
  });

  it('does nothing for a note that is not there', () => {
    toggleNoteIgnored('missing');
    toggleFolderIgnored('missing');

    expect(patches).toEqual([]);
    expect(toasts).toEqual([]);
  });
});

/** The settings the last toggle asked for, as they would read once the write landed. */
function linterOfPatch(): LinterSettings {
  const last = patches[patches.length - 1];
  if (!last?.linter) {
    throw new Error('no settings were asked for');
  }

  return { ...DEFAULT_SETTINGS.linter, ...linter(), ...last.linter };
}
