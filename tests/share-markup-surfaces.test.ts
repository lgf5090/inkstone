// @vitest-environment node
/**
 * The seam between a public share page and the rule that keeps its reader out of the notebook.
 *
 * `share-markdown.ts` is the whole engine, and an engine with no call site is a rule nobody runs: the
 * payload behind a share link carries the turns' text and nothing about the notes behind them, so the
 * only thing standing between a stranger and a 26-character note handle is the transform folded into the
 * markup before anything draws it. A file that renders a document without it — or that folds in one
 * third of it — passes every test of the engine itself.
 *
 * So this scans the surfaces, the way `kanban-render-channel.test.ts` scans the enhancement calls: every
 * document a share page hands out must go through `prepareShareMarkup`, the text-only half must be
 * applied to the words that never reach a renderer, and the two pages must still be the ones the app
 * mounts on a public link. What the rule *does* is pinned by `share-markdown.test.ts` and by each page's
 * own render test; what is pinned here is that a stranger can walk into them, and that nobody can add a
 * third page that forgets to.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SHARE_DIR = path.join('src', 'client', 'features', 'share')
const RULE = path.join(SHARE_DIR, 'share-markdown.ts')
const APP = path.join('src', 'client', 'App.tsx')

/** The pages a visitor with no account is served — not the panels the owner edits behind a login. */
function publicPages(): Array<{ file: string, source: string }> {
  return fs.readdirSync(SHARE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('Page.tsx'))
    .map((entry) => {
      const file = path.join(SHARE_DIR, entry.name)
      return { file, source: fs.readFileSync(file, 'utf8') }
    })
    .sort((left, right) => left.file.localeCompare(right.file))
}

/** One public page by its file name, or `undefined` when the surface has gone. */
function pageNamed(name: string): { file: string, source: string } | undefined {
  return publicPages().find((page) => path.basename(page.file) === name)
}

/** Every `<MarkdownBody …>` a public page draws, with the attributes it was written with. */
function markdownBodies(): Array<{ file: string, call: string }> {
  return publicPages().flatMap(({ file, source }) =>
    [...source.matchAll(/<MarkdownBody\b[\s\S]*?\/>/g)].map((match) => ({ file, call: match[0] })))
}

/** What a page takes out of `./share-markdown`, as written in its own import line. */
function ruleImports(source: string): string[] {
  const clause = /import\s*\{([^}]*)\}\s*from\s*'\.\/share-markdown'/.exec(source)
  return clause ? clause[1].split(',').map((name) => name.trim()).filter(Boolean) : []
}

describe('the surfaces that hand a stranger a document', () => {
  it('finds both public pages and their markup calls, so the check cannot pass by finding nothing', () => {
    expect(publicPages().map(({ file }) => path.basename(file))).toEqual([
      'CollectionPage.tsx',
      'ConversationSharePage.tsx',
      'SharePage.tsx',
    ])
    expect(markdownBodies().length).toBeGreaterThanOrEqual(2)
  })

  /**
   * One rule, not one of its halves. `neutralizeShareEmbeds` answers a box but leaves the handle that
   * names it, and `prepareShareSource` answers words but never sees markup: a page that reaches for
   * either one alone has published part of the promise and kept the rest.
   *
   * Which half a surface owes follows from what it draws. A page that renders a document owes the
   * composed chain; a page that prints titles and excerpts as text owes the source rule. What no page
   * may do is print an author's words without either one, so that is the assertion that stays universal
   * while the composed-rule requirement attaches to the surfaces that actually render markup.
   */
  it('draws every document through the one composed rule', () => {
    for (const { file, source } of publicPages()) {
      const imported = ruleImports(source)
      expect(
        imported.length,
        `${file} hands a stranger text without running either half of the rule`,
      ).toBeGreaterThan(0)
      const strays = imported.filter((name) => name !== 'prepareShareMarkup' && name !== 'prepareShareSource')
      expect(strays, `${file} runs a single pass of the rule beside the composed one`).toEqual([])
    }
    for (const { file, source } of publicPages()) {
      if (!/<MarkdownBody\b/.test(source)) continue
      expect(
        ruleImports(source),
        `${file} renders markdown without the composed rule`,
      ).toContain('prepareShareMarkup')
    }
    for (const { file, call } of markdownBodies()) {
      expect(call, `${file} draws a document nobody neutralised: ${call}`).toMatch(/transformHtml=\{\s*\w+\s*\}/)
    }
  })

  /**
   * Two paths take no markup at all, and a page can forget each of them without touching a
   * `transformHtml`. A chat turn is drawn as words, not parsed, so the mention the composer wrote into a
   * question — `[[<id>|Title]]` — only goes out through the source rule. And present mode hands the note
   * to the presentation module, which renders its own markup and accepts no transform from the page, so
   * the deck has to be handed a source that has already been read.
   */
  it('applies the source half to the words that never reach this module’s renderer', () => {
    const chat = pageNamed('ConversationSharePage.tsx')
    expect(chat, 'the shared transcript moved and this file did not notice').toBeTruthy()
    expect(chat!.source, 'a user turn is shown verbatim again').toMatch(/prepareShareSource\(/)
    const deck = pageNamed('SharePage.tsx')
    expect(deck, 'the shared note page moved and this file did not notice').toBeTruthy()
    const audience = /<AudienceView\b[\s\S]*?\/>/.exec(deck!.source)?.[0] ?? ''
    expect(audience, 'present mode no longer draws a deck this module cannot reach').toContain('AudienceView')
    expect(audience, 'the deck was handed the note with its handles still in it').toMatch(/source=\{\s*deckSource\s*\}/)
    expect(deck!.source, 'deckSource is not built by the source rule')
      .toMatch(/const deckSource[\s\S]{0,80}prepareShareSource\(/)
  })

  /**
   * The rule is a chain. A pass dropped from the composition leaves every page's `transformHtml` wired
   * and every page test green that does not name the dropped hole, so the chain itself is what is pinned
   * here, and `prepareShareMarkup` is the only place it is allowed to be written.
   */
  it('keeps the composed rule a chain of all three passes', () => {
    const source = fs.readFileSync(RULE, 'utf8')
    const body = /export function prepareShareMarkup\(html: string\): string \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? ''
    for (const pass of ['redactShareMentionMarkup', 'neutralizeShareEmbeds', 'scrubShareHandles']) {
      expect(body, `prepareShareMarkup no longer runs ${pass}`).toContain(pass)
    }
  })

  /** The scan above is only a guard if the pages it reads are the ones a reader can be sent to. */
  it('is reached from a public link the app still routes to', () => {
    const app = fs.readFileSync(APP, 'utf8')
    for (const page of ['SharePage', 'ConversationSharePage', 'CollectionPage']) {
      expect(app, `${page} is no longer loaded from the share feature`)
        .toMatch(new RegExp(`import\\('\\./features/share/[A-Za-z]*${page}'\\)`))
      expect(app, `${page} is loaded but no public address mounts it`)
        .toMatch(new RegExp(`<${page}\\b[^>]*slug=`))
    }
    expect(app, 'a shared address no longer short-circuits the signed-in app').toMatch(/shareSlug \? <SharePage/)
  })
})
