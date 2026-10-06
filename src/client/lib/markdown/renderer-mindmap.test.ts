import { describe, expect, it } from 'vitest';
import { decodeDataValue } from './data-attr';
import { renderMarkdown } from './renderer';

const JSON_BODY = '{"nodeData":{"topic":"Core Topic","children":[{"topic":"Product"}]}}';
const OUTLINE_BODY = '- Core\n  - Branch';

function block(html: string): Element {
    const frame = document.createElement('div');
    frame.innerHTML = html;
    return frame.querySelector('[data-mindmap]')!;
}

describe('the mindmap fence', () => {
    it('draws a block instead of a code block for both spellings', () => {
        for (const language of ['mindmap', 'mind-elixir']) {
            const node = block(renderMarkdown(`\`\`\`${language}\n${OUTLINE_BODY}\n\`\`\``).html);
            expect(node).not.toBeNull();
            expect(node.classList.contains('mindmap-block')).toBe(true);
        }
    });

    it('carries the body encoded, so a JSON fence survives the sanitizer', () => {
        const node = block(renderMarkdown(`\`\`\`mindmap\n${JSON_BODY}\n\`\`\``).html);
        expect(decodeDataValue(node.getAttribute('data-mindmap') ?? ''))
            .toBe(`${JSON_BODY}\n`);
    });

    it('stamps the format the body will be read as', () => {
        expect(block(renderMarkdown(`\`\`\`mindmap\n${JSON_BODY}\n\`\`\``).html).getAttribute('data-mindmap-mode')).toBe('json');
        expect(block(renderMarkdown(`\`\`\`mindmap\n${OUTLINE_BODY}\n\`\`\``).html).getAttribute('data-mindmap-mode')).toBe('outline');
    });

    it('starts in the loading state, so the block never reads as an empty box', () => {
        const node = block(renderMarkdown(`\`\`\`mindmap\n${OUTLINE_BODY}\n\`\`\``).html);
        expect(node.classList.contains('loading')).toBe(true);
        expect(node.getAttribute('aria-busy')).toBe('true');
        expect(node.querySelector('[data-mindmap-placeholder]')).not.toBeNull();
    });

    it('names the source line the fence sits on, which is how a write finds it again', () => {
        const html = renderMarkdown(`# Title\n\n\`\`\`mindmap\n${OUTLINE_BODY}\n\`\`\``).html;
        expect(block(html).getAttribute('data-line')).toBe('2');
    });

    it('numbers the maps in a document in reading order', () => {
        const frame = document.createElement('div');
        frame.innerHTML = renderMarkdown([
            '```mindmap', OUTLINE_BODY, '```', '',
            '```mindmap', JSON_BODY, '```', '',
            '```mindmap', OUTLINE_BODY, '```',
        ].join('\n')).html;
        const indexes = [...frame.querySelectorAll('[data-mindmap]')].map((node) => node.getAttribute('data-mindmap-index'));
        expect(indexes).toEqual(['0', '1', '2']);
    });

    it('carries the palette a fence states on its info line, as written', () => {
        expect(block(renderMarkdown(`\`\`\`mindmap theme=dark\n${OUTLINE_BODY}\n\`\`\``).html).getAttribute('data-mindmap-theme')).toBe('dark');
        expect(block(renderMarkdown(`\`\`\`mindmap\n${OUTLINE_BODY}\n\`\`\``).html).hasAttribute('data-mindmap-theme')).toBe(false);
    });

    it('keeps a quoted palette annotation intact through the sanitizer', () => {
        expect(block(renderMarkdown(`\`\`\`mindmap theme="dark"\n${OUTLINE_BODY}\n\`\`\``).html).getAttribute('data-mindmap-theme')).toBe('dark');
    });

    it('emits no head, because only a surface that mounts a live map can offer its buttons', () => {
        const node = block(renderMarkdown(`\`\`\`mindmap\n${OUTLINE_BODY}\n\`\`\``).html);
        expect(node.querySelector('.mindmap-block-head')).toBeNull();
        expect(node.querySelector('[data-mindmap-fit]')).toBeNull();
        expect(node.querySelector('[data-mindmap-theme-pick]')).toBeNull();
    });

    it('survives a fence nested in a markdown example without a live head of its own', () => {
        const html = renderMarkdown(['~~~~md-example', '# Doc', '', '```mindmap', OUTLINE_BODY, '```', '~~~~'].join('\n')).html;
        const frame = document.createElement('div');
        frame.innerHTML = html;
        const nested = frame.querySelector('.markdown-example-preview [data-mindmap]');
        expect(nested).not.toBeNull();
        // The nested render numbers its own maps, and the outer document resumes after it.
        expect(nested!.getAttribute('data-mindmap-index')).toBe('0');
    });

    it('continues the numbering after a map inside a markdown example', () => {
        const html = renderMarkdown([
            '~~~~md-example', '```mindmap', OUTLINE_BODY, '```', '~~~~', '',
            '```mindmap', OUTLINE_BODY, '```',
        ].join('\n')).html;
        const frame = document.createElement('div');
        frame.innerHTML = html;
        const outer = [...frame.querySelectorAll(':scope > [data-mindmap], :scope > * [data-mindmap]')]
            .filter((node) => !node.closest('.markdown-example-preview'));
        expect(outer).toHaveLength(1);
        expect(outer[0]!.getAttribute('data-mindmap-index')).toBe('1');
    });

    it('leaves an unknown fence alone', () => {
        const html = renderMarkdown('```notamindmap\nx\n```').html;
        expect(html).not.toContain('data-mindmap');
    });
});
