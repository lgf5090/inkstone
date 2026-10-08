/**
 * The drive, from the reader's ask to the note's text.
 *
 * These assertions are about the seams: which holder of the text gets written (an open editor, the
 * store, or a note that had to be fetched), what the reader is told afterwards, and what a note that
 * was left alone does instead. The rules themselves are tested by the ported suite; this file is
 * about the walk from a command to a document that changed.
 */
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, mergeSettings } from '@shared/constants';
import type { LinterSettings } from '@shared/linter';
import type { Note, NoteSummary } from '@shared/types';
import { confirm } from '../../components/overlay';
import { setActiveEditorView } from '../../editor/commands';
import { registerLinkEditorNote } from '../../features/links/store';
import { api } from '../api';
import { t } from '../i18n';
import { useNotes } from '../../store/notes';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { isLinterIgnoredPath } from '@shared/linter';
import { lintOneNote, pasteWithoutFormatting, previewCurrentNote, toggleIgnoreFolder, toggleIgnoreNote } from './drive';
import { RulesRunner } from './runner';

type ConfirmOptions = { title: string, description?: string };
let confirmAnswer = false;
let confirmRequests: ConfirmOptions[] = [];
vi.mock('../../components/overlay', async (original) => ({
  ...(await original<typeof import('../../components/overlay')>()),
  confirm: (options: ConfirmOptions) => {
    confirmRequests.push(options);
    return Promise.resolve(confirmAnswer);
  },
}));

const TRAILING_SPACES: LinterSettings['ruleConfigs'] = { 'trailing-spaces': { enabled: true } };

let container: HTMLDivElement;
let toasts: string[];
let writes: Array<[string, string]>;
let settingsPatches: Array<Record<string, unknown>>;

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

function setLinter(patch: Partial<LinterSettings>): void {
  useSession.setState({
    settings: mergeSettings({ linter: { ...DEFAULT_SETTINGS.linter, lintOnSave: true, ruleConfigs: TRAILING_SPACES, ...patch } }),
  });
}

function seedNotes(): void {
  useNotes.setState({
    notes: {
      n1: noteSummary('n1', 'Note One', 'f1'),
      n2: noteSummary('n2', 'Note Two', null),
    },
    contents: { n1: '# Title   \nbody\n', n2: 'clean\n' },
    folders: [{ id: 'f1', parentId: null, name: 'Inbox', icon: null, color: null, position: 0, createdAt: 0, updatedAt: 0 }],
  });
  useUi.setState({ activeNoteId: 'n1' });
}

function openEditor(doc: string, noteId: string | null = 'n1', caret: number | null = null): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc, selection: caret === null ? undefined : { anchor: caret } }),
    parent: container,
  });
  setActiveEditorView(view);
  if (noteId) registerLinkEditorNote(view, noteId);

  return view;
}

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.append(container);
  toasts = [];
  writes = [];
  settingsPatches = [];
  confirmRequests = [];
  confirmAnswer = false;
  seedNotes();
  setLinter({});
  useUi.setState({ toast: (input: { title: string }) => { toasts.push(input.title); return '' } });
  useNotes.setState({
    editContent: (id: string, content: string) => {
      writes.push([id, content]);
      useNotes.setState((state) => ({ contents: { ...state.contents, [id]: content } }));
    },
    flush: () => Promise.resolve(),
    pull: () => Promise.resolve(),
  });
  useSession.setState({ updateSettings: (patch: Record<string, unknown>) => { settingsPatches.push(patch); return Promise.resolve() } });
});

afterEach(() => {
  setActiveEditorView(null);
  container.remove();
  vi.restoreAllMocks();
});

describe('lintOneNote with the note open in an editor', () => {
  it('writes the change into the editor and leaves the caret in the line it was in', async () => {
    const view = openEditor('# Title   \nbody\n', 'n1', 3);
    const run = await lintOneNote('n1', view);

    expect(run.kind).toBe('applied');
    expect(run.rules).toEqual(['trailing-spaces']);
    expect(view.state.doc.toString()).toBe('# Title\nbody\n');
    expect(view.state.selection.main.head).toBeLessThan(10);
    // the editor holds the text, so nothing goes around it into the store
    expect(writes).toEqual([]);
  });

  it('says nothing when the note was already clean', async () => {
    const view = openEditor('# Title\nbody\n', 'n1');
    const run = await lintOneNote('n1', view);

    expect(run.kind).toBe('unchanged');
    expect(view.state.doc.toString()).toBe('# Title\nbody\n');
  });

  it('refuses to write into an editor that belongs to another note', async () => {
    const view = openEditor('# Title   \nbody\n', 'n2');
    const run = await lintOneNote('n1', view);

    expect(view.state.doc.toString()).toBe('# Title   \nbody\n');
    expect(run.kind).toBe('applied');
    // n1 is not open, so its own text travels through the store instead
    expect(writes).toEqual([['n1', '# Title\nbody\n']]);
  });

  it('leaves a note the reader told the linter to skip alone', async () => {
    setLinter({ foldersToIgnore: ['Inbox'] });
    const view = openEditor('# Title   \nbody\n', 'n1');
    const run = await lintOneNote('n1', view);

    expect(run.kind).toBe('ignored');
    expect(view.state.doc.toString()).toBe('# Title   \nbody\n');
    expect(writes).toEqual([]);
  });

  it('writes through the store when no editor holds the note', async () => {
    openEditor('# Other\n', null);
    const run = await lintOneNote('n1');

    expect(run.kind).toBe('applied');
    expect(writes).toEqual([['n1', '# Title\nbody\n']]);
  });

  it('reads a note it has never opened, and writes it back against the server’s revision', async () => {
    useUi.setState({ activeNoteId: null });
    useNotes.setState({ contents: {} });
    const fetched: Note = { ...noteSummary('n1', 'Note One', 'f1'), content: '# Title   \nbody\n' };
    vi.spyOn(api.notes, 'get').mockResolvedValue(fetched);
    const patch = vi.spyOn(api.notes, 'patch').mockResolvedValue(fetched);

    const run = await lintOneNote('n1');

    expect(run.kind).toBe('applied');
    expect(patch.mock.calls[0]?.[1]).toMatchObject({ content: '# Title\nbody\n', rev: 1 });
  });

  it('reports a note that cannot be read instead of inventing one', async () => {
    useNotes.setState({ contents: {} });
    vi.spyOn(api.notes, 'get').mockRejectedValue(new Error('offline'));

    const run = await lintOneNote('n1');

    expect(run.kind).toBe('failed');
    expect(writes).toEqual([]);
  });
});

describe('what the reader is told', () => {
  it('names the rule that changed the note', async () => {
    const view = openEditor('# Title   \n', 'n1');
    const run = await lintOneNote('n1', view);
    expect(run.rules).toEqual(['trailing-spaces']);
  });

  it('stays quiet about a run that changed nothing while the reader is typing', async () => {
    openEditor('# Title\nbody\n', 'n1');
    const { lintAndReport } = await import('./drive');
    await lintAndReport('n1', true);

    expect(toasts).toEqual([]);
  });

  it('answers a command that asked, even when the note was already clean', async () => {
    openEditor('# Title\nbody\n', 'n1');
    const { lintAndReport } = await import('./drive');
    await lintAndReport('n1', false);

    expect(toasts).toEqual(['Nothing to change.']);
  });

  it('keeps the note clean when the reader says no to the preview', async () => {
    const view = openEditor('# Title   \nbody\n', 'n1');
    confirmAnswer = false;
    await previewCurrentNote();

    expect(confirm).toBeTruthy();
    expect(view.state.doc.toString()).toBe('# Title   \nbody\n');
    expect(toasts).toEqual([]);
  });

  it('applies the preview the reader agreed to', async () => {
    const view = openEditor('# Title   \nbody\n', 'n1');
    confirmAnswer = true;
    await previewCurrentNote();

    expect(view.state.doc.toString()).toBe('# Title\nbody\n');
    await vi.waitFor(() => expect(toasts).toEqual(['Formatted: Trailing spaces']));
  });

  it('formats every note the library holds, and counts the ones that changed', async () => {
    useUi.setState({ activeNoteId: null });
    useNotes.setState({ contents: { n1: '# Title   \n', n2: 'body   \n' } });
    setActiveEditorView(null);
    const summaries: Record<string, Note> = {
      n1: { ...noteSummary('n1', 'Note One', 'f1'), content: '# Title   \n' },
      n2: { ...noteSummary('n2', 'Note Two', null), content: 'body   \n' },
    };
    const patched: Array<[string, string]> = [];
    vi.spyOn(api.notes, 'get').mockImplementation(async (id: string) => summaries[id]);
    vi.spyOn(api.notes, 'patch').mockImplementation(async (id: string, body: { content?: string }) => {
      patched.push([id, String(body.content)]);
      return summaries[id];
    });
    confirmAnswer = true;
    const { lintWholeLibrary } = await import('./drive');
    await lintWholeLibrary();

    expect(patched.map(([id]) => id)).toEqual(['n1', 'n2']);
    expect(patched.every(([, content]) => !/ +\n/.test(content))).toBe(true);
    expect(toasts[toasts.length - 1]).toContain('2 of 2');
  });

  it('does not write over a note the reader changed while it was being formatted', async () => {
    useUi.setState({ activeNoteId: null });
    useNotes.setState({ contents: { n1: '# Title   \n' } });
    vi.spyOn(api.notes, 'get').mockResolvedValue({ ...noteSummary('n1', 'Note One', 'f1'), content: '# Title   \nand new text\n' });
    const patch = vi.spyOn(api.notes, 'patch');

    const run = await lintOneNote('n1');

    expect(run.kind).toBe('failed');
    expect(run.error).toBe(t('linter.error.write_failed'));
    expect(patch).not.toHaveBeenCalled();
  });

  it('does not touch a single note when the batch is refused', async () => {
    confirmAnswer = false;
    const { lintWholeLibrary } = await import('./drive');
    await lintWholeLibrary();

    expect(writes).toEqual([]);
    expect(toasts).toEqual([]);
  });

  it('covers as many notes as one run promises and says what it left', async () => {
    const many: Record<string, NoteSummary> = {}
    for (let index = 0; index < 205; index++) {
      const id = `many-${index}`;
      many[id] = noteSummary(id, `Note ${index}`, null);
    }
    useNotes.setState({ notes: many });
    useUi.setState({ activeNoteId: null });
    setActiveEditorView(null);
    vi.spyOn(api.notes, 'get').mockImplementation(async (id: string) => ({ ...many[id], content: 'body   \n' }));
    const patch = vi.spyOn(api.notes, 'patch').mockImplementation(async (id: string, body: { rev: number }) => ({ ...many[id], content: 'body\n', rev: body.rev }));
    confirmAnswer = true;
    const { lintWholeLibrary } = await import('./drive');
    await lintWholeLibrary();

    expect(patch).toHaveBeenCalledTimes(200);
    expect(toasts[toasts.length - 1]).toContain('200 of 205');
  });

  it('tells the reader up front how many notes one run covers', async () => {
    const many: Record<string, NoteSummary> = {}
    for (let index = 0; index < 205; index++) {
      many[`long-${index}`] = noteSummary(`long-${index}`, `Note ${index}`, null);
    }
    useNotes.setState({ notes: many });
    confirmAnswer = false;
    const { lintWholeLibrary } = await import('./drive');
    await lintWholeLibrary();

    expect(JSON.stringify(confirmRequests)).toContain('the first 200 of the 205 notes');
  });
});

describe('the lists the commands edit', () => {
  it('adds a note by its path, and takes it back off again', () => {
    toggleIgnoreNote();
    const added = settingsPatches[0].linter as LinterSettings;
    expect(added.filesToIgnore).toEqual([{ label: 'Note One', match: '^Inbox/Note One$', flags: '' }]);

    setLinter({ filesToIgnore: added.filesToIgnore });
    toggleIgnoreNote();
    const removed = settingsPatches[1].linter as LinterSettings;
    expect(removed.filesToIgnore).toEqual([]);
  });

  it('adds the folder a note lives in, and takes it back off again', () => {
    toggleIgnoreFolder();
    const added = settingsPatches[0].linter as LinterSettings;
    expect(added.foldersToIgnore).toEqual(['Inbox']);

    setLinter({ foldersToIgnore: added.foldersToIgnore });
    toggleIgnoreFolder();
    expect(settingsPatches[1].linter).toHaveProperty('foldersToIgnore', []);
  });
});

describe('paste without formatting', () => {
  it('puts the clipboard in as it is, replacing what was selected', async () => {
    const view = openEditor('keep\n', 'n1', 0);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => Promise.resolve('raw   text') } });
    view.dispatch({ selection: { anchor: 0, head: 4 } });

    await pasteWithoutFormatting();

    expect(view.state.doc.toString()).toBe('raw   text\n');
  });

  it('says so when the clipboard has nothing to paste', async () => {
    openEditor('keep\n', 'n1');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => Promise.resolve('') } });

    await pasteWithoutFormatting();

    expect(toasts).toEqual(['There is no clipboard content.']);
  });
});

describe('a stored expression that could hang the run', () => {
  it('is skipped by the custom replacements', () => {
    const runner = new RulesRunner();
    const text = `${'a'.repeat(60)}b`;

    expect(runner.runCustomRegexReplacement([{ label: '', find: '(a+)+$', replace: 'X', flags: '', enabled: true }], text)).toBe(text);
  });

  it('is skipped by the file list, which is tested against note paths', () => {
    const settings = { ...DEFAULT_SETTINGS.linter, filesToIgnore: [{ label: '', match: '(a+)+$', flags: '' }] };

    expect(isLinterIgnoredPath(settings, `${'a'.repeat(60)}b`, [])).toBe(false);
  });

  it('leaves a sound expression to do its work', () => {
    const runner = new RulesRunner();
    const custom = [{ label: '', find: 'a(b+)', replace: 'c$1', flags: '', enabled: true }];

    expect(runner.runCustomRegexReplacement(custom, 'abbb')).toBe('cbbb');
  });
});
