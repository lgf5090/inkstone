import { describe, expect, it } from 'vitest'
import { mergeFrontMatter, splitRendered } from './frontmatter-merge'

/**
 * The cases upstream pins, in the order its specs list them.
 *
 * `test/specs/templater.e2e.ts` (AGPL-3.0-only, 2.26.0) is the oracle for the merge rules, so each test
 * below names the spec it answers and states the expected YAML text exactly as that spec expects it. The
 * specs run a real editor, which this repo does not have; what they assert — the file's text afterwards —
 * is what is asserted here.
 */

const EMPTY: Record<string, unknown> = {}

/** The note's own block, fences stripped, which is what `mergeFrontMatter` reads and writes. */
function blockOf(text: string): string {
  const split = splitRendered(text)
  return split.raw
}

describe('splitRendered', () => {
  it('keeps a text without a block whole, as body', () => {
    const split = splitRendered('# Title\n\ntext\n')
    expect(split.block).toBe('')
    expect(split.raw).toBe('')
    expect(split.frontmatter).toEqual(EMPTY)
    expect(split.body).toBe('# Title\n\ntext\n')
    expect(split.bodyStart).toBe(0)
    expect(split.invalid).toBe(false)
    expect(split.errors).toEqual([])
  })

  it('reads a block and hands back the body after it', () => {
    const split = splitRendered('---\nkey: value\n---\nText')
    expect(split.block).toBe('---\nkey: value\n---')
    expect(split.raw).toBe('key: value')
    expect(split.frontmatter).toEqual({ key: 'value' })
    expect(split.body).toBe('Text')
    expect(split.bodyStart).toBe('---\nkey: value\n---\n'.length)
    expect(split.invalid).toBe(false)
  })

  it('treats an empty block as no properties, and keeps the body', () => {
    const split = splitRendered('---\n---\nBody only')
    expect(split.frontmatter).toEqual(EMPTY)
    expect(split.raw).toBe('')
    expect(split.block).toBe('---\n---')
    expect(split.body).toBe('Body only')
    expect(split.invalid).toBe(false)
  })

  it('drops an empty block at the end of the text without inventing a line', () => {
    const split = splitRendered('---\n---\n')
    expect(split.block).toBe('---\n---')
    expect(split.body).toBe('')
  })

  it('treats a block that is not valid YAML as body, the way upstream does', () => {
    // Upstream's `get_frontmatter_and_content` catch returns `{ frontmatter: {}, content }` — the whole
    // text, block included — and its `%` directive specs assert that text lands in the note verbatim.
    const rendered = '---\naliases:\n- %\n---\n'
    const split = splitRendered(rendered)
    expect(split.invalid).toBe(true)
    expect(split.errors.length).toBeGreaterThan(0)
    expect(split.frontmatter).toEqual(EMPTY)
    expect(split.body).toBe(rendered)
    expect(split.bodyStart).toBe(0)
    // `raw` still carries the unparsable lines, because a caller must be able to refuse to rewrite them.
    expect(split.raw).toBe('aliases:\n- %')
  })

  it('treats a flow sequence with a reserved indicator as body', () => {
    const rendered = '---\ntags: [#test]\n---\n'
    const split = splitRendered(rendered)
    expect(split.invalid).toBe(true)
    expect(split.body).toBe(rendered)
  })

  it('refuses a block whose root is not a mapping instead of merging by character index', () => {
    // Upstream parses `foo` to a string and `merge_objects` then walks its indices; a note must not gain
    // keys named `0` and `1` because a template's block was a bare word.
    const split = splitRendered('---\nfoo\n---\nBody')
    expect(split.invalid).toBe(true)
    expect(split.body).toBe('---\nfoo\n---\nBody')
  })

  it('leaves a horizontal rule in the body alone', () => {
    const split = splitRendered('---\ntitle: x\n---\nabove\n\n---\n\nbelow')
    expect(split.body).toBe('above\n\n---\n\nbelow')
    expect(split.frontmatter).toEqual({ title: 'x' })
  })

  it('does not eat a second table that starts with a rule', () => {
    const rendered = '---\na: 1\n---\n| col |\n|---|\n| v |\n\n---\n\nmore'
    expect(splitRendered(rendered).body).toBe('| col |\n|---|\n| v |\n\n---\n\nmore')
  })

  it('keeps a block that is never closed as body, without calling it invalid', () => {
    const rendered = '---\nkey: value\nno closing fence here'
    const split = splitRendered(rendered)
    expect(split.invalid).toBe(false)
    expect(split.block).toBe('')
    expect(split.body).toBe(rendered)
  })

  it('keeps CRLF line endings in the body', () => {
    const split = splitRendered('---\r\nkey: value\r\n---\r\nline one\r\nline two\r\n')
    expect(split.body).toBe('line one\r\nline two\r\n')
    expect(split.bodyStart).toBe('---\r\nkey: value\r\n---\r\n'.length)
    expect(split.frontmatter).toEqual({ key: 'value' })
  })

  it('counts offsets in the text it was given, byte-order mark included', () => {
    // `bodyStart` is the contract the write plan rebases cursor markers with, so it has to be measured in
    // the caller's string, BOM and all, not in a normalised copy of it.
    const rendered = '---\na: 1\n---\nBody'
    const bom = String.fromCharCode(0xfeff)
    const withMark = `${bom}${rendered}`
    const split = splitRendered(withMark)
    expect(split.body).toBe('Body')
    expect(split.bodyStart).toBe(withMark.length - 'Body'.length)
    expect(withMark.slice(split.bodyStart)).toBe(split.body)
  })
})

describe('mergeFrontMatter', () => {
  it('appends a template-only key and lets the template win a shared one', () => {
    // `append_template_to_active_file gracefully merges YAML primitives`
    const merged = mergeFrontMatter(blockOf('---\nonly_in_target: target value\nboth: target value\n---'), {
      only_in_template: 'template value',
      both: 'template value',
    })
    expect(merged.yaml).toBe('only_in_target: target value\nboth: template value\nonly_in_template: template value')
    expect(merged.changed).toBe(true)
    expect(merged.status).toBe('merged')
    expect(merged.changes).toEqual([
      { key: 'only_in_template', action: 'added' },
      { key: 'both', action: 'overwritten' },
    ])
  })

  it('concatenates two lists in the order the note reads first', () => {
    // `append_template_to_active_file gracefully merges YAML lists`
    const merged = mergeFrontMatter(blockOf('---\nboth:\n  - target_value1\n  - target_value2\n---'), {
      both: ['template_value1', 'template_value2'],
    })
    expect(merged.yaml).toBe('both:\n  - target_value1\n  - target_value2\n  - template_value1\n  - template_value2')
    expect(merged.changes).toEqual([{ key: 'both', action: 'merged' }])
  })

  it('keeps duplicates in a list whose key the template does not touch', () => {
    // `append_template_to_active_file preserves duplicate values in YAML lists that do not match`
    const merged = mergeFrontMatter(blockOf('---\ntarget_duplicates:\n  - another_duplicate\n  - another_duplicate\n  - another_unique\n---'), {
      template_duplicates: ['duplicate_value', 'duplicate_value', 'unique_value'],
    })
    expect(merged.yaml).toBe(
      'target_duplicates:\n  - another_duplicate\n  - another_duplicate\n  - another_unique\n'
      + 'template_duplicates:\n  - duplicate_value\n  - duplicate_value\n  - unique_value',
    )
    expect(merged.changes).toEqual([{ key: 'template_duplicates', action: 'added' }])
  })

  it('de-duplicates only across a real collision', () => {
    // `append_template_to_active_file de-duplicates duplicate values in matching YAML lists`, all three keys
    const existing = blockOf('---\n'
      + 'duplicates_when_merged:\n  - target_item\n  - shared_item\n'
      + 'duplicates_pre_merge:\n  - target_item\n  - target_item\n'
      + 'duplicates_post_merge:\n  - target_item\n  - target_item\n---')
    const merged = mergeFrontMatter(existing, {
      duplicates_when_merged: ['template_item', 'shared_item'],
      duplicates_pre_merge: ['template_item', 'template_item'],
      duplicates_post_merge: ['template_item'],
    })
    expect(merged.yaml).toBe('duplicates_when_merged:\n  - target_item\n  - shared_item\n  - template_item\n'
      + 'duplicates_pre_merge:\n  - target_item\n  - template_item\n'
      + 'duplicates_post_merge:\n  - target_item\n  - template_item')
  })

  it('leaves a list untouched when the template adds nothing new', () => {
    const merged = mergeFrontMatter(blockOf('---\ntags: [a, b]\n---'), { tags: ['a'] })
    expect(merged.changes).toEqual([{ key: 'tags', action: 'kept' }])
    expect(merged.changed).toBe(false)
    expect(merged.yaml).toBe('tags: [a, b]')
  })

  it('recurses into two mappings', () => {
    const merged = mergeFrontMatter(blockOf('---\nmeta:\n  keep: yes\n  both: note\n---'), {
      meta: { both: 'template', added: 1 },
    })
    expect(merged.yaml).toBe('meta:\n  keep: yes\n  both: template\n  added: 1')
    expect(merged.changes).toEqual([{ key: 'meta', action: 'merged' }])
  })

  it('reports a nested mapping as unchanged when the template repeats it', () => {
    const merged = mergeFrontMatter(blockOf('---\nmeta:\n  a: 1\n---'), { meta: { a: 1 } })
    expect(merged.changed).toBe(false)
    expect(merged.changes).toEqual([{ key: 'meta', action: 'kept' }])
  })

  it('replaces the reader shape when the same key arrives as a different type', () => {
    // `append_template_to_active_file handles mixed data types for same key`
    const existing = blockOf('---\n'
      + 'string_to_list: target string\n'
      + 'list_to_string:\n  - target_item1\n  - target_item2\n'
      + 'string_to_number: existing string\n'
      + 'list_to_boolean:\n  - existing_item\n---')
    const merged = mergeFrontMatter(existing, {
      string_to_list: ['template_item1', 'template_item2'],
      list_to_string: 'template string',
      string_to_number: 42,
      list_to_boolean: true,
    })
    expect(merged.yaml).toBe('string_to_list:\n  - template_item1\n  - template_item2\n'
      + 'list_to_string: template string\nstring_to_number: 42\nlist_to_boolean: true')
    expect(merged.changes).toEqual([
      { key: 'string_to_list', action: 'shape-replaced' },
      { key: 'list_to_string', action: 'shape-replaced' },
      { key: 'string_to_number', action: 'overwritten' },
      { key: 'list_to_boolean', action: 'shape-replaced' },
    ])
  })

  it('keeps the note value when the template value is empty', () => {
    const merged = mergeFrontMatter(blockOf('---\ntitle: Keep me\ntags: [a]\nmeta:\n  a: 1\nn: 0\nflag: false\n---'), {
      title: '',
      tags: [],
      meta: {},
      // `null`, `undefined` and `''` are the three empties upstream names; `0` and `false` are values.
      n: null,
      flag: undefined,
    })
    expect(merged.changed).toBe(false)
    expect(merged.yaml).toBe('title: Keep me\ntags: [a]\nmeta:\n  a: 1\nn: 0\nflag: false')
  })

  it('writes an empty value that the note does not have yet', () => {
    // Upstream copies the source value for a key the target lacks, empty or not: a template that seeds
    // `tags: []` means to give the note an empty list.
    const merged = mergeFrontMatter(blockOf('---\na: 1\n---'), { tags: [], title: '' })
    expect(merged.yaml).toBe('a: 1\ntags: []\ntitle: ""')
  })

  it('keeps the note order and appends, never re-sorting', () => {
    const merged = mergeFrontMatter(blockOf('---\nzebra: 1\nmiddle: 2\nalpha: 3\n---'), { zebra: 9, newest: 4 })
    expect(merged.yaml).toBe('zebra: 9\nmiddle: 2\nalpha: 3\nnewest: 4')
  })

  it('collapses a reader repeat once the key collides, and leaves it alone before that', () => {
    // Upstream uniques the concatenation, so a collision can remove a repeat the note already had; a key
    // the template does not name never reaches that code.
    const collided = mergeFrontMatter(blockOf('---\ntags:\n  - a\n  - a\n---'), { tags: ['a'] })
    expect(collided.yaml).toBe('tags:\n  - a')
    expect(collided.changes).toEqual([{ key: 'tags', action: 'merged' }])
    const untouched = mergeFrontMatter(blockOf('---\ntags:\n  - a\n  - a\n---'), { other: 1 })
    expect(untouched.yaml).toBe('tags:\n  - a\n  - a\nother: 1')
  })

  it('survives the reader quoting, comments and flow style it chose', () => {
    const existing = [
      '# block comment about the note',
      'title: "quoted on purpose"',
      'spaced: single  words',
      'tags: [a, b] # keep this comment',
      'block:',
      '  - one',
      '  - two',
      'literal: |',
      '  keep',
      '  me',
    ].join('\n')
    const merged = mergeFrontMatter(existing, { tags: ['c'], added: 'x' })
    expect(merged.changed).toBe(true)
    expect(merged.yaml).toBe([
      '# block comment about the note',
      'title: "quoted on purpose"',
      'spaced: single  words',
      'tags: [a, b, c] # keep this comment',
      'block:',
      '  - one',
      '  - two',
      'literal: |',
      '  keep',
      '  me',
      'added: x',
    ].join('\n'))
  })

  it('refuses a note block it cannot read and returns it verbatim', () => {
    const broken = 'aliases:\n- %\n'
    const merged = mergeFrontMatter(broken, { title: 'template' })
    expect(merged.status).toBe('note-invalid')
    expect(merged.changed).toBe(false)
    expect(merged.yaml).toBe(broken)
    expect(merged.changes).toEqual([])
  })

  it('refuses a note block with a duplicated key rather than picking one', () => {
    const merged = mergeFrontMatter('a: 1\na: 2\n', { b: 3 })
    expect(merged.status).toBe('note-invalid')
    expect(merged.yaml).toBe('a: 1\na: 2\n')
  })

  it('refuses a note block whose root is a list', () => {
    const merged = mergeFrontMatter('- one\n- two', { a: 1 })
    expect(merged.status).toBe('note-invalid')
  })

  it('does nothing for a template with no properties', () => {
    const merged = mergeFrontMatter('title: keep', EMPTY)
    expect(merged.status).toBe('unchanged')
    expect(merged.changed).toBe(false)
    expect(merged.yaml).toBe('title: keep')
  })

  it('writes the template properties into a note that has no block yet', () => {
    const merged = mergeFrontMatter('', { title: 'x', tags: ['a'] })
    expect(merged.yaml).toBe('title: x\ntags:\n  - a')
    expect(merged.changes).toEqual([
      { key: 'title', action: 'added' },
      { key: 'tags', action: 'added' },
    ])
  })

  it('normalises blank padding inside a block it rewrites, and leaves one it does not touch alone', () => {
    // A merged block is re-emitted, so blank lines the reader left at its top go — the same thing
    // `setFrontMatterValue` does in the properties panel. The protection is on the bytes of a block the
    // merge did not change, which come back exactly as they went in.
    expect(mergeFrontMatter('\n\ntitle: x', { added: 1 }).yaml).toBe('title: x\nadded: 1')
    expect(mergeFrontMatter('\n\ntitle: x', { title: 'x' }).yaml).toBe('\n\ntitle: x')
  })

  it('is idempotent, so a template run twice does not double a list', () => {
    const once = mergeFrontMatter(blockOf('---\ntags:\n  - a\n---'), { tags: ['a', 'b'] })
    const twice = mergeFrontMatter(once.yaml, { tags: ['a', 'b'] })
    expect(twice.changed).toBe(false)
    expect(twice.yaml).toBe('tags:\n  - a\n  - b')
  })

  it('merges a numeric-looking key the way a parsed object would', () => {
    // YAML reads `123:` as a number key while the template's block reads '123'; the note is matched by
    // its resolved text, so the property is overwritten in place rather than duplicated.
    const merged = mergeFrontMatter('123: note\n', { '123': 'template' })
    expect(merged.yaml).toBe('123: template')
    expect(merged.changes).toEqual([{ key: '123', action: 'overwritten' }])
  })
})
