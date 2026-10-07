import { useEffect, useState } from 'react';
import { setFrontMatterValue } from '@shared/markdown-utils';
import type { PropertySettings } from '@shared/types';
import type { PropertyDecorationKind } from '../../lib/property-commands';
import { clearPropertyDecoration, peekPropertyDecoration, subscribePropertyDecoration } from '../../lib/property-commands';
import { useNotes } from '../../store/notes';
import { useSession } from '../../store/session';
import { useUi } from '../../store/ui';
import { PropertyImagePicker } from './PropertyImagePicker';
import type { ImagePickerRequest } from './PropertyImagePicker';

function propertyForKind(settings: PropertySettings, kind: PropertyDecorationKind): string {
    if (kind === 'banner')
        return settings.bannerProperty;
    if (kind === 'icon')
        return settings.iconProperty;
    return settings.coverProperties.find(Boolean) ?? '';
}

export function PropertyDecorationHost() {
    const activeNoteId = useUi(state => state.activeNoteId);
    const settings = useSession(state => state.settings.properties);
    const [pending, setPending] = useState<{ kind: PropertyDecorationKind; noteId: string } | null>(() => {
        const request = peekPropertyDecoration();
        return request ? { kind: request.kind, noteId: request.noteId } : null;
    });
    useEffect(() => subscribePropertyDecoration((request) => {
        setPending(request ? { kind: request.kind, noteId: request.noteId } : null);
    }), []);
    const property = pending ? propertyForKind(settings, pending.kind) : '';
    if (!pending || !activeNoteId || pending.noteId !== activeNoteId || !property)
        return null;
    const request: ImagePickerRequest = { property, kind: pending.kind };
    const close = () => {
        clearPropertyDecoration();
        setPending(null);
    };
    return (<PropertyImagePicker request={request} noteId={activeNoteId} onClose={close} onPick={(name, value) => {
        const state = useNotes.getState();
        const content = state.contents[activeNoteId] ?? '';
        const next = setFrontMatterValue(content, name, value);
        if (next !== content)
            state.editContent(activeNoteId, next);
        close();
    }}/>);
}
