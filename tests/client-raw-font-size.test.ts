// @vitest-environment node
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const CLIENT_DIR = path.join('src', 'client')

/**
 * Font sizes come from the scale in `src/client/styles/tokens.css`, never from a typed-in pixel.
 *
 * `AGENTS.md` rule 4 puts every size behind a token, and the client had 1,105 classes that named one
 * outright (`text-[11.5px]`), which is how the same label ended up at four different heights in four
 * panels. All of them now read `text-[length:var(--text-11-5)]`, so there is nothing to allow here:
 * an empty baseline is the point, and a new literal fails this file rather than a review comment.
 *
 * A class list is read wherever it is written, not only where it is applied. Guards that look only at
 * `className` attributes miss `const base = 'fixed z-[255] …'`, which is exactly the shape a shared
 * surface helper tends to grow — and comments are skipped, so the prose about a class cannot fail it.
 */
const RAW_FONT_SIZE_SOURCE = '(?:^|[^\\w-])text-\\[(\\d+(?:\\.\\d+)?)px\\]'

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Every `text-[Npx]` the client writes into a string, as `file:line` with the size it hard-codes. */
function rawFontSizeSites(): Array<{ key: string; size: string }> {
  const sites: Array<{ key: string; size: string }> = []
  for (const file of walkFiles(CLIENT_DIR)) {
    const name = path.relative(process.cwd(), file).replaceAll('\\', '/')
    const text = fs.readFileSync(file, 'utf8')
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const report = (line: number, value: string): void => {
      for (const match of value.matchAll(new RegExp(RAW_FONT_SIZE_SOURCE, 'g'))) {
        sites.push({ key: `${name}:${line}`, size: match[1]! })
      }
    }
    const visit = (node: ts.Node): void => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      if (ts.isStringLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateSpan(node)) {
        report(line, node.getText(source))
      }
      if (ts.isJsxText(node)) report(line, node.getText(source))
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return sites
}

describe('font sizes stay on the token scale', () => {
  it('finds no client file writing a pixel font size into a class', () => {
    const sites = rawFontSizeSites()
    const found = sites.map((site) => `${site.key} sets text-[${site.size}px]`)
    expect(found, `${sites.length} hardcoded font size(s); use text-[length:var(--text-N)]`).toEqual([])
  })

  it('fails loudly when the scan itself stops seeing anything', () => {
    // A guard that reads no files passes forever. The token form is used by hundreds of classes, so a
    // scan that finds none of them is broken rather than the codebase being clean.
    const tokenised = walkFiles(CLIENT_DIR)
      .filter((file) => fs.readFileSync(file, 'utf8').includes('text-[length:var(--text-'))
      .length
    expect(tokenised, 'the scan found no token-backed font size at all, so it cannot be trusted').toBeGreaterThan(50)
  })
})
