import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../lib/i18n';
import { ExcalidrawSettings } from './ExcalidrawSettings';
import { useExcalidrawSettings } from '../excalidraw/excalidraw-settings-store';

let host: HTMLDivElement;
let root: Root;

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(ExcalidrawSettings));
    await Promise.resolve();
  });
}

beforeAll(async () => {
  await initI18n();
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useExcalidrawSettings.getState().resetSettings();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('ExcalidrawSettings', () => {
  it('renders all category tabs and sections', async () => {
    await render();

    const tabs = host.querySelectorAll('button[type="button"]');
    expect(tabs.length).toBeGreaterThanOrEqual(13);

    const sections = host.querySelectorAll('[data-category-card]');
    expect(sections.length).toBe(12);

    const sectionIds = [...sections].map((el) => el.getAttribute('data-category-card'));
    expect(sectionIds).toEqual([
      'basic',
      'saving',
      'ai',
      'ui',
      'links',
      'embed_md',
      'embed_files',
      'extended',
      'fonts',
      'misc',
      'automate',
      'compatibility',
    ]);
  });

  it('filters sections when clicking a category tab', async () => {
    await render();

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button[type="button"]')];
    const aiTab = buttons.find((btn) => btn.textContent?.includes('AI'));
    expect(aiTab).toBeDefined();

    await act(async () => {
      aiTab!.click();
      await Promise.resolve();
    });

    const filteredSections = host.querySelectorAll('[data-category-card]');
    expect(filteredSections.length).toBe(1);
    expect(filteredSections[0].getAttribute('data-category-card')).toBe('ai');
  });

  it('restores all sections when switching back to All tab', async () => {
    await render();

    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button[type="button"]')];
    const uiTab = buttons[4];
    await act(async () => {
      uiTab.click();
      await Promise.resolve();
    });
    expect(host.querySelectorAll('[data-category-card]').length).toBe(1);

    const allTab = buttons[0];
    await act(async () => {
      allTab.click();
      await Promise.resolve();
    });
    expect(host.querySelectorAll('[data-category-card]').length).toBe(12);
  });

  it('updates store values when editing settings', async () => {
    await render();

    expect(useExcalidrawSettings.getState().folder).toBe('');
    act(() => {
      useExcalidrawSettings.getState().updateSettings({ folder: 'sketches' });
    });
    expect(useExcalidrawSettings.getState().folder).toBe('sketches');
  });
});
