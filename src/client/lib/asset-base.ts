/**
 * Where the app's own vendor files live.
 *
 * The app serves `/vendor/…` from its own origin. A reading runtime hosted on another site (the blog)
 * receives the files through a proxy, so the loader has to be told the prefix instead of assuming the
 * page origin. An empty base keeps every existing surface on its current absolute path.
 */
let assetBase = ''

export function setAssetBase(base: string): void {
  assetBase = base
}

export function assetUrl(path: string): string {
  if (!assetBase) return path
  return `${assetBase.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}
