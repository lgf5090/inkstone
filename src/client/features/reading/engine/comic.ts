export function orderComicPages(names: string[], comicInfo: string | null): { paths: string[]; rtl: boolean } {
  const paths = [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  if (!comicInfo) return { paths, rtl: false }
  const xml = new DOMParser().parseFromString(comicInfo, 'application/xml')
  const rtl = xml.querySelector('ReadingOrder')?.textContent?.trim().toLowerCase() === 'righttoleft'
  if (rtl) paths.reverse()
  return { paths, rtl }
}
