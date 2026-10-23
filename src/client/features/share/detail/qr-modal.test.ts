// @vitest-environment jsdom
/**
 * The QR sheet: one address, drawn as a code and handed out by every way out of the panel.
 *
 * What is worth pinning is that the code, the copied text and the open-in-a-new-tab link cannot
 * disagree about the address, and that a relative address the hub may hold becomes the absolute one a
 * camera can follow. The raster exports are left to the browser gates: jsdom has no canvas to paint
 * into, so a test here would be asserting that nothing happened.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n, t } from '../../../lib/i18n';
import { installTestGlobals } from '../../../lib/test-render';
import { useUi } from '../../../store/ui';
import { ShareQrModal } from './qr-modal';
import { qrFileName } from './qr-export';

let root: Root;
let host: HTMLElement;
const writeText = vi.fn();

async function show(url: string, title = 'Draft note'): Promise<void> {
  await act(async () => {
    root.render(createElement(ShareQrModal, { url, title, onClose: () => {} }));
  });
}

const buttons = () => [...document.body.querySelectorAll('button')];
const button = (label: string) => buttons().find((node) => node.textContent?.includes(label));

beforeEach(async () => {
  installTestGlobals();
  await initI18n();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUi.setState({ toasts: [] });
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('the code and the words', () => {
  it('draws a scannable matrix and names it', async () => {
    await show('https://notes.test/s/abc');
    const svg = document.querySelector('svg[role="img"]');
    expect(svg).toBeTruthy();
    expect(svg!.querySelector('title')?.textContent).toBe(t('share.qr_title'));
    // Big enough to read off a monitor across a table, which is what "printable size" means here.
    expect(svg!.getAttribute('width')).toBe('240');
    // Modules, not an empty frame: a code that carries no dark cells scans as nothing.
    const modules = [...svg!.querySelectorAll('path')].at(-1);
    expect(modules?.getAttribute('d')).toContain('M');
    expect(modules!.getAttribute('d')!.length).toBeGreaterThan(20);
    expect(document.body.textContent).toContain('https://notes.test/s/abc');
  });

  it('turns a relative address into the one a camera can follow, everywhere at once', async () => {
    await show('/s/abc');
    const shown = document.body.textContent ?? '';
    expect(shown).toContain(`${window.location.origin}/s/abc`);
    await act(async () => { button!(t('common.copy'))!.click(); });
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toBe(`${window.location.origin}/s/abc`);
    const open = [...document.body.querySelectorAll('a')].find((node) => node.target === '_blank');
    expect(open?.getAttribute('href')).toBe(`${window.location.origin}/s/abc`);
  });

  it('marks the copy done so the reader knows it left', async () => {
    await show('https://notes.test/s/abc');
    await act(async () => { button!(t('common.copy'))!.click(); });
    expect(button(t('common.copied'))).toBeTruthy();
  });

  it('says out loud when the clipboard refused the address', async () => {
    writeText.mockRejectedValue(new Error('refused'));
    await show('https://notes.test/s/abc');
    await act(async () => { button!(t('common.copy'))!.click(); });
    expect(useUi.getState().toasts.map((item) => item.title)).toContain(t('preview.could_not_copy'));
    expect(button(t('common.copied'))).toBeFalsy();
  });
});

describe('the file name a downloaded code gets', () => {
  it('comes from the note title, cleaned and lowered', () => {
    expect(qrFileName('Weekly Report / Q3', 'png')).toBe('weekly-report-q3-qr.png');
    expect(qrFileName('Notes: "Deep" work <thinking>', 'svg')).toBe('notes-deep-work-thinking-qr.svg');
  });

  it('falls back to a usable name when there is no title to use', () => {
    expect(qrFileName('   ', 'png')).toBe('share-qr.png');
    expect(qrFileName('///', 'svg')).toBe('share-qr.svg');
  });
});
