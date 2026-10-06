import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeDataValue } from '../../lib/markdown/data-attr';
import { renderMarkdown } from '../../lib/markdown/renderer';
import { showMindmapError, showMindmapSource } from '../../lib/markdown/mindmap/view';
import { t } from '../../lib/i18n';
import {
    applyMindmapSourceStates,
    mindmapSourceStates,
    mindmapToolbar,
} from './mindmap-block-toolbar';
import { patchChildren } from './Preview';
import type { BlockActionContext } from './block-overlay';

const { session, fitMindmapBlock, retryMindmap } = vi.hoisted(() => ({
    session: {
        ready: true,
        editable: true,
        mode: 'outline' as 'outline' | 'json',
        bodies: { outline: '- Core', json: '{"nodeData":{"topic":"Core"}}' } as Record<string, string>,
        applyResult: 'written' as string,
    },
    fitMindmapBlock: vi.fn(),
    retryMindmap: vi.fn(async () => {}),
}));

vi.mock('../../lib/markdown/mindmap', async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    fitMindmapBlock,
    retryMindmap,
    openMindmapSession: () => ({
        isReady: () => session.ready,
        isEditable: () => session.editable,
        mode: () => session.mode,
        title: () => 'Core',
        serialize: (mode: string) => session.bodies[mode] ?? null,
        apply: () => session.applyResult,
        exportPng: async () => null,
    }),
}));

const OUTLINE_BODY = '- Core\n  - Branch';

function host(bodies: string[] = [OUTLINE_BODY]): HTMLElement {
    const root = document.createElement('div');
    root.className = 'ink-prose';
    root.innerHTML = renderMarkdown(bodies.map((body) => `\`\`\`mindmap\n${body}\n\`\`\``).join('\n\n')).html;
    document.body.append(root);
    mindmapToolbar.enhance(root, { chart: true });
    return root;
}

function context(over: Partial<BlockActionContext> = {}): BlockActionContext {
    const body = `\`\`\`mindmap\n${OUTLINE_BODY}\n\`\`\``;
    return {
        content: body,
        sourceNoteId: 'n1',
        committedSourceRef: { current: body },
        api: { editContent: vi.fn(), toast: vi.fn() },
        mindmap: { fullscreen: vi.fn(), themeMenu: vi.fn() },
        ...over,
    };
}

function click(root: HTMLElement, selector: string, ctx = context()): { prevented: boolean; handled: boolean } {
    const target = root.querySelector<HTMLElement>(selector)!;
    let prevented = false;
    const handled = mindmapToolbar.handle({ preventDefault: () => { prevented = true; } }, target, ctx);
    return { prevented, handled };
}

afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
    session.ready = true;
    session.editable = true;
    session.mode = 'outline';
    session.applyResult = 'written';
});

describe('the mind map head', () => {
    it('wraps the block and builds the head inside it, where the registry can find it', () => {
        const root = host();
        const wrapper = root.querySelector('.mindmap-block-wrap')!;
        const block = wrapper.querySelector<HTMLElement>('[data-mindmap]')!;
        expect(block.querySelector('.mindmap-block-head')).not.toBeNull();
        expect(block.querySelector('[data-mindmap-placeholder]')).not.toBeNull();
    });

    it('offers every press the family has', () => {
        const root = host();
        const actions = [...root.querySelectorAll<HTMLElement>('[data-mindmap-action]')]
            .map((button) => button.dataset.mindmapAction);
        expect(actions).toEqual(['convert-format', 'theme-pick', 'toggle-source', 'export-image', 'fit', 'fullscreen']);
    });

    it('names the format it will switch to, not the one the body is in', () => {
        const root = host();
        const convert = root.querySelector<HTMLElement>('[data-mindmap-action="convert-format"]')!;
        expect(convert.textContent).toBe(t('preview.mindmap_mode_json'));
        expect(convert.getAttribute('aria-label')).toBe(t('preview.mindmap_convert_json'));
    });

    it('labels the palette control with the name the fence has no body statement for', () => {
        const root = host();
        const palette = root.querySelector<HTMLElement>('[data-mindmap-theme-pick]')!;
        expect(palette.textContent).toBe(t('preview.mindmap_theme_auto'));
        expect(palette.getAttribute('aria-haspopup')).toBe('menu');
        expect(palette.getAttribute('aria-expanded')).toBe('false');
    });

    it('builds no source panel until one is asked for', () => {
        const root = host();
        expect(root.querySelector('[data-mindmap-source]')).toBeNull();
    });

    it('is idempotent, because the enhancer runs on every preview pass', () => {
        const root = host();
        mindmapToolbar.enhance(root, { chart: true });
        expect(root.querySelectorAll('.mindmap-block-wrap')).toHaveLength(1);
        expect(root.querySelectorAll('.mindmap-block-head')).toHaveLength(1);
    });

    it.each(['note-embed-body', 'markdown-example-preview'])('builds no head for a map mirrored in a %s', (className) => {
        const root = document.createElement('div');
        root.className = 'ink-prose';
        root.innerHTML = `<div class="${className}">${renderMarkdown(`\`\`\`mindmap\n${OUTLINE_BODY}\n\`\`\``).html}</div>`;
        document.body.append(root);
        mindmapToolbar.enhance(root, { chart: true });
        expect(root.querySelector('.mindmap-block-head')).toBeNull();
        expect(root.querySelector('.mindmap-block-wrap')).toBeNull();
    });

    // Every press in that bar needs a live instance, so a block that has fallen back to its source or
    // an error banner must not be left holding a row of buttons that answer to nothing.
    it.each([showMindmapError, showMindmapSource])('drops the whole head bar in a degraded state (%s)', (degrade) => {
        const root = host();
        const block = root.querySelector<HTMLElement>('[data-mindmap]')!;
        expect(block.querySelector('.mindmap-block-head')).not.toBeNull();
        degrade(block, 'nope');
        expect(block.querySelector('.mindmap-block-head')).toBeNull();
        expect(block.querySelectorAll('[data-mindmap-action]')).toHaveLength(0);
    });
});

describe('the source panel', () => {
    it('shows the fence body the block was rendered from', () => {
        const root = host();
        click(root, '[data-mindmap-action="toggle-source"]');
        expect(root.querySelector('[data-mindmap-source] code')!.textContent).toBe(OUTLINE_BODY);
    });

    it('opens and closes, carrying the state the prose diff has to preserve', () => {
        const root = host();
        const wrapper = root.querySelector('.mindmap-block-wrap')!;
        const trigger = root.querySelector<HTMLElement>('[data-mindmap-action="toggle-source"]')!;
        click(root, '[data-mindmap-action="toggle-source"]');
        expect(wrapper.classList.contains('is-block-source-open')).toBe(true);
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        click(root, '[data-mindmap-action="toggle-source"]');
        expect(wrapper.classList.contains('is-block-source-open')).toBe(false);
        expect(root.querySelector('[data-mindmap-source]')!.hasAttribute('hidden')).toBe(true);
    });

    it('survives a re-render keyed by the line the block sits on', () => {
        const root = host();
        click(root, '[data-mindmap-action="toggle-source"]');
        const states = mindmapSourceStates(root);
        expect([...states.values()]).toEqual([true]);

        const next = host();
        applyMindmapSourceStates(next, states);
        expect(next.querySelector('.mindmap-block-wrap')!.classList.contains('is-block-source-open')).toBe(true);
        expect(next.querySelector('[data-mindmap-source] code')!.textContent).toBe(OUTLINE_BODY);
    });

    it('says nothing about a block it never built a panel for', () => {
        const root = host();
        expect(mindmapSourceStates(root).size).toBe(0);
    });
});

describe('click routing', () => {
    it('takes the presses that belong to the family and no others', () => {
        const root = host();
        let prevented = false;
        expect(mindmapToolbar.handle({ preventDefault: () => { prevented = true; } }, document.createElement('div'), context())).toBe(false);
        expect(prevented).toBe(false);
        expect(click(root, '[data-mindmap-action="fit"]').handled).toBe(true);
    });

    it('swallows a press inside the canvas, so the library keeps its own nodes', () => {
        const root = host();
        const canvas = document.createElement('div');
        canvas.dataset.mindmapCanvas = '1';
        root.querySelector('[data-mindmap-placeholder]')!.append(canvas);
        const node = document.createElement('me-tpc');
        canvas.append(node);
        let prevented = false;
        expect(mindmapToolbar.handle({ preventDefault: () => { prevented = true; } }, node, context())).toBe(true);
        expect(prevented).toBe(false);
    });

    it('hands a node that links to another note back to the preview', () => {
        const root = host();
        const canvas = document.createElement('div');
        canvas.dataset.mindmapCanvas = '1';
        const link = document.createElement('a');
        link.setAttribute('data-mindmap-node-link', '1');
        canvas.append(link);
        root.querySelector('[data-mindmap-placeholder]')!.append(canvas);
        expect(mindmapToolbar.handle({ preventDefault: () => {} }, link, context())).toBe(false);
    });

    it('routes the library’s own full screen button to the same overlay as the head’s', () => {
        const root = host();
        const canvas = document.createElement('div');
        canvas.dataset.mindmapCanvas = '1';
        const native = document.createElement('div');
        native.id = 'fullscreen';
        canvas.append(native);
        root.querySelector('[data-mindmap-placeholder]')!.append(canvas);
        const ctx = context();
        expect(mindmapToolbar.handle({ preventDefault: () => {} }, native, ctx)).toBe(true);
        expect(ctx.mindmap!.fullscreen).toHaveBeenCalledOnce();
    });

    it('asks the surface for the palette menu rather than building one in the prose', () => {
        const root = host();
        const ctx = context();
        click(root, '[data-mindmap-action="theme-pick"]', ctx);
        expect(ctx.mindmap!.themeMenu).toHaveBeenCalledOnce();
    });

    it('rebuilds a block whose render failed', () => {
        const root = host();
        const retry = document.createElement('button');
        retry.dataset.mindmapRetry = '1';
        root.querySelector('[data-mindmap-placeholder]')!.append(retry);
        expect(click(root, '[data-mindmap-retry]').handled).toBe(true);
        expect(retryMindmap).toHaveBeenCalledOnce();
    });

    it('collapses an open panel when the press lands outside the block', () => {
        const root = host();
        click(root, '[data-mindmap-action="toggle-source"]');
        const wrapper = root.querySelector('.mindmap-block-wrap')!;
        mindmapToolbar.dismiss(document.createElement('div'));
        expect(wrapper.classList.contains('is-block-source-open')).toBe(true);
        const outside = document.createElement('p');
        root.append(outside);
        mindmapToolbar.dismiss(outside);
        expect(wrapper.classList.contains('is-block-source-open')).toBe(false);
    });

    it('returns the trigger to the keyboard when Escape closes the panel', () => {
        const root = host();
        click(root, '[data-mindmap-action="toggle-source"]');
        const trigger = root.querySelector<HTMLElement>('[data-mindmap-action="toggle-source"]')!;
        expect(mindmapToolbar.close(trigger)).toBe(trigger);
        expect(mindmapToolbar.close(document.createElement('div'))).toBeNull();
    });
});

describe('the presses that reach the note', () => {
    it('converts through the live map, so an unsaved topic is not lost', () => {
        const root = host();
        const ctx = context();
        click(root, '[data-mindmap-action="convert-format"]', ctx);
        const toast = ctx.api.toast as ReturnType<typeof vi.fn>;
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({
            title: t('preview.mindmap_convert_done', { format: t('preview.mindmap_mode_json') }),
        }));
    });

    it('offers an undo that writes the previous body back', () => {
        const root = host();
        const ctx = context();
        click(root, '[data-mindmap-action="convert-format"]', ctx);
        const toast = ctx.api.toast as ReturnType<typeof vi.fn>;
        const action = toast.mock.calls[0]![0].action;
        expect(action.label).toBe(t('common.undo'));
        expect(() => action.run()).not.toThrow();
    });

    it('declines when the note has moved ahead of the preview', () => {
        const root = host();
        const ctx = context({ committedSourceRef: { current: 'something else entirely' } });
        click(root, '[data-mindmap-action="convert-format"]', ctx);
        const toast = ctx.api.toast as ReturnType<typeof vi.fn>;
        expect(toast).toHaveBeenCalledWith(expect.objectContaining({
            title: t('preview.the_preview_is_updating_try_again_in_a_moment'),
        }));
    });

    it('declines a conversion the note refused, saying the map moved', () => {
        const root = host();
        session.applyResult = 'conflict';
        const ctx = context();
        click(root, '[data-mindmap-action="convert-format"]', ctx);
        expect(ctx.api.toast).toHaveBeenCalledWith(expect.objectContaining({
            title: t('preview.mindmap_source_moved'),
        }));
    });

    it('declines for a map that has not drawn yet, rather than converting the stale body', () => {
        const root = host();
        session.ready = false;
        const ctx = context();
        click(root, '[data-mindmap-action="convert-format"]', ctx);
        expect(ctx.api.toast).toHaveBeenCalledWith(expect.objectContaining({
            title: t('preview.mindmap_edit_unavailable'),
        }));
    });

    it('declines for a read-only map, which has nothing it could write', () => {
        const root = host();
        session.editable = false;
        const ctx = context();
        click(root, '[data-mindmap-action="convert-format"]', ctx);
        expect(ctx.api.toast).toHaveBeenCalledWith(expect.objectContaining({
            title: t('preview.mindmap_edit_unavailable'),
        }));
    });

    it('says so when the library produced no picture', async () => {
        const root = host();
        const ctx = context();
        click(root, '[data-mindmap-action="export-image"]', ctx);
        await vi.waitFor(() => {
            expect(ctx.api.toast).toHaveBeenCalledWith(expect.objectContaining({
                title: t('preview.mindmap_export_failed'),
            }));
        });
    });

    it('asks the registry to fit the drawing', () => {
        const root = host();
        click(root, '[data-mindmap-action="fit"]');
        expect(fitMindmapBlock).toHaveBeenCalledOnce();
    });
});

describe('the body the block carries', () => {
    it('is the fence text with markdown-it’s trailing line feed removed', () => {
        const root = host();
        const block = root.querySelector<HTMLElement>('[data-mindmap]')!;
        expect(decodeDataValue(block.getAttribute('data-mindmap')!)).toBe(`${OUTLINE_BODY}\n`);
        click(root, '[data-mindmap-action="toggle-source"]');
        expect(root.querySelector('[data-mindmap-source] code')!.textContent).toBe(OUTLINE_BODY);
    });
});

describe('the swap the preview makes after every keystroke', () => {
    const fence = (body: string, info = 'mindmap') => `\`\`\`${info}\n${body}\n\`\`\`\n`;

    /** Staged markup: what the next diff compares against, head included. */
    function staged(note: string): HTMLElement {
        const root = document.createElement('div');
        root.className = 'ink-prose';
        root.innerHTML = renderMarkdown(note).html;
        mindmapToolbar.enhance(root, { chart: true });
        return root;
    }

    /** The live host after the registry mounted a map into every block it holds. */
    function mountedLive(note: string): HTMLElement {
        const root = staged(note);
        root.querySelectorAll<HTMLElement>('[data-mindmap]').forEach((block) => {
            block.classList.remove('loading');
            block.classList.add('is-ready');
            const canvas = document.createElement('div');
            canvas.className = 'mindmap-canvas';
            canvas.dataset.mindmapCanvas = '1';
            block.querySelector('[data-mindmap-placeholder]')!.replaceChildren(canvas);
        });
        return root;
    }

    it('keeps the subtree of a map whose body did not change', () => {
        const note = fence(OUTLINE_BODY);
        const live = mountedLive(note);
        const canvas = live.querySelector('[data-mindmap-canvas]')!;
        patchChildren(live, staged(note));
        expect(live.querySelector('[data-mindmap-canvas]')).toBe(canvas);
        expect(live.querySelector<HTMLElement>('[data-mindmap]')!.classList.contains('is-ready')).toBe(true);
    });

    // A format toggle above moves this block. The line is what the write-back resolves the fence
    // against, so a preserved subtree that kept the old one would report a block that had not moved.
    it('re-stamps the line a shift above moved, though the map itself is unchanged', () => {
        const second = fence(OUTLINE_BODY);
        const before = `# T\n\n${fence('- Other')}\n${second}`;
        const after = `# T\n\n${fence('- A\n- B\n- C')}\n${second}`;
        const lineOf = (note: string, index: number) => [...staged(note).querySelectorAll<HTMLElement>('[data-mindmap]')][index]!.dataset.line;
        expect(Number(lineOf(before, 1))).toBeLessThan(Number(lineOf(after, 1)));

        const live = mountedLive(before);
        const blocks = () => [...live.querySelectorAll<HTMLElement>('[data-mindmap]')];
        const canvas = blocks()[1]!.querySelector('[data-mindmap-canvas]')!;
        expect(blocks()[1]!.dataset.line).toBe(lineOf(before, 1));

        patchChildren(live, staged(after));
        const kept = blocks()[1]!;
        expect(kept.dataset.line).toBe(lineOf(after, 1));
        expect(kept.querySelector('[data-mindmap-canvas]')).toBe(canvas);
    });

    it('releases the subtree when the edited body no longer matches, so the map reloads', () => {
        const live = mountedLive(fence(OUTLINE_BODY));
        patchChildren(live, staged(fence('- Replaced')));
        const block = live.querySelector<HTMLElement>('[data-mindmap]')!;
        expect(block.querySelector('[data-mindmap-canvas]')).toBeNull();
        expect(block.classList.contains('is-ready')).toBe(false);
    });

    it('releases it when only the palette moved, since that is what the map must be told', () => {
        const live = mountedLive(fence(OUTLINE_BODY));
        patchChildren(live, staged(fence(OUTLINE_BODY, 'mindmap theme=dark')));
        expect(live.querySelector('[data-mindmap-canvas]')).toBeNull();
    });

    it('keeps a source panel the reader opened open across the swap', () => {
        const note = fence(OUTLINE_BODY);
        const live = mountedLive(note);
        click(live, '[data-mindmap-action="toggle-source"]');
        expect(live.querySelector('.mindmap-block-wrap')!.classList.contains('is-block-source-open')).toBe(true);
        const staging = staged(note);
        applyMindmapSourceStates(staging, mindmapSourceStates(live));
        patchChildren(live, staging);
        expect(live.querySelector('.mindmap-block-wrap')!.classList.contains('is-block-source-open')).toBe(true);
        expect(live.querySelector('[data-mindmap-source]')!.hasAttribute('hidden')).toBe(false);
        expect(live.querySelector<HTMLElement>('[data-mindmap-action="toggle-source"]')!.getAttribute('aria-expanded')).toBe('true');
    });
});
