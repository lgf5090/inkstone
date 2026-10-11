/**
 * What the preview can say about a document without changing it.
 *
 * The ported reference had a validator and no way to reach it: `do_save` was the only caller, no Save
 * button was ever built, and so the duplicate-key and empty-key checks it shipped were dead code behind a
 * feature nobody could press. Here the same checks answer to a badge on the block's head, which is what
 * makes them worth running.
 */
import type { JsonIssue, JsonNode, JsonPath } from './types';

/**
 * The document's own problems, as paths the view can jump to.
 *
 * Duplicate keys are the one worth having: `JSON.parse` accepts `{"a":1,"a":2}` and keeps the last, so a
 * reader who converts a note through a value tree loses the first silently. The model keeps both, which
 * means the note round-trips intact and the reader is told about the collision instead of being rescued
 * from it.
 */
export function validateJsonDocument(root: JsonNode): JsonIssue[] {
    const issues: JsonIssue[] = [];
    const walk = (node: JsonNode, path: JsonPath, depth: number): void => {
        if (node.key === '')
            issues.push({ path: [...path], messageKey: 'preview.json_issue_empty_key' });
        if (node.kind === 'number' && typeof node.value === 'number' && !Number.isFinite(node.value))
            issues.push({ path: [...path], messageKey: 'preview.json_issue_not_finite', detail: node.literal ?? undefined });
        if (depth > JSON_ISSUE_DEPTH_WARN)
            issues.push({ path: [...path], messageKey: 'preview.json_issue_deep' });
        if (typeof node.value === 'string' && node.value.length > JSON_ISSUE_TEXT_WARN)
            issues.push({ path: [...path], messageKey: 'preview.json_issue_long_text' });
        if (node.kind !== 'object' || !node.children)
            return;
        const seen = new Map<string, number>();
        node.children.forEach((child, index) => {
            const key = child.key ?? '';
            const first = seen.get(key);
            if (first === undefined)
                seen.set(key, index);
            else
                issues.push({ path: [...path.slice(0, -1), key, index], messageKey: 'preview.json_issue_duplicate_key', detail: key });
            walk(child, [...path, key], depth + 1);
        });
    };
    walk(root, [], 0);
    return issues;
}

/** Where an issue stops being worth mentioning. Both are display thresholds, not data limits. */
const JSON_ISSUE_DEPTH_WARN = 40;
const JSON_ISSUE_TEXT_WARN = 4000;
