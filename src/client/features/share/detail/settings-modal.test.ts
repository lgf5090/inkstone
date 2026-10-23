// @vitest-environment jsdom
/**
 * The hub's own preferences.
 *
 * Three knobs, and the two things that are easy to get wrong: a stored value the picker no longer
 * offers must not be trusted, and the control has to answer the keyboard as the radiogroup its role
 * promises.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initI18n, t } from '../../../lib/i18n';
import { installTestGlobals } from '../../../lib/test-render';
import { useUi } from '../../../store/ui';
import { SHARE_HUB_PREFS_STORAGE_KEY, loadShareHubPrefs, parseShareHubPrefs, saveShareHubPrefs } from './share-prefs';
import { ShareSettingsModal } from './settings-modal';

let root: Root;
let host: HTMLElement;

const buttons = () => [...document.body.querySelectorAll('button')];
const button = (label: string) => buttons().find((node) => node.textContent?.includes(label));
const checkedRadio = (label: string) => buttons().find(
  (node) => node.getAttribute('role') === 'radio' && node.textContent === label && node.getAttribute('aria-checked') === 'true',
);

async function open(): Promise<void> {
  await act(async () => {
    root.render(createElement(ShareSettingsModal, { onClose }));
  });
}

let onClose: () => void;

beforeEach(async () => {
  installTestGlobals();
  await initI18n();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  onClose = vi.fn();
  useUi.setState({ toasts: [] });
  localStorage.clear();
  saveShareHubPrefs({ staleLinkDays: 90, autoRefreshMs: 45_000, defaultRange: '30d' });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the modal shows the answer the hub is already using', () => {
  it('selects the stored threshold, interval and window', async () => {
    await open();
    expect(checkedRadio(t('share.hub_days', { days: 90 }))).toBeTruthy();
    expect(checkedRadio(t('share.hub_seconds', { seconds: 45 }))).toBeTruthy();
    expect(checkedRadio(t('share.hub_range_30d'))).toBeTruthy();
  });

  it('offers off for both knobs that can be turned off', async () => {
    await open();
    expect(buttons().filter((node) => node.getAttribute('role') === 'radio' && node.textContent === t('share.hub_off'))).toHaveLength(2);
  });
});

describe('saving', () => {
  it('writes the new choices and closes', async () => {
    await open();
    const target = buttons().find((node) => node.getAttribute('role') === 'radio' && node.textContent === t('share.hub_days', { days: 30 }));
    await act(async () => { target!.click(); });
    await act(async () => { button!(t('common.save'))!.click(); });
    expect(onClose).toHaveBeenCalled();
    expect(loadShareHubPrefs().staleLinkDays).toBe(30);
    expect(JSON.parse(localStorage.getItem(SHARE_HUB_PREFS_STORAGE_KEY) ?? '{}')).toMatchObject({ staleLinkDays: 30 });
    expect(useUi.getState().toasts.map((item) => item.title)).toContain(t('share.hub_saved'));
  });

  it('leaves the untouched knobs as they were', async () => {
    await open();
    await act(async () => { button!(t('common.save'))!.click(); });
    expect(loadShareHubPrefs()).toEqual({ staleLinkDays: 90, autoRefreshMs: 45_000, defaultRange: '30d' });
  });

  it('cancels without writing', async () => {
    await open();
    const target = buttons().find((node) => node.getAttribute('role') === 'radio' && node.textContent === t('share.hub_range_all'));
    await act(async () => { target!.click(); });
    await act(async () => { button!(t('common.cancel'))!.click(); });
    expect(loadShareHubPrefs().defaultRange).toBe('30d');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the keyboard reaches every choice', () => {
  it('steps a threshold with an arrow and keeps the focus on what it selected', async () => {
    await open();
    const selected = checkedRadio(t('share.hub_days', { days: 90 }))!;
    // One tab stop for the whole group, sitting on the current answer.
    expect(selected.tabIndex).toBe(0);
    act(() => {
      selected.focus();
      selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    const moved = checkedRadio(t('share.hub_days', { days: 180 }))!;
    expect(moved.getAttribute('aria-checked')).toBe('true');
    expect(selected.getAttribute('aria-checked')).toBe('false');
    // Focus follows the selection, so the next arrow continues from the row the reader just reached.
    expect(document.activeElement).toBe(moved);
  });
});

describe('a stored entry that no longer means anything', () => {
  it('falls back to the defaults rather than trusting it', () => {
    expect(parseShareHubPrefs('not json')).toEqual({ staleLinkDays: 90, autoRefreshMs: 45_000, defaultRange: '30d' });
    expect(parseShareHubPrefs(null)).toEqual({ staleLinkDays: 90, autoRefreshMs: 45_000, defaultRange: '30d' });
    expect(parseShareHubPrefs('{"staleLinkDays":7,"autoRefreshMs":99,"defaultRange":"9y"}'))
      .toEqual({ staleLinkDays: 90, autoRefreshMs: 45_000, defaultRange: '30d' });
  });

  it('keeps a value the pickers do offer', () => {
    expect(parseShareHubPrefs('{"staleLinkDays":0,"autoRefreshMs":300000,"defaultRange":"7d"}'))
      .toEqual({ staleLinkDays: 0, autoRefreshMs: 300_000, defaultRange: '7d' });
  });
});
