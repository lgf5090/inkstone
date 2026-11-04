import { describe, expect, it } from 'vitest'
import {
  publicationDetailPath,
  publicationPathProblem,
  publicationUrlPath,
  parsePublicationRequestPath,
} from '../src/shared/scriptshub/path'
import { escapeHtml } from '../src/worker/lib/encoding'

describe('publication path validation', () => {
  it('accepts the paths a distribution is meant to have', () => {
    expect(publicationPathProblem('system/linux/flatpak-setup.sh')).toBeNull()
    expect(publicationPathProblem('scripts/backup-nightly.sh')).toBeNull()
    expect(publicationPathProblem('a_b/c-d/v1.2.py')).toBeNull()
  })

  it('refuses traversal, empty segments and leading or trailing slashes', () => {
    expect(publicationPathProblem('../etc/passwd')).toContain('..')
    expect(publicationPathProblem('system/../linux/setup.sh')).toContain('..')
    expect(publicationPathProblem('/system/linux/setup.sh')).toContain('slash')
    expect(publicationPathProblem('system/linux/setup.sh/')).toContain('slash')
    expect(publicationPathProblem('system//linux/setup.sh')).toContain('empty')
    expect(publicationPathProblem('system\\linux\\setup.sh')).toContain('backslash')
  })

  it('refuses the characters a URL or a version suffix would reinterpret', () => {
    expect(publicationPathProblem('system/linux/setup.sh?x=1')).toContain('query')
    expect(publicationPathProblem('system/linux/setup.sh#x')).toContain('query')
    expect(publicationPathProblem('system/linux/setup%2esh')).toContain('percent')
    expect(publicationPathProblem('system/linux/setup.sh@2')).toContain('@')
    expect(publicationPathProblem('system/linux/setup file.sh')).not.toBeNull()
    expect(publicationPathProblem('system/.hidden/setup.sh')).toContain('dot')
  })

  it('refuses a path that is too long or too deep', () => {
    expect(publicationPathProblem(`a/${'b'.repeat(200)}.sh`)).toContain('200')
    expect(publicationPathProblem(Array.from({ length: 9 }, (_, index) => `d${index}`).join('/'))).toContain('8')
  })

  it('keeps the stored spelling, refusing surrounding whitespace rather than trimming it', () => {
    expect(publicationPathProblem(' system/linux/setup.sh')).not.toBeNull()
    expect(publicationPathProblem('system/linux/setup.sh ')).not.toBeNull()
  })

  it('splits a request path from its @version suffix without inventing either', () => {
    expect(parsePublicationRequestPath('system/linux/setup.sh')).toEqual({ path: 'system/linux/setup.sh', version: null })
    expect(parsePublicationRequestPath('system/linux/setup.sh@12')).toEqual({ path: 'system/linux/setup.sh', version: 12 })
    expect(parsePublicationRequestPath('system/linux/setup.sh@0')).toBeNull()
    expect(parsePublicationRequestPath('../setup.sh@2')).toBeNull()
  })

  it('builds the two public addresses from the same validated path', () => {
    expect(publicationUrlPath('system/linux/flatpak-setup.sh')).toBe('/sc/system/linux/flatpak-setup.sh')
    expect(publicationDetailPath('abc')).toBe('/sc-view/abc')
  })

  it('refuses encoded traversal even after the route decodes it once', () => {
    // The route decodes `%2e%2e` before validating; a second encoding leaves a percent sign, which
    // the same rule refuses. Neither spelling can reach a path the store would accept.
    expect(parsePublicationRequestPath('../setup.sh')).toBeNull()
    expect(parsePublicationRequestPath('..%2fsetup.sh')).toBeNull()
    expect(parsePublicationRequestPath('%2e%2e/setup.sh')).toBeNull()
    expect(publicationPathProblem('system/..')).toContain('..')
    expect(publicationPathProblem('system/%2e%2e/setup.sh')).toContain('percent')
  })

  it('escapes a script body and a file name before they enter the public page', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(escapeHtml('" onmouseover="x')).not.toContain('"')
    expect(escapeHtml("it's <b>")).toContain('&#39;')
  })
})
