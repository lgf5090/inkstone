/**
 * The whole-note mind map document (a note whose title ends in `.elixir`), as
 * opposed to a ```mindmap fence inside a Markdown note.
 *
 * Both hold the same body — mind-elixir's JSON — so parsing and serialization
 * stay with the vendor (./mind-elixir-vendor) and this file only carries what a
 * *document* needs on top: the extension that makes a note one, the fields the
 * library reads off the top level of the file (`direction`, `compact`), and a
 * starting body.
 *
 * Nothing here imports the library or touches the DOM, so the note store can
 * create a file without pulling the mind map chunk down the boot path.
 */
import { randomLocalId } from '../../random-id';
import { MINDMAP_BODY_LIMIT_BYTES } from './nodes';

export const MINDMAP_FILE_EXTENSION = '.elixir';

export type MindmapDocumentDirection = 0 | 1 | 2 | 3;

const DIRECTIONS: MindmapDocumentDirection[] = [0, 1, 2, 3];

export function isMindmapDocumentTitle(title: string | null | undefined): boolean {
    return typeof title === 'string' && title.trim().toLowerCase().endsWith(MINDMAP_FILE_EXTENSION);
}

/** A node id, in the shape the library's own generator produces. It never assigns one itself. */
export function mindmapNodeId(): string {
    return randomLocalId().slice(0, 16);
}

export function createDefaultMindmapDocument(topic: string): string {
    return JSON.stringify({ nodeData: { id: mindmapNodeId(), topic, children: [] } }, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The palettes a document may name for itself; `auto` is stated by naming nothing. */
export type MindmapDocumentPalette = 'light' | 'dark';

/** What a document states about how it is drawn. Absent means the file says nothing. */
export interface MindmapDocumentFields {
    direction?: MindmapDocumentDirection
    compact?: boolean
    palette?: MindmapDocumentPalette
}

/**
 * A write request: `undefined` leaves a field exactly as the file has it and `null`
 * takes it out, which is how "follow the app" is stated for a palette that has no
 * `auto` value of its own.
 */
export interface MindmapDocumentFieldWrite {
    direction?: MindmapDocumentDirection | null
    compact?: boolean | null
    palette?: MindmapDocumentPalette | null
}

/**
 * What the file asks of the library, read without the vendor. A body that is not JSON,
 * or that names a field outside the values the library accepts, answers as nothing was
 * said rather than as a broken document: the drawer reports a body it cannot read, and
 * a control has no business inventing an error of its own.
 */
export function readMindmapDocumentFields(content: string): MindmapDocumentFields {
    return mindmapDocumentFieldsFromExtra(readJsonObject(content) ?? {});
}

/**
 * The same three answers from the fields the drawer already read off the body. A surface
 * that has just parsed its own document asks `readMindmapDocumentFields` to parse it a
 * second time for three scalars, which on a large map is a full re-read of the text on
 * every write — this is the half that needs no JSON, only the top-level keys.
 */
export function mindmapDocumentFieldsFromExtra(extra: Record<string, unknown>): MindmapDocumentFields {
    const fields: MindmapDocumentFields = {};
    if (DIRECTIONS.includes(extra.direction as MindmapDocumentDirection))
        fields.direction = extra.direction as MindmapDocumentDirection;
    if (typeof extra.compact === 'boolean')
        fields.compact = extra.compact;
    const theme = typeof extra.theme === 'string' ? extra.theme.trim().toLowerCase() : '';
    if (theme === 'light' || theme === 'dark')
        fields.palette = theme;
    return fields;
}

/**
 * The same text with the named top-level fields set, cleared or left alone. Everything
 * the write does not name travels byte for byte, because the body is note text:
 * reformatting it on a palette change would read as an edit the author never made.
 * Returns null when the body is not a JSON object, so a caller leaves a document it
 * cannot read alone.
 */
export function writeMindmapDocumentFields(content: string, fields: MindmapDocumentFieldWrite): string | null {
    const parsed = readJsonObject(content);
    if (!parsed)
        return null;
    applyField(parsed, 'direction', fields.direction);
    applyField(parsed, 'compact', fields.compact);
    applyField(parsed, 'theme', fields.palette);
    return JSON.stringify(parsed, null, 2);
}

function applyField(record: Record<string, unknown>, key: string, value: unknown): void {
    if (value === undefined)
        return;
    if (value === null)
        delete record[key];
    else
        record[key] = value;
}

function readJsonObject(content: string): Record<string, unknown> | null {
    const trimmed = content.trim();
    if (!trimmed.startsWith('{'))
        return null;
    // The same ceiling the drawer enforces, applied at this door too: these helpers run on
    // every read of a document, and a body the vendor will refuse is not worth a parse.
    if (trimmed.length > MINDMAP_BODY_LIMIT_BYTES)
        return null;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return isRecord(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}

/**
 * Whether a text could be a mind map body at all. A template is picked by name, and a
 * reader who points it at an ordinary note would otherwise get a file whose canvas says
 * nothing and whose source says prose.
 */
export function isMindmapDocumentBody(content: string): boolean {
    const parsed = readJsonObject(content);
    return Boolean(parsed && isRecord(parsed.nodeData) && typeof parsed.nodeData.topic === 'string');
}

/**
 * The topic of the node with this id, read straight out of a `getData()` result.
 * The actions that work on a selection need the text beside the id — a node is
 * named by its topic, and that is what a generated note or a new link starts from.
 */
export function mindmapNodeTopic(data: unknown, id: string): string | null {
    const root = isRecord(data) ? data.nodeData : null;
    if (!isRecord(root))
        return null;
    const queue: Record<string, unknown>[] = [root];
    while (queue.length > 0) {
        const node = queue.shift()!;
        if (node.id === id)
            return typeof node.topic === 'string' ? node.topic : null;
        const children = Array.isArray(node.children) ? node.children : [];
        for (const child of children) {
            if (isRecord(child))
                queue.push(child);
        }
    }
    return null;
}

/**
 * The document as a fence, which is how it reaches a surface that renders Markdown
 * rather than a map: an embed of a `.elixir` note hands its body to the same
 * drawer a ```mindmap block uses, so the two cannot drift apart.
 */
export function mindmapDocumentAsFence(content: string): string {
    const body = content.replace(/\s+$/, '');
    return `\`\`\`mindmap\n${body}\n\`\`\`\n`;
}
