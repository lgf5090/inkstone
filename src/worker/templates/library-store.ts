/**
 * Every read and write the account template-library HTTP routes make against D1.
 *
 * The shape follows `share/store.ts` and `transfer/store.ts`: a store built per request from the
 * account it serves, methods that hand back the stored column or the boolean the route needs to
 * answer with, and nothing in between that knows about HTTP. `templates/store.ts` is the community
 * directory — `author_id` across accounts — and shares no row with this one, so the account's own
 * library gets its own file beside it.
 *
 * Both statements are the same `users` row the session already authenticated: `WHERE id = ?1` and
 * `WHERE id = ?2` bind `c.get('userId')`, so one account can neither read nor overwrite another's
 * library. The envelope inside the column — `savedAt` plus the parsed library — is the route's
 * business, which is why the store returns the raw text and takes the raw text back.
 */

export class TemplateLibraryStore {
  constructor(
    private readonly db: D1Database,
    readonly userId: string,
  ) {}

  /** The stored envelope as the column holds it; `null` is "never saved", not "empty library". */
  async readLibrary(): Promise<string | null> {
    const row = await this.db
      .prepare('SELECT template_library FROM users WHERE id = ?1')
      .bind(this.userId)
      .first<{ template_library: string | null }>()
    return row?.template_library ?? null
  }

  /**
   * Replace the stored envelope.
   *
   * `false` means the account row was not there: the update is addressed by id, so a row that
   * vanished between the session read and this write changes nothing, and the route answers 404.
   */
  async writeLibrary(envelope: string): Promise<boolean> {
    const result = await this.db
      .prepare('UPDATE users SET template_library = ?1 WHERE id = ?2')
      .bind(envelope, this.userId)
      .run()
    return Boolean(result.meta?.changes)
  }
}
