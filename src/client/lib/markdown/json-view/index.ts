/**
 * The JSON preview's document layer: a note's ```json body read into a tree that can be edited and
 * written back without the untouched parts of it changing.
 *
 * `parse.ts` and `write.ts` are the pair that has to agree — a slice recorded by the reader is the only
 * thing the writer is allowed to emit verbatim — so the round-trip property is asserted directly, in
 * `json-view-roundtrip.test.ts`, over every shape the reader accepts.
 */
export type {
    JsonDocument,
    JsonFailure,
    JsonKind,
    JsonNode,
    JsonParseLimits,
    JsonParseOutcome,
    JsonPath,
    JsonPathSegment,
    JsonRepair,
} from './types';
export {
    childCount,
    defineMember,
    formatJsonPath,
    isContainer,
    isFresh,
    JSON_VIEW_BODY_LIMIT_BYTES,
    JSON_VIEW_MAX_DEPTH,
    JSON_VIEW_MAX_MAP_NODES,
    JSON_VIEW_MAX_NODES,
    pathKey,
} from './types';
export { jsonBodyIsViewable, parseJsonDocument } from './parse';
export {
    nodeFromInput,
    nodeFromValue,
    reindentJsonDocument,
    valueOfNode,
    writeJsonDocument,
    writeJsonNode,
} from './write';
export {
    collapseToDepth,
    countDescendants,
    emptyChild,
    findNode,
    insertChild,
    moveChild,
    parentNode,
    removeChild,
    renameEntry,
    replaceNode,
    setCollapsed,
    siblingOf,
    sortChildren,
    treeDepth,
} from './edit';
export {
    displayKey,
    displaySummary,
    displayValue,
    filterJsonTree,
    isContainerNode,
    JSON_KIND_LABELS,
    JSON_KIND_ORDER,
    JSON_TEXT_PREVIEW,
    nodeMatchesText,
} from './inspect';
export { validateJsonDocument } from './validate';
export type { JsonIssue } from './types';
export {
    layoutJsonMap,
    mapLinkPath,
    MAP_LEVEL_GAP,
    MAP_PADDING,
    MAP_SIBLING_GAP,
    type MapLayout,
    type MapLayoutOptions,
    type MapSlot,
} from './layout';
