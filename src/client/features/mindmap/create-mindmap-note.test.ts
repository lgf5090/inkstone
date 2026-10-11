import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../lib/i18n';
import { readMindmapDocumentFields } from '../../lib/markdown/mindmap/document';
import { useNotes } from '../../store/notes';
import { useMindmapSettingsStore } from './mindmap-settings-store';

const MAP_TEMPLATE = JSON.stringify({ nodeData: { id: 'tpl', topic: 'Template', children: [] }, direction: 3 });

describe('createMindmapNote', () => {
  let created: { title: string; content: string; folderId: string | null } | null = null;

  beforeEach(async () => {
    await initI18n();
    created = null;
    useMindmapSettingsStore.getState().resetSettings();
    useNotes.setState({
      createNote: vi.fn(async (input: Record<string, unknown>) => {
        created = input as never;
        return 'new-note-id';
      }) as never,
      folders: [{ id: 'f-maps-id', name: 'Maps', parentId: null, icon: null, color: null, position: 0, createdAt: 1, updatedAt: 1 } as never],
      notes: {
        'tpl-note-id': { id: 'tpl-note-id', title: 'mindmap-template.elixir' } as never,
        'prose-note-id': { id: 'prose-note-id', title: 'prose-note' } as never,
      },
      contents: {
        'tpl-note-id': MAP_TEMPLATE,
        'prose-note-id': '# Just a note\n\n- nothing a map',
      },
    });
  });

  it('names the file with the prefix, the date and the .elixir extension, which is what opens it as a map', async () => {
    useMindmapSettingsStore.getState().updateSettings({
      filenamePrefix: 'Map_',
      filenameDateFormat: 'YYYYMMDD',
    });
    await useNotes.getState().createMindmapNote();
    expect(created!.title).toMatch(/^Map_\d{8}\.elixir$/);
  });

  it('leaves the extension off when the reader asked for that, and takes the routing away with it', async () => {
    useMindmapSettingsStore.getState().updateSettings({ useElixirExtension: false, filenameDateFormat: 'YYYYMMDD' });
    await useNotes.getState().createMindmapNote();
    expect(created!.title).toMatch(/^Mindmap \d{8}$/);
  });

  it('writes a body whose every node has an id, because the library never assigns one', async () => {
    await useNotes.getState().createMindmapNote();
    const body = JSON.parse(created!.content) as { nodeData: { id?: string } };
    expect(body.nodeData.id).toBeTruthy();
  });

  it('applies the configured layout and spacing to a file that states neither', async () => {
    useMindmapSettingsStore.getState().updateSettings({ defaultDirection: 1, compact: true });
    await useNotes.getState().createMindmapNote();
    expect(readMindmapDocumentFields(created!.content)).toEqual({ direction: 1, compact: true });
  });

  it('leaves a template that names its own layout alone, because the file is the more specific statement', async () => {
    useMindmapSettingsStore.getState().updateSettings({ templateFilePath: 'mindmap-template.elixir', defaultDirection: 1, compact: true });
    await useNotes.getState().createMindmapNote();
    expect(created!.content).toContain('"topic": "Template"');
    // The template said "down", so it stays down; it said nothing about spacing, so the
    // configured default is what a brand-new file from it looks like.
    expect(readMindmapDocumentFields(created!.content)).toEqual({ direction: 3, compact: true });
  });

  it('ignores a template that is not a map rather than writing prose into a canvas', async () => {
    useMindmapSettingsStore.getState().updateSettings({ templateFilePath: 'prose-note' });
    await useNotes.getState().createMindmapNote();
    expect(created!.content).toContain('"nodeData"');
  });

  it('resolves the configured folder by name', async () => {
    useMindmapSettingsStore.getState().updateSettings({ folder: 'Maps' });
    await useNotes.getState().createMindmapNote();
    expect(created!.folderId).toBe('f-maps-id');
  });

  it('files nowhere when the configured folder names a folder that does not exist', async () => {
    useMindmapSettingsStore.getState().updateSettings({ folder: 'Nowhere' });
    await useNotes.getState().createMindmapNote();
    expect(created!.folderId).toBeNull();
  });

  it('prefers the folder the reader clicked in over the configured one', async () => {
    useMindmapSettingsStore.getState().updateSettings({ folder: 'Maps' });
    await useNotes.getState().createMindmapNote('clicked-folder');
    expect(created!.folderId).toBe('clicked-folder');
  });
});
