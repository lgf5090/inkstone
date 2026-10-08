import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings, mergeSettingsPatch } from './constants'

describe('dataview settings', () => {
  it('ships the ported defaults', () => {
    expect(DEFAULT_SETTINGS.dataview.tableIdColumnName).toBe('File')
    expect(DEFAULT_SETTINGS.dataview.tableGroupColumnName).toBe('Group')
    expect(DEFAULT_SETTINGS.dataview.maxRecursiveRenderDepth).toBe(4)
    expect(DEFAULT_SETTINGS.dataview.showResultCount).toBe(false)
    expect(DEFAULT_SETTINGS.dataview.warnOnEmptyResult).toBe(true)
    expect(DEFAULT_SETTINGS.dataview.inlineJsQueries).toBe(false)
    expect(DEFAULT_SETTINGS.dataview.inlineJsQueryPrefix).toBe('$=')
    expect(DEFAULT_SETTINGS.dataview.inlineQueriesInCodeblocks).toBe(false)
    expect(DEFAULT_SETTINGS.dataview.prettyInlineFieldsLivePreview).toBe(true)
    expect(DEFAULT_SETTINGS.dataview.allowHtmlInExports).toBe(false)
  })

  it('keeps a stored profile without the new keys on the defaults', () => {
    const merged = mergeSettings({ dataview: { maxRows: 40 } })
    expect(merged.dataview.maxRows).toBe(40)
    expect(merged.dataview.tableIdColumnName).toBe('File')
    expect(merged.dataview.maxRecursiveRenderDepth).toBe(4)
    expect(merged.dataview.inlineJsQueryPrefix).toBe('$=')
    expect(merged.dataview.warnOnEmptyResult).toBe(true)
    expect(merged.dataview.prettyInlineFieldsLivePreview).toBe(true)
  })

  it('reads an empty script prefix as the feature having no prefix', () => {
    expect(mergeSettings({ dataview: { inlineJsQueryPrefix: '' } }).dataview.inlineJsQueryPrefix).toBe('')
    expect(mergeSettings({ dataview: { inlineJsQueryPrefix: '  ' } }).dataview.inlineJsQueryPrefix).toBe('')
  })

  it('refuses a script prefix that would shadow the inline query prefix', () => {
    expect(mergeSettings({ dataview: { inlineJsQueryPrefix: '=' } }).dataview.inlineJsQueryPrefix).toBe('$=')
    expect(mergeSettings({ dataview: { inlineJsQueryPrefix: '===>' } }).dataview.inlineJsQueryPrefix).toBe('$=')
  })

  it('trims and clamps what a reader can type or drag', () => {
    const merged = mergeSettings({
      dataview: {
        tableIdColumnName: '  The Notes  ',
        tableGroupColumnName: 'x'.repeat(80),
        maxRecursiveRenderDepth: 999,
        inlineJsQueryPrefix: 'abcdefg hij',
      },
    })
    expect(merged.dataview.tableIdColumnName).toBe('The Notes')
    expect(merged.dataview.tableGroupColumnName.length).toBe(40)
    expect(merged.dataview.maxRecursiveRenderDepth).toBe(12)
    expect(merged.dataview.inlineJsQueryPrefix).toBe('abcdefg ')
    expect(mergeSettings({ dataview: { maxRecursiveRenderDepth: 0 } }).dataview.maxRecursiveRenderDepth).toBe(1)
    expect(mergeSettings({ dataview: { showResultCount: 'yes' } }).dataview.showResultCount).toBe(false)
  })

  it('patches one switch without dropping the rest of the section', () => {
    const stored = { dataview: { dateFormat: 'yyyy', maxRows: 30 } }
    const patched = mergeSettingsPatch(stored, { dataview: { inlineJsQueries: true } })
    expect(patched.dataview.dateFormat).toBe('yyyy')
    expect(patched.dataview.maxRows).toBe(30)
    expect(patched.dataview.inlineJsQueries).toBe(true)
    expect(patched.dataview.tableIdColumnName).toBe('File')
  })
})
