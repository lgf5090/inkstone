import { describe, expect, it } from 'vitest';
import { MINDMAP_BODY_LIMIT_BYTES } from './nodes';
import {
    createDefaultMindmapDocument,
    isMindmapDocumentBody,
    isMindmapDocumentTitle,
    mindmapDocumentAsFence,
    mindmapNodeTopic,
    readMindmapDocumentFields,
    writeMindmapDocumentFields,
} from './document';

const MAP = JSON.stringify({
    nodeData: { id: 'root', topic: 'Core', children: [{ id: 'a', topic: 'Branch' }] },
    arrows: [{ id: 'x', from: 'root', to: 'a' }],
}, null, 2);

describe('isMindmapDocumentTitle', () => {
    it('recognizes the extension at the end of a title, whatever case it was typed in', () => {
        expect(isMindmapDocumentTitle('Planning.elixir')).toBe(true);
        expect(isMindmapDocumentTitle('Planning.ELIXIR')).toBe(true);
        expect(isMindmapDocumentTitle('  Planning.elixir  ')).toBe(true);
    });

    it('leaves an ordinary note, and a note that merely mentions the extension, alone', () => {
        expect(isMindmapDocumentTitle('Reading notes')).toBe(false);
        expect(isMindmapDocumentTitle('elixir patterns')).toBe(false);
        expect(isMindmapDocumentTitle('')).toBe(false);
        expect(isMindmapDocumentTitle(undefined)).toBe(false);
        expect(isMindmapDocumentTitle(null)).toBe(false);
    });
});

describe('createDefaultMindmapDocument', () => {
    it('gives every node an id, because the library never assigns one itself', () => {
        const body = createDefaultMindmapDocument('Core Topic');
        const parsed = JSON.parse(body) as { nodeData: { id?: string; topic: string } };
        expect(typeof parsed.nodeData.id).toBe('string');
        expect(parsed.nodeData.id).toMatch(/^[0-9a-z]{8,16}$/);
        expect(parsed.nodeData.topic).toBe('Core Topic');
    });

    it('hands out a different id per call, so two new files never share a node', () => {
        const first = JSON.parse(createDefaultMindmapDocument('a')).nodeData.id as string;
        const second = JSON.parse(createDefaultMindmapDocument('a')).nodeData.id as string;
        expect(first).not.toBe(second);
    });

    it('round-trips through the field reader without inventing any field', () => {
        const body = createDefaultMindmapDocument('Core Topic');
        expect(readMindmapDocumentFields(body)).toEqual({});
    });
});

describe('readMindmapDocumentFields', () => {
    it('reads the layout, the spacing and the palette a document names', () => {
        expect(readMindmapDocumentFields('{"nodeData":{"topic":"a"},"direction":3,"compact":true,"theme":"dark"}'))
            .toEqual({ direction: 3, compact: true, palette: 'dark' });
    });

    it('says nothing about a value the library would not accept, rather than guessing one', () => {
        expect(readMindmapDocumentFields('{"nodeData":{"topic":"a"},"direction":"down","compact":"yes","theme":"sepia"}'))
            .toEqual({});
        expect(readMindmapDocumentFields('{"nodeData":{"topic":"a"},"direction":9}')).toEqual({});
    });

    it('treats "auto" as naming no palette, which is how a document follows the app', () => {
        expect(readMindmapDocumentFields('{"nodeData":{"topic":"a"},"theme":"auto"}')).toEqual({});
    });

    it('answers as nothing was said for prose and for broken JSON', () => {
        expect(readMindmapDocumentFields('# Heading\n\n- one')).toEqual({});
        expect(readMindmapDocumentFields('{"nodeData":')).toEqual({});
        expect(readMindmapDocumentFields('[1,2,3]')).toEqual({});
    });
});

describe('writeMindmapDocumentFields', () => {
    it('leaves a field it was not asked about exactly as the file has it', () => {
        const next = writeMindmapDocumentFields(MAP, { direction: 1 });
        expect(next).not.toBeNull();
        expect(readMindmapDocumentFields(next!)).toEqual({ direction: 1 });
        expect(JSON.parse(next!)).toMatchObject({
            nodeData: { id: 'root', topic: 'Core', children: [{ id: 'a', topic: 'Branch' }] },
            arrows: [{ id: 'x', from: 'root', to: 'a' }],
        });
    });

    it('removes a field on null, which is how "follow the app" is stated', () => {
        const pinned = writeMindmapDocumentFields(MAP, { palette: 'dark' })!;
        expect(readMindmapDocumentFields(pinned).palette).toBe('dark');
        expect(readMindmapDocumentFields(writeMindmapDocumentFields(pinned, { palette: null })!)).toEqual({});
    });

    it('is a no-op when it names nothing, so a control that changed its mind writes nothing', () => {
        expect(writeMindmapDocumentFields(MAP, {})).toBe(MAP);
    });

    it('keeps the arrows and the tree across a layout change, and gives them back untouched', () => {
        const down = writeMindmapDocumentFields(MAP, { direction: 3, compact: true })!;
        expect(readMindmapDocumentFields(down)).toEqual({ direction: 3, compact: true });
        const back = writeMindmapDocumentFields(down, { direction: null, compact: null })!;
        expect(JSON.parse(back)).toEqual(JSON.parse(MAP));
    });

    it('refuses to rewrite a body that is not JSON', () => {
        expect(writeMindmapDocumentFields('- just an outline', { direction: 1 })).toBeNull();
        expect(writeMindmapDocumentFields('{"nodeData":', { direction: 1 })).toBeNull();
    });
});

describe('isMindmapDocumentBody', () => {
    it('accepts only a body the drawer could actually read', () => {
        expect(isMindmapDocumentBody(MAP)).toBe(true);
        expect(isMindmapDocumentBody('{"nodeData":{"topic":"a"}}')).toBe(true);
        expect(isMindmapDocumentBody('{"nodeData":"not a node"}')).toBe(false);
        expect(isMindmapDocumentBody('{"arrows":[]}')).toBe(false);
        expect(isMindmapDocumentBody('Prose about maps.')).toBe(false);
    });
});

describe('mindmapNodeTopic', () => {
    it('finds a node by id at any depth', () => {
        const data = { nodeData: { id: 'r', topic: 'Root', children: [{ id: 'a', topic: 'A', children: [{ id: 'd', topic: 'Deep' }] }] } };
        expect(mindmapNodeTopic(data, 'd')).toBe('Deep');
        expect(mindmapNodeTopic(data, 'r')).toBe('Root');
    });

    it('answers null for an id the tree does not hold, and for a body that is not a tree', () => {
        expect(mindmapNodeTopic({ nodeData: { id: 'r', topic: 'Root' } }, 'gone')).toBe(null);
        expect(mindmapNodeTopic(null, 'r')).toBe(null);
        expect(mindmapNodeTopic({ nodeData: [] }, 'r')).toBe(null);
    });
});

describe('the size ceiling', () => {
    it('refuses to parse a body past the limit the drawer enforces, at either door', () => {
        const huge = `{"nodeData":{"topic":"a","note":"${'x'.repeat(MINDMAP_BODY_LIMIT_BYTES)}"}}`;
        expect(readMindmapDocumentFields(huge)).toEqual({});
        expect(writeMindmapDocumentFields(huge, { direction: 1 })).toBeNull();
        expect(isMindmapDocumentBody(huge)).toBe(false);
    });

    it('still reads a body just inside it', () => {
        const room = MINDMAP_BODY_LIMIT_BYTES - 200;
        const body = `{\"nodeData\":{\"topic\":\"a\"},\"direction\":3,\"pad\":\"${'y'.repeat(room)}\"}`;
        expect(body.length).toBeLessThan(MINDMAP_BODY_LIMIT_BYTES);
        expect(readMindmapDocumentFields(body)).toEqual({ direction: 3 });
    });
});

describe('mindmapDocumentAsFence', () => {
    it('wraps the body so an embed reaches the same drawer a block does', () => {
        expect(mindmapDocumentAsFence('{"nodeData":{"topic":"a"}}\n')).toBe('```mindmap\n{"nodeData":{"topic":"a"}}\n```\n');
    });

    it('does not leave a second blank line behind a body that already ended cleanly', () => {
        expect(mindmapDocumentAsFence('{\n  "a": 1\n}')).toBe('```mindmap\n{\n  "a": 1\n}\n```\n');
    });
});
