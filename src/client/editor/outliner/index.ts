import { codeFolding } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import type { EditorSettings } from '@shared/types';
import { outlinerComposition, outlinerCursorGuard, outlinerKeymap, outlinerOptions, type OutlinerOptionsReader } from './commands';
import { outlinerDragVisual, outlinerDragDrop } from './drag-drop';
import { outlinerGuides } from './guides';
import { listFoldService } from './fold';
import type { OutlinerOptions } from './adapter';

export function outlinerOptionsFrom(settings: EditorSettings): OutlinerOptions {
    return {
        enabled: settings.outliner,
        enter: settings.outlinerEnter,
        shiftEnter: settings.outlinerShiftEnter,
        tab: settings.outlinerTab,
        stickCursor: settings.outlinerCursor,
        selectAll: settings.outlinerSelectAll,
        moveKeys: settings.outlinerMoveKeys,
        foldKeys: settings.outlinerFoldKeys,
        guides: settings.outlinerGuides,
        guideClick: settings.outlinerGuideClick,
        dragDrop: settings.outlinerDrag,
        indentChars: ' '.repeat(settings.tabSize),
    };
}

export function outlinerChrome(read: OutlinerOptionsReader): Extension[] {
    return [
        outlinerOptions.of(read),
        outlinerComposition,
        outlinerCursorGuard,
        outlinerKeymap,
        outlinerGuides,
        outlinerDragVisual,
        outlinerDragDrop,
    ];
}

export const outlinerFoldSupport: Extension[] = [codeFolding(), listFoldService];

export {
    outlinerBackspace,
    outlinerCreateItem,
    outlinerCursorToPrevious,
    outlinerDelete,
    outlinerDeleteToLineStart,
    outlinerEnter,
    outlinerFoldItem,
    outlinerFoldKey,
    outlinerIndentItem,
    outlinerMoveItemDown,
    outlinerMoveItemUp,
    outlinerMoveDown,
    outlinerMoveUp,
    outlinerNoteLine,
    outlinerOutdentEmptyItem,
    outlinerOutdentItem,
    outlinerSelectListItem,
    outlinerShiftTab,
    outlinerTab,
    outlinerUnfoldAll,
    outlinerUnfoldItem,
    outlinerUnfoldKey,
} from './commands';
export { outlinerOptionsChanged } from './commands';
export type { OutlinerOptions } from './adapter';
