/**
 * The one answer a public share page may give to a reference it cannot open.
 *
 * `![[note]]` is drawn as a box that says "Loading", and only the embed pass fills it in or says it
 * cannot — and that pass reads the *viewer's* vault, resolving a title through the note store and then
 * `api.notes.get`. A stranger's page has no vault to read and must not start looking for one: the payload
 * behind a share link carries four fields per turn and deliberately nothing about the notes behind them,
 * and a published transcript has already leaked private note titles and ids once, out of a source card.
 * So the placeholder is answered in the markup, before anything draws it, with the only sentence that is
 * true here: what it pointed at is not part of this share. Left alone, the box spins for the life of the
 * page and reads as a document still arriving.
 *
 * The target attribute goes with it. It is the whole thing the author typed, base64'd — for a mention the
 * composer wrote, that is a note id — and it exists only to be handed back to the resolver, which is
 * precisely the call this page may not make. The head is left as the renderer wrote it: it repeats a name
 * the shared text already contains, and that name is what tells a reader *which* reference is missing.
 *
 * Both public pages run through this one rule, because they are the same promise: a shared note and a
 * shared conversation must not drift into answering one reference two different ways.
 */
import { t } from '../../lib/i18n'

/** Rewrites every embed placeholder of a rendered document into that sentence, in place. */
export function neutralizeShareEmbeds(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const embed of template.content.querySelectorAll<HTMLElement>('.note-embed[data-embed-target]')) {
    embed.removeAttribute('data-embed-target')
    embed.classList.remove('loading')
    embed.classList.add('error')
    const body = embed.querySelector<HTMLElement>('.note-embed-body')
    if (body) {
      body.removeAttribute('aria-busy')
      body.textContent = t('share.embedded_private_notes_are_not_included_in_public_shares')
    }
  }
  return template.innerHTML
}
