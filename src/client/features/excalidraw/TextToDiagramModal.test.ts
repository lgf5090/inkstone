import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n, t } from '../../lib/i18n';
import { TextToDiagramModal } from './TextToDiagramModal';
import { useExcalidrawSettingsStore } from './excalidraw-settings-store';

describe('TextToDiagramModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    await initI18n();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    localStorage.clear();
    useExcalidrawSettingsStore.getState().resetSettings();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  it('does not render when isOpen is false', () => {
    act(() => {
      root.render(
        createElement(TextToDiagramModal, {
          isOpen: false,
          onClose: vi.fn(),
          onInsert: vi.fn(),
        }),
      );
    });

    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('renders modal with tabs and live code editor in AI tab matching Image 2', () => {
    act(() => {
      root.render(
        createElement(TextToDiagramModal, {
          isOpen: true,
          onClose: vi.fn(),
          onInsert: vi.fn(),
          initialTab: 'ai',
        }),
      );
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();

    const buttons = Array.from(dialog!.querySelectorAll('button'));
    const newChatButton = buttons.find(
      (b) => b.textContent?.includes(t('excalidraw.new_chat')),
    );
    expect(newChatButton).toBeDefined();

    const textareas = Array.from(dialog!.querySelectorAll('textarea'));
    expect(textareas.length).toBeGreaterThanOrEqual(2);
    expect(textareas[0].value).toContain('graph TD');
  });

  it('switches to mermaid editor tab', async () => {
    act(() => {
      root.render(
        createElement(TextToDiagramModal, {
          isOpen: true,
          onClose: vi.fn(),
          onInsert: vi.fn(),
          initialTab: 'mermaid',
        }),
      );
    });

    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    expect(textarea?.value).toContain('graph TD');
  });

  it('toggles chat history popover when clock button is clicked', () => {
    act(() => {
      root.render(
        createElement(TextToDiagramModal, {
          isOpen: true,
          onClose: vi.fn(),
          onInsert: vi.fn(),
          initialTab: 'ai',
        }),
      );
    });

    const clockLabel = t('excalidraw.chat_history');
    const clockBtn = container.querySelector(`button[aria-label="${clockLabel}"], button[title="${clockLabel}"]`);
    expect(clockBtn).not.toBeNull();

    act(() => {
      (clockBtn as HTMLButtonElement).click();
    });

    expect(container.textContent).toContain(t('excalidraw.chat_history'));
  });

  it('switches tab when clicking view as mermaid link in footer', () => {
    act(() => {
      root.render(
        createElement(TextToDiagramModal, {
          isOpen: true,
          onClose: vi.fn(),
          onInsert: vi.fn(),
          initialTab: 'ai',
        }),
      );
    });

    const viewAsMermaidLabel = t('excalidraw.view_as_mermaid');
    const viewAsMermaidBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes(viewAsMermaidLabel),
    );
    expect(viewAsMermaidBtn).toBeDefined();

    act(() => {
      viewAsMermaidBtn!.click();
    });

    expect(container.textContent).toContain(t('excalidraw.mermaid_editor'));
  });

  it('calls onInsert with converted elements when insert button is clicked', () => {
    const onInsert = vi.fn();
    const onClose = vi.fn();

    act(() => {
      root.render(
        createElement(TextToDiagramModal, {
          isOpen: true,
          onClose,
          onInsert,
          initialTab: 'mermaid',
          initialMermaidCode: 'graph TD\n  A[Start] --> B[End]',
        }),
      );
    });

    const insertLabel = t('excalidraw.insert_into_canvas');
    const buttons = Array.from(container.querySelectorAll('button'));
    const insertButton = buttons.find(
      (b) => b.textContent?.includes(insertLabel),
    );
    expect(insertButton).toBeDefined();

    act(() => {
      insertButton!.click();
    });

    expect(onInsert).toHaveBeenCalled();
    const elements = onInsert.mock.calls[0][0];
    expect(Array.isArray(elements)).toBe(true);
    expect(elements.length).toBeGreaterThan(0);
    expect(onClose).toHaveBeenCalled();
  });
});
