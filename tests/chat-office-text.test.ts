import { describe, expect, it } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { extractOfficeText, isOfficeDocument } from '../src/client/features/chat/office-text'

function officeFile(name: string, entries: Record<string, string>, type = 'application/octet-stream'): File {
  const archive = zipSync(Object.fromEntries(Object.entries(entries).map(([path, text]) => [path, strToU8(text)])))
  return new File([archive], name, { type })
}

describe('office attachment text', () => {
  it('recognises the three packages and their extensions', () => {
    expect(isOfficeDocument('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.bin')).toBe(true)
    expect(isOfficeDocument('', 'notes.docx')).toBe(true)
    expect(isOfficeDocument('text/plain', 'notes.txt')).toBe(false)
  })

  it('reads paragraphs and tabs from a docx', async () => {
    const file = officeFile('brief.docx', {
      'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>First line</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t><w:tab/><w:t>line</w:t></w:r></w:p></w:body></w:document>',
    })
    expect(await extractOfficeText(file)).toBe('First line\nSecond\tline')
  })

  it('reads slides in order', async () => {
    const file = officeFile('deck.pptx', {
      'ppt/slides/slide2.xml': '<p:sld><a:t>Second slide</a:t></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:t>First slide</a:t></p:sld>',
    })
    expect(await extractOfficeText(file)).toBe('Slide 1\nFirst slide\n\nSlide 2\nSecond slide')
  })

  it('reads shared strings and cell values from a sheet', async () => {
    const file = officeFile('sheet.xlsx', {
      'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c><v>42</v></c></row></sheetData></worksheet>',
    })
    expect(await extractOfficeText(file)).toBe('Name\tAda\n42')
  })

  it('returns nothing for bytes that are not a package', async () => {
    expect(await extractOfficeText(new File(['nope'], 'broken.docx'))).toBe('')
  })
})
