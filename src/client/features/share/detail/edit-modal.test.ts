// @vitest-environment jsdom
/**
 * The per-link editor.
 *
 * What is pinned here is the part a hub shell cannot see: the ladder a passcode has to clear before a
 * request leaves, the expiry that must survive a save the reader did not mean to change, the one-id
 * batch call behind the pause, the confirmation in front of a revoke, and the answer that arrives after
 * the editor has already moved to a different note.
 *
 * The link is fetched by the `noteId` the shell hands in, so none of these cases need a hub list to
 * have arrived — that dependency is the defect this port removed.
 */
import { Fragment, act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@shared/constants';
import type { ShareInfo } from '@shared/types';
import { ConfirmHost } from '../../../components/overlay';
import { initI18n, t } from '../../../lib/i18n';
import { installTestGlobals } from '../../../lib/test-render';
import { useUi } from '../../../store/ui';
import { ShareEditModal } from './edit-modal';

const calls = vi.hoisted(() => ({
  get: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  organize: vi.fn(),
  setEnabled: vi.fn(),
  folders: vi.fn(),
  tags: vi.fn(),
}));

vi.mock('../../../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: { share: { get: (id: string, signal?: AbortSignal) => calls.get(id, signal) } },
}));

vi.mock('../../../lib/api-share-hub', () => ({
  shareHubApi: {
    create: (id: string, body: unknown) => calls.create(id, body),
    remove: (id: string) => calls.remove(id),
    organize: (id: string, body: unknown) => calls.organize(id, body),
    batch: { setEnabled: (ids: string[], enabled: boolean) => calls.setEnabled(ids, enabled) },
    folders: { list: () => calls.folders() },
    tags: { list: () => calls.tags() },
  },
}));

let root: Root;
let host: HTMLElement;
let onClose: () => void;
let onSaved: () => void;

function shareOf(noteId: string, over: Partial<ShareInfo> = {}): ShareInfo {
  return {
    slug: `slug-${noteId}`,
    noteId,
    url: `https://notes.test/s/${noteId}`,
    hasPassword: false,
    expiresAt: null,
    views: 3,
    createdAt: 1,
    isEnabled: true,
    lastViewedAt: null,
    folderId: null,
    tags: [],
    ...over,
  };
}

async function open(noteId = 'n1'): Promise<void> {
  await act(async () => {
    root.render(createElement(Fragment, null, [
      createElement(ConfirmHost, { key: 'confirm' }),
      createElement(ShareEditModal, { key: 'editor', noteId, noteTitle: 'Draft', onClose, onSaved }),
    ]));
  });
}

async function settle(): Promise<void> {
  await act(async () => {});
}

const buttons = () => [...document.body.querySelectorAll('button')];
const button = (label: string) => buttons().find((node) => node.textContent?.includes(label));
const switchByLabel = (label: string) => document.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`);
const passcodeField = () => document.querySelector<HTMLInputElement>('input[type="password"]');
const linkField = () => document.querySelector<HTMLInputElement>('input[readonly]');
const radio = (label: string) => buttons().find((node) => node.getAttribute('role') === 'radio' && node.textContent === label);

function typeInto(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

async function click(node: Element | null | undefined): Promise<void> {
  expect(node, 'the control the reader would press').toBeTruthy();
  await act(async () => { node!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
}

beforeEach(async () => {
  installTestGlobals();
  await initI18n();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  onClose = vi.fn();
  onSaved = vi.fn();
  useUi.setState({ toasts: [] });
  for (const mock of Object.values(calls)) mock.mockReset();
  calls.get.mockImplementation((id: string) => Promise.resolve({ share: shareOf(id) }));
  calls.create.mockImplementation((id: string) => Promise.resolve({ share: shareOf(id) }));
  calls.remove.mockResolvedValue({ ok: true });
  calls.organize.mockImplementation((id: string, body: { folderId: string | null; tags: string[] }) =>
    Promise.resolve({ filing: { noteId: id, slug: `slug-${id}`, folderId: body.folderId, tags: body.tags } }));
  calls.setEnabled.mockResolvedValue({ ok: true, count: 1 });
  calls.folders.mockResolvedValue({ folders: [
    { id: 'f1', parentId: null, name: 'Essays', position: 0, createdAt: 1, updatedAt: 1 },
    { id: 'f2', parentId: null, name: 'Drafts', position: 1, createdAt: 1, updatedAt: 1 },
  ] });
  calls.tags.mockResolvedValue({ tags: [
    { id: 't1', name: 'reading', isPinned: false, createdAt: 1 },
    { id: 't2', name: 'shared', isPinned: false, createdAt: 1 },
  ] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

const toastTitles = () => useUi.getState().toasts.map((item) => item.title);

describe('the way the app actually mounts it', () => {
  // main.tsx wraps the app in StrictMode: every effect mounts, tears down, and mounts again with no
  // render in between. A guard ref that only a render restores is then cleared for good, so the answer
  // that arrives is compared against a note id that no longer exists and thrown away — the editor
  // waits forever for a link the server already sent.
  it('shows the link it was asked for', async () => {
    await act(async () => {
      root.render(createElement(StrictMode, null, createElement(Fragment, null, [
        createElement(ConfirmHost, { key: 'confirm' }),
        createElement(ShareEditModal, { key: 'editor', noteId: 'n1', noteTitle: 'Draft', onClose, onSaved }),
      ])));
    });
    await settle();
    await settle();
    const text = document.body.textContent ?? '';
    expect(text, 'still waiting on the read').not.toContain(t('share.loading_share_status'));
    expect(linkField()?.value ?? 'no link field rendered').toBe('https://notes.test/s/n1');
  });
});

describe('the passcode ladder is cleared before anything leaves', () => {
  it('refuses four characters, because the rule the server uses is eight', async () => {
    await open();
    await settle();
    await click(switchByLabel(t('common.access_passcode')));
    const field = passcodeField();
    expect(field).toBeTruthy();
    act(() => typeInto(field!, 'abcd'));
    await click(button(t('share.update_settings')));
    expect(calls.create).not.toHaveBeenCalled();
    expect(toastTitles()).toContain(t('share.passcode_too_short'));
  });

  it('asks for a passcode rather than silently publishing an open link', async () => {
    await open();
    await settle();
    await click(switchByLabel(t('common.access_passcode')));
    await click(button(t('share.update_settings')));
    expect(calls.create).not.toHaveBeenCalled();
    expect(toastTitles()).toContain(t('share.enter_a_passcode'));
  });

  it('sends a passcode that clears the shared minimum, and states that minimum in its hint', async () => {
    await open();
    await settle();
    await click(switchByLabel(t('common.access_passcode')));
    // The number a reader is told is the number the pre-check enforces, read from the same constant.
    expect(document.body.textContent).toContain(t('share.editor_passcode_min', { min: LIMITS.sharePasscodeMinLength }));
    act(() => typeInto(passcodeField()!, 'correct horse'));
    await click(button(t('share.update_settings')));
    expect(calls.create).toHaveBeenCalledWith('n1', {
      password: 'correct horse',
      // No expiry was chosen: that is "never expires", which the server reads as null.
      expiresIn: null,
    });
  });

  it('turning the passcode off is a clear, not a blank', async () => {
    calls.get.mockImplementation((id: string) => Promise.resolve({ share: shareOf(id, { hasPassword: true }) }));
    await open();
    await settle();
    await click(switchByLabel(t('common.access_passcode')));
    await click(button(t('share.update_settings')));
    expect(calls.create).toHaveBeenCalledWith('n1', { password: null, expiresIn: null });
  });
});

describe('expiry', () => {
  it('keeping the current expiry sends no expiry at all', async () => {
    const later = Date.now() + 5 * 24 * 3600000;
    calls.get.mockImplementation((id: string) => Promise.resolve({ share: shareOf(id, { expiresAt: later }) }));
    await open();
    await settle();
    const keep = radio(t('share.keep_current_expiration'));
    expect(keep).toBeTruthy();
    expect(keep!.getAttribute('aria-checked')).toBe('true');
    await click(button(t('share.update_settings')));
    const body = calls.create.mock.calls[0][1] as { expiresIn: number | null | undefined };
    // A number, not null: null is the server's "make it never expire", which would erase a date the
    // reader never touched.
    expect(body.expiresIn).toBeUndefined();
  });

  it('choosing a window sends that many milliseconds', async () => {
    await open();
    await settle();
    await click(radio(t('share.7_days')));
    await click(button(t('share.update_settings')));
    expect(calls.create.mock.calls[0][1]).toEqual({ password: null, expiresIn: 7 * 24 * 3600000 });
  });
});

describe('pausing one link', () => {
  it('asks the batch endpoint for exactly the note it is editing', async () => {
    await open();
    await settle();
    await click(switchByLabel(t('share.editor_link_status')));
    await click(button(t('share.update_settings')));
    expect(calls.setEnabled).toHaveBeenCalledTimes(1);
    const [ids, enabled] = calls.setEnabled.mock.calls[0] as [string[], boolean];
    expect(ids).toEqual(['n1']);
    expect(enabled).toBe(false);
    // Nothing else moved, so nothing else was written.
    expect(calls.organize).not.toHaveBeenCalled();
  });

  it('does not call the batch endpoint when the switch was left alone', async () => {
    await open();
    await settle();
    await click(button(t('share.update_settings')));
    expect(calls.setEnabled).not.toHaveBeenCalled();
  });

  it('says what the server reported when it moved fewer links than were named', async () => {
    calls.setEnabled.mockResolvedValue({ ok: true, count: 0 });
    await open();
    await settle();
    await click(switchByLabel(t('share.editor_link_status')));
    await click(button(t('share.update_settings')));
    expect(toastTitles()).toContain(t('share.editor_partial_save'));
    expect(useUi.getState().toasts.at(-1)?.description).toContain(t('share.editor_status_count', { count: 0 }));
  });
});

describe('filing', () => {
  it('writes a folder through the organize call, and only when it changed', async () => {
    await open();
    await settle();
    const trigger = buttons().find((node) => node.getAttribute('aria-haspopup') === 'menu');
    await click(trigger);
    await settle();
    const row = [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemcheckbox"]')]
      .find((node) => node.textContent === 'Essays');
    expect(row).toBeTruthy();
    await click(row);
    await settle();
    await click(button(t('share.update_settings')));
    expect(calls.organize).toHaveBeenCalledWith('n1', { folderId: 'f1', tags: [] });
  });

  it('carries the tag selection to the same write', async () => {
    await open();
    await settle();
    const row = [...document.body.querySelectorAll('[role="checkbox"]')].find((node) => node.textContent?.includes('reading'));
    await click(row);
    await settle();
    await click(button(t('share.update_settings')));
    expect(calls.organize).toHaveBeenCalledWith('n1', { folderId: null, tags: ['reading'] });
  });

  it('adds a tag typed into the field', async () => {
    await open();
    await settle();
    const field = document.querySelector<HTMLInputElement>(`input[aria-label="${t('share.editor_new_tag')}"]`);
    expect(field).toBeTruthy();
    act(() => typeInto(field!, 'winter'));
    await click(button(t('share.editor_add_tag')));
    await settle();
    expect(document.body.textContent).toContain('winter');
  });
});

describe('revoking', () => {
  it('asks first, and only removes after the answer', async () => {
    await open();
    await settle();
    await click(button(t('share.revoke_link')));
    expect(calls.remove).not.toHaveBeenCalled();
    const dialog = [...document.body.querySelectorAll('[role="dialog"]')]
      .find((node) => node.textContent?.includes(t('share.revoke_this_public_link')));
    expect(dialog).toBeTruthy();
    const confirmButton = [...dialog!.querySelectorAll('button')].find((node) => node.textContent?.includes(t('share.revoke_link')));
    await click(confirmButton);
    expect(calls.remove).toHaveBeenCalledWith('n1');
    expect(toastTitles()).toContain(t('share.link_revoked'));
    expect(onSaved).toHaveBeenCalled();
  });

  it('leaves the link alone when the answer is no', async () => {
    await open();
    await settle();
    await click(button(t('share.revoke_link')));
    const dialog = [...document.body.querySelectorAll('[role="dialog"]')]
      .find((node) => node.textContent?.includes(t('share.revoke_this_public_link')));
    const cancelButton = [...dialog!.querySelectorAll('button')].find((node) => node.textContent?.includes(t('common.cancel')));
    await click(cancelButton);
    expect(calls.remove).not.toHaveBeenCalled();
  });

  it('reports the server reason when the revoke is refused', async () => {
    calls.remove.mockRejectedValue(new Error('link is pinned'));
    await open();
    await settle();
    await click(button(t('share.revoke_link')));
    const dialog = [...document.body.querySelectorAll('[role="dialog"]')]
      .find((node) => node.textContent?.includes(t('share.revoke_this_public_link')));
    const confirmButton = [...dialog!.querySelectorAll('button')].find((node) => node.textContent?.includes(t('share.revoke_link')));
    await click(confirmButton);
    await settle();
    expect(toastTitles()).toContain(t('common.action_failed'));
    expect(useUi.getState().toasts.at(-1)?.description).toContain('link is pinned');
  });
});

describe('an answer that arrives late', () => {
  it('is discarded once the editor is showing a different note', async () => {
    const pending = new Map<string, (value: { share: ShareInfo }) => void>();
    calls.get.mockImplementation((id: string) => new Promise((resolve) => { pending.set(id, resolve); }));
    await open('n1');
    await act(async () => {
      root.render(createElement(Fragment, null, [
        createElement(ConfirmHost, { key: 'confirm' }),
        createElement(ShareEditModal, { key: 'editor', noteId: 'n2', noteTitle: 'Draft', onClose, onSaved }),
      ]));
    });
    pending.get('n2')!({ share: shareOf('n2') });
    await settle();
    expect(linkField()?.value).toBe('https://notes.test/s/n2');
    // The first note's answer lands afterwards; the editor is on n2 and stays there.
    pending.get('n1')!({ share: shareOf('n1') });
    await settle();
    // The address field is the row that says which link this editor is on.
    expect(linkField()?.value).toBe('https://notes.test/s/n2');
    expect(button(t('share.revoke_link'))).toBeTruthy();
  });

  it('loads the link it was asked for even when no list has arrived', async () => {
    await open('solo');
    await settle();
    expect(calls.get).toHaveBeenCalledWith('solo', expect.any(AbortSignal));
    expect(linkField()?.value).toBe('https://notes.test/s/solo');
  });
});

describe('the pickers are reachable without a mouse', () => {
  it('moves a folder choice with arrows and Enter', async () => {
    await open();
    await settle();
    const trigger = buttons().find((node) => node.getAttribute('aria-haspopup') === 'menu');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    await click(trigger);
    await settle();
    const rows = [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitemcheckbox"]')];
    expect(rows.length).toBeGreaterThan(1);
    act(() => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); });
    await settle();
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute('role')).toBe('menuitemcheckbox');
    act(() => { focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await settle();
    expect(trigger?.textContent).toContain('Essays');
  });

  it('offers every tag as a checkbox the tab order reaches', async () => {
    await open();
    await settle();
    const rows = [...document.body.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    expect(rows.length).toBe(2);
    // A real button is what makes the browser's own Space and Enter activation apply to the row.
    for (const row of rows) {
      expect(row.tagName).toBe('BUTTON');
      expect(row.disabled).toBe(false);
      expect(row.getAttribute('aria-checked')).toBe('false');
    }
    await click(rows[0]);
    await settle();
    expect(document.querySelector<HTMLButtonElement>('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('refuses a twenty-first tag instead of dropping it quietly', async () => {
    calls.tags.mockResolvedValue({ tags: Array.from({ length: LIMITS.shareTagsMaxPerShare + 2 }, (_, index) => ({
      id: `t${index}`,
      name: `tag${index}`,
      isPinned: false,
      createdAt: 1,
    })) });
    await open();
    await settle();
    const rows = [...document.body.querySelectorAll<HTMLButtonElement>('[role="checkbox"]')];
    for (const row of rows.slice(0, LIMITS.shareTagsMaxPerShare)) await click(row);
    await click(rows[LIMITS.shareTagsMaxPerShare]);
    expect(toastTitles()).toContain(t('share.editor_tag_limit', { max: LIMITS.shareTagsMaxPerShare }));
  });
});

describe('the link row', () => {
  it('says so when the address cannot be handed to the clipboard', async () => {
    await open();
    await settle();
    await click(button(t('common.copy')));
    expect(toastTitles()).toContain(t('preview.could_not_copy'));
  });
});
