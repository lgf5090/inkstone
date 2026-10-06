import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every surface that enhances markdown has to say what it does with a ```kanban fence.
 *
 * A board is a React root, and a root needs a host that mounts it and a fence to write back to. The
 * preview pane has both; a share page, a note card and the editor's live preview have neither, and for
 * as long as `enhancePreview` knew nothing about boards those surfaces sat at "Loading kanban…" with
 * `aria-busy` up forever.
 *
 * This fork's `enhancePreview` also accepts no fence set, so *every* host must register the bodies its
 * markup was rendered from — P-01 moved a board's cards out of the attributes and into that set, and a
 * surface that never registers reads every board as an empty fence. That is the half the reference's
 * version of this gate does not have to check, because it hands the set in as an option instead.
 */
const CLIENT_ROOT = path.resolve('src/client')
const DEFINITION = path.join('lib', 'markdown', 'enhance.ts')
const CALL = /enhancePreview\([\s\S]*?\}\)/g

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) return []
    return [full]
  })
}

function enhancementCalls(): Array<{ file: string, call: string }> {
  return sourceFiles(CLIENT_ROOT).flatMap((file) => {
    if (path.relative(CLIENT_ROOT, file) === DEFINITION) return []
    const text = fs.readFileSync(file, 'utf8')
    return [...text.matchAll(CALL)].map((match) => ({ file: path.relative(CLIENT_ROOT, file), call: match[0] }))
  })
}

describe('kanban render channels', () => {
  it('finds the enhancement call sites, so the check cannot pass by finding nothing', () => {
    expect(enhancementCalls().length).toBeGreaterThanOrEqual(4)
  })

  it('names a kanban channel at every enhancement call site', () => {
    const offenders = enhancementCalls()
      .filter(({ call }) => !/kanban:\s*['"](?:live|snapshot)['"]/.test(call))
      .map(({ file }) => file)
    expect(offenders).toEqual([])
  })

  it('sees the channels it lists', () => {
    const channels = new Map(enhancementCalls().map(({ file, call }) => [file, /kanban:\s*'(\w+)'/.exec(call)?.[1]]))
    expect(Object.fromEntries([...channels].sort())).toEqual({
      [path.join('editor', 'live-preview.ts')]: 'snapshot',
      [path.join('features', 'preview', 'card-content.ts')]: 'snapshot',
      [path.join('features', 'preview', 'Preview.tsx')]: 'live',
      [path.join('features', 'presentation', 'presenter-view', 'use-presenter-slide-media.ts')]: 'snapshot',
      [path.join('features', 'presentation', 'use-slide-html.ts')]: 'snapshot',
      [path.join('features', 'share', 'SharePage.tsx')]: 'snapshot',
    })
  })

  /**
   * The failure this exists for: a surface that asks for the still but never registers the bodies is a
   * board that shows the empty-fence error on every block, on every render, with nothing thrown.
   */
  it('registers the fence bodies on every host it enhances', () => {
    const offenders = enhancementCalls()
      .map(({ file }) => file)
      .filter((file) => !fs.readFileSync(path.join(CLIENT_ROOT, file), 'utf8').includes('registerFenceBodies('))
    expect(offenders).toEqual([])
  })

  /**
   * An exported document carries no script, so it never mounts a board — but it has to draw one, or
   * the reader of a downloaded .html and of a printout gets a box waiting for something that will
   * never arrive. This fork's export path renders its own markup instead of going through
   * `enhancePreview`, so it is not a call site the scan above can see, and both halves of the answer
   * have to be named here: where the bodies come from, and what draws them.
   */
  it('draws a board on the surface that exports without mounting one', () => {
    const text = fs.readFileSync(path.join(CLIENT_ROOT, path.join('lib', 'export-note.ts')), 'utf8')
    expect(text).toMatch(/registerFenceBodies\(/)
    expect(text).toMatch(/renderStaticKanbans\(/)
  })

  /**
   * The projector is read from across a room, so a slide's board has to keep its columns: a card that
   * arrives as a row of the list has lost which column said whether it was done. `kanbanShape` is the
   * only thing that says so, and it is read by `enhancePreview` rather than by the surface, so nothing
   * else would notice it going missing.
   */
  it('asks for the board shape on the surfaces that project a slide', () => {
    for (const file of [
      path.join('features', 'presentation', 'use-slide-html.ts'),
      path.join('features', 'presentation', 'presenter-view', 'use-presenter-slide-media.ts'),
    ]) {
      const text = fs.readFileSync(path.join(CLIENT_ROOT, file), 'utf8')
      expect(text, file).toMatch(/kanbanShape:\s*'board'/)
    }
  })
})
