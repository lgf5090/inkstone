/**
 * Which fences the JSON preview is offered on.
 *
 * Its own module with no imports at all, because the markdown renderer needs this list on the first
 * paint of every note while the reader that consumes it — the parser, the tree, the map — is a chunk
 * fetched only when someone actually opens one of those views. Importing the model here would put a
 * document tree and a layout engine on the start-up path of a note that has no JSON in it.
 */
export const JSON_VIEW_LANGUAGES = ['json', 'jsonc', 'json5'] as const;

export type JsonViewLanguage = (typeof JSON_VIEW_LANGUAGES)[number];

export function isJsonViewLanguage(language: string): boolean {
    return (JSON_VIEW_LANGUAGES as readonly string[]).includes(language);
}
