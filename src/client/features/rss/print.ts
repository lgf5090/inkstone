/**
 * Handing the article to the browser's print dialogue, which is where a PDF comes from.
 *
 * The reference reader runs inside Electron and calls `printToPDF`. This app runs in a browser, and
 * a browser's own "Save as PDF" is the same facility asked for a different way — so what the app has
 * to contribute is the *paper*: the reading pane alone, at full width, on white, with the whole
 * article in flow rather than clipped to a scroll box. Those rules live in `rss.css` under
 * `@media print`, keyed off the class set here.
 *
 * The class is removed on `afterprint` and again on a timer, because a browser that never fires the
 * event would otherwise leave the app printing chrome-less for the rest of the session.
 */
const PRINTING = 'rss-printing'

export function printArticle(): void {
  const root = document.documentElement
  if (root.classList.contains(PRINTING)) return
  const done = (): void => root.classList.remove(PRINTING)
  root.classList.add(PRINTING)
  window.addEventListener('afterprint', done, { once: true })
  window.setTimeout(done, 1500)
  window.print()
}
