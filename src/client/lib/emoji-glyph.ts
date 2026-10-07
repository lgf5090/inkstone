import { LIMITS } from '@shared/constants';

export const ICON_MAX_CODE_UNITS = LIMITS.organizerIconMaxLength;

const ZWJ = '‍';

/**
 * Whether a glyph survives the icon column: the store truncates at eight UTF-16 units, and a
 * zero-width-joiner sequence cut in that range renders as two half pictures. This lives apart from
 * the catalogue itself so the preferences module can ask it without pulling the search code, and
 * with it the fuzzy matcher, onto the boot path.
 */
export function isUsableIconGlyph(char: string): boolean {
    return char.length > 0 && char.length <= ICON_MAX_CODE_UNITS && !char.includes(ZWJ);
}
