import { EmojiPicker } from '../emoji/EmojiPicker';
import { useSession } from '../../store/session';
import type { SkinTone } from '@shared/types';

export default function PropertyGlyphPanel({ onPick }: {
    onPick: (glyph: string) => void;
}) {
    const tone = useSession(state => state.settings.editor.emojiSkinTone);
    const update = useSession(state => state.updateSettings);
    return (<EmojiPicker tone={tone as SkinTone} onTone={(next) => {
        update({ editor: { emojiSkinTone: next } });
    }} onInsert={(glyph) => {
        onPick(glyph);
    }}/>);
}
