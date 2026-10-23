/**
 * The reader's own scripts, as far as a keystroke inside an editor can see them.
 *
 * `editor/templater-completion.ts` may not reach a store — the editor half is below the feature half — so it
 * asks for two questions instead of a table, and this file answers them: which names the script folder holds,
 * and which members one of those names exports. Both are read **without running anything**: the listing is a
 * folder query and the members come out of `host/user-script-scan.ts`, which reads a body as text.
 *
 * The cache is keyed off the folder and the library version, so a script edited between two keystrokes is
 * re-read on the next one and a folder nobody touched costs one listing however many times the reader pauses
 * inside `tp.user.`.
 */
import { libraryVersion } from '../../lib/templater/host/note-index-cache'
import { libraryRows, storeUserScriptPort } from '../../lib/templater/host/store-port'
import { createUserScriptProvider, userScriptNameOf } from '../../lib/templater/host/user-scripts'
import type { TemplaterScriptSource } from '../../editor/templater-completion'
import { useSession } from '../../store/session'

let cached: {
  key: string
  names: Promise<string[]>
  provider: ReturnType<typeof createUserScriptProvider>
} | null = null

/** `folderId:libraryVersion`, which is the only thing the two answers below depend on. */
function cacheKey(folderId: string): string {
  return `${folderId}:${libraryVersion(libraryRows())}`
}

function source(folderId: string) {
  const key = cacheKey(folderId)
  if (cached && cached.key === key) return cached
  const port = storeUserScriptPort(folderId)
  const provider = createUserScriptProvider(port)
  const names = port.listScripts().then(
    (records) => {
      // One row per name, whatever the folder holds: two notes claiming one name is a conflict the *run*
      // refuses by naming both paths (`host/user-scripts.ts`), and a completion list that printed the same
      // word twice would read as this file's own bug rather than as the reader's duplicate note.
      const found = new Set<string>()
      for (const record of records) {
        const name = userScriptNameOf(record.title)
        if (name !== null) found.add(name)
      }
      return [...found].sort()
    },
    () => [] as string[],
  )
  cached = { key, names, provider }
  return cached
}

export function templaterScriptSource(): TemplaterScriptSource {
  return {
    async names() {
      const folderId = useSession.getState().settings.templater.userScriptsFolderId
      if (folderId === null) return []
      return source(folderId).names
    },
    async members(name) {
      const folderId = useSession.getState().settings.templater.userScriptsFolderId
      if (folderId === null) return []
      const found = await source(folderId).provider.describe(name)
      if (!found.ok || found.module.surface.kind !== 'object') return []
      return found.module.surface.members.filter((one) => one.callable).map((one) => one.name)
    },
  }
}
