import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useNotes } from '../../store/notes';
import { useExcalidrawSettingsStore } from './excalidraw-settings-store';

describe('createExcalidrawNote settings integration', () => {
  let createdPayload: any = null;

  beforeEach(() => {
    createdPayload = null;
    useExcalidrawSettingsStore.getState().resetSettings();
    useNotes.setState({
      createNote: vi.fn(async (input: any) => {
        createdPayload = input;
        return 'new-note-id';
      }) as any,
      folders: [
        {
          id: 'f-drawings-id',
          name: 'Drawings',
          parentId: null,
          icon: null,
          color: null,
          position: 0,
          createdAt: 1,
          updatedAt: 1,
        } as any,
      ],
      notes: {
        'tpl-note-id': {
          id: 'tpl-note-id',
          title: 'templates/default-canvas.md',
          content: '{"elements":[{"id":"template-rect"}]}',
        } as any,
      },
      contents: {
        'tpl-note-id': '{"elements":[{"id":"template-rect"}]}',
      },
    });
  });

  it('formats filename with custom prefix, extension toggle, and custom date pattern', async () => {
    useExcalidrawSettingsStore.getState().updateSettings({
      drawingFilenamePrefix: 'Sketch_',
      drawingFilenameDateFormat: 'YYYYMMDD',
      useExcalidrawExtension: false,
    });

    await useNotes.getState().createExcalidrawNote();

    expect(createdPayload).not.toBeNull();
    expect(createdPayload.title).toMatch(/^Sketch_\d{8}$/);
    expect(createdPayload.title.endsWith('.excalidraw')).toBe(false);
  });

  it('appends .excalidraw extension by default', async () => {
    useExcalidrawSettingsStore.getState().updateSettings({
      drawingFilenamePrefix: 'Drawing ',
      drawingFilenameDateFormat: 'YYYY-MM-DD',
      useExcalidrawExtension: true,
    });

    await useNotes.getState().createExcalidrawNote();

    expect(createdPayload).not.toBeNull();
    expect(createdPayload.title).toMatch(/^Drawing \d{4}-\d{2}-\d{2}\.excalidraw$/);
  });

  it('resolves target folder by name from settings when folderId is not provided', async () => {
    useExcalidrawSettingsStore.getState().updateSettings({
      folder: 'Drawings',
    });

    await useNotes.getState().createExcalidrawNote();

    expect(createdPayload).not.toBeNull();
    expect(createdPayload.folderId).toBe('f-drawings-id');
  });

  it('prefers explicit folderId argument over settings folder', async () => {
    useExcalidrawSettingsStore.getState().updateSettings({
      folder: 'Drawings',
    });

    await useNotes.getState().createExcalidrawNote('override-folder-id');

    expect(createdPayload).not.toBeNull();
    expect(createdPayload.folderId).toBe('override-folder-id');
  });

  it('loads template note content when templateFilePath matches an existing note', async () => {
    useExcalidrawSettingsStore.getState().updateSettings({
      templateFilePath: 'templates/default-canvas.md',
    });

    await useNotes.getState().createExcalidrawNote();

    expect(createdPayload).not.toBeNull();
    expect(createdPayload.content).toBe('{"elements":[{"id":"template-rect"}]}');
  });
});
