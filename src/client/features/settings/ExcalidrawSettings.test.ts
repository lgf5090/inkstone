import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n, t } from '../../lib/i18n';
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

const PROVIDER_NAMES = ['DeepSeek', 'OpenAI', 'Anthropic', 'Google Gemini', 'xAI'];

/** The group's own radios, in the order the settings draw them. */
function providerGroup(): HTMLElement {
  const groups = [...host.querySelectorAll<HTMLElement>('[role="radiogroup"]')];
  const group = groups.find((candidate) =>
    [...candidate.querySelectorAll('[role="radio"]')].some((radio) =>
      radio.textContent?.includes('DeepSeek'),
    ),
  );
  if (!group) throw new Error('the provider radiogroup is not on the page');
  return group;
}

function radiosOf(group: HTMLElement): HTMLButtonElement[] {
  return [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
}

function press(element: Element, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
}

function click(element: Element): void {
  act(() => {
    (element as HTMLElement).click();
  });
}

function typeInto(input: HTMLInputElement, next: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(input, next);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ExcalidrawSettings provider radio group', () => {
  it('groups the providers as radios named by the section heading', async () => {
    await render();
    const group = providerGroup();

    expect(group.getAttribute('aria-label')).toBeNull();
    const labelId = group.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent?.trim()).toBe(
      t('settings.excalidraw_ai_provider'),
    );

    const radios = radiosOf(group);
    expect(radios).toHaveLength(PROVIDER_NAMES.length);
    radios.forEach((radio, index) => {
      expect(radio.textContent, `radio ${index}`).toContain(PROVIDER_NAMES[index]);
      expect(radio.getAttribute('aria-checked')).not.toBeNull();
    });
    const selected = radios.find((radio) => radio.getAttribute('aria-checked') === 'true');
    expect(selected?.textContent).toContain('DeepSeek');
    expect(useExcalidrawSettings.getState().aiDefaultProvider).toBe('deepseek');
  });

  it('owns no child that is not a radio', async () => {
    await render();
    const group = providerGroup();

    for (const child of Array.from(group.children)) {
      expect(child.getAttribute('role'), `${child.tagName} is inside the radiogroup`).toBe('radio');
    }
    expect(group.querySelectorAll('button')).toHaveLength(radiosOf(group).length);
    expect(group.querySelector('input')).toBeNull();

    // The edit controls live beside the group, labelled by the same heading rather than nested in it.
    const editors = [...group.parentElement!.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')];
    expect(editors).toHaveLength(PROVIDER_NAMES.length);
    for (const editor of editors) {
      expect(editor.getAttribute('aria-controls')).toBeTruthy();
      expect(editor.closest('[role="radiogroup"]')).toBeNull();
    }
  });

  it('keeps only the selected provider in the tab order', async () => {
    await render();
    const radios = radiosOf(providerGroup());

    expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1, -1]);

    act(() => {
      useExcalidrawSettings.getState().updateSettings({ aiDefaultProvider: 'google' });
    });
    expect(radiosOf(providerGroup()).map((radio) => radio.tabIndex)).toEqual([
      -1, -1, -1, 0, -1,
    ]);
  });

  it('moves the selection and the focus with the arrows, and jumps with Home and End', async () => {
    await render();
    const radios = radiosOf(providerGroup());
    radios[0]!.focus();

    expect(press(document.activeElement!, 'ArrowRight').defaultPrevented).toBe(true);
    expect(useExcalidrawSettings.getState().aiDefaultProvider).toBe('openai');
    expect(document.activeElement).toBe(radiosOf(providerGroup())[1]);

    press(document.activeElement!, 'ArrowLeft');
    expect(useExcalidrawSettings.getState().aiDefaultProvider).toBe('deepseek');
    press(document.activeElement!, 'ArrowLeft');
    expect(useExcalidrawSettings.getState().aiDefaultProvider).toBe('xai');
    expect(document.activeElement).toBe(radiosOf(providerGroup())[4]);

    press(document.activeElement!, 'Home');
    expect(useExcalidrawSettings.getState().aiDefaultProvider).toBe('deepseek');
    expect(document.activeElement).toBe(radiosOf(providerGroup())[0]);

    press(document.activeElement!, 'End');
    expect(useExcalidrawSettings.getState().aiDefaultProvider).toBe('xai');
    expect(document.activeElement).toBe(radiosOf(providerGroup())[4]);
  });

  it('opens one provider\'s configuration without selecting it', async () => {
    await render();
    const group = providerGroup();
    const editor = [...group.parentElement!.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')].find(
      (button) => button.getAttribute('aria-label')?.includes('OpenAI'),
    );
    expect(editor).toBeDefined();
    expect(editor!.getAttribute('aria-expanded')).toBe('false');

    click(editor!);

    expect(editor!.getAttribute('aria-expanded')).toBe('true');
    expect(useExcalidrawSettings.getState().aiDefaultProvider).toBe('deepseek');
    const panel = document.getElementById(editor!.getAttribute('aria-controls')!);
    expect(panel).not.toBeNull();
    expect(panel!.contains(group)).toBe(false);
    expect(panel!.querySelectorAll('input')).toHaveLength(2);

    typeInto(panel!.querySelector<HTMLInputElement>('input[type="password"]')!, 'sk-test');
    expect(useExcalidrawSettings.getState().aiProviders.openai?.apiKey).toBe('sk-test');

    click(editor!);
    expect(editor!.getAttribute('aria-expanded')).toBe('false');
    expect(panel!.querySelectorAll('input')).toHaveLength(0);
  });
});
