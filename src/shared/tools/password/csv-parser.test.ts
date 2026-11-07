import { describe, expect, it } from 'vitest'
import { parseCSV, toCSV } from './csv-parser'

function account(overrides: Partial<Record<'title' | 'username' | 'password' | 'link' | 'remark', string>> = {}) {
  return {
    title: 'GitHub',
    username: 'octocat',
    password: 'hunter2',
    link: 'https://github.com',
    remark: '',
    ...overrides,
  }
}

describe('toCSV', () => {
  it('writes the plain rows the reader expects', () => {
    expect(toCSV([account()])).toBe('title,username,password,link,remark\nGitHub,octocat,hunter2,https://github.com,')
  })

  it('quotes fields that contain a comma, a quote or a newline', () => {
    const csv = toCSV([account({ remark: 'a,b "c"\nd' })])
    expect(csv).toContain('"a,b ""c""\nd"')
  })

  it('neutralises a leading character a spreadsheet would run as a formula', () => {
    // Titles and remarks can come from an imported file, so the export must not hand Excel a
    // command. Credentials are exempt (see the round-trip test below).
    const csv = toCSV([
      account({ title: '=cmd|calc', remark: '+SUM(1,1)' }),
      account({ title: '-2+3', username: '@handle' }),
    ])

    expect(csv).toContain("'=cmd|calc")
    expect(csv).toContain("'+SUM(1,1)")
    expect(csv).toContain("'-2+3")
    // A username is a credential: it must survive the trip unchanged.
    expect(csv).toContain('@handle')
    expect(csv).not.toContain("'@handle")
  })

  it('keeps credentials byte-for-byte across export and import', () => {
    for (const secret of ['@corp2024', '+123456', '-x', '=cmd']) {
      const csv = toCSV([
        account({
          title: secret,
          username: secret,
          password: secret,
          link: secret,
          remark: secret,
        }),
      ])
      const rows = parseCSV(csv)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        title: secret,
        username: secret,
        password: secret,
        link: secret,
        remark: secret,
      })
    }
  })

  it('leaves a formula character in the middle of a value alone', () => {
    expect(toCSV([account({ title: 'a=b' })])).toContain('a=b')
  })
})

describe('parseCSV', () => {
  it('still reads an exported file back into the same columns', () => {
    const rows = parseCSV(toCSV([account({ remark: 'line1\nline2' })]))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      title: 'GitHub',
      username: 'octocat',
      password: 'hunter2',
      link: 'https://github.com',
      remark: 'line1\nline2',
    })
  })
})
