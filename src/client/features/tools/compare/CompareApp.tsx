/**
 * The compare tool's shell.
 *
 * One screen per job — text, files, folders, images, saved projects, the statistics and the
 * keyboard map — with the same navigation shape the other toolbox modules use.
 */
import { useToolsStore } from '../store'
import { TextCompareView } from './text/TextCompareView'
import { FileCompareView } from './files/FileCompareView'
import { DirectoryCompareView } from './folders/DirectoryCompareView'
import { ImageCompareView } from './images/ImageCompareView'
import { ProjectsView } from './projects/ProjectsView'
import { StatsView } from './stats/StatsView'
import { ShortcutsView } from './shortcuts/ShortcutsView'

export function CompareApp() {
  const view = useToolsStore((s) => s.activeCompareView)
  const setView = useToolsStore((s) => s.setActiveCompareView)

  return (
    <div data-testid="compare-app-root" className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-[var(--bg-base)]">
      {view === 'text' && <TextCompareView onShowShortcuts={() => setView('shortcuts')} />}
      {view === 'files' && <FileCompareView onOpenText={() => setView('text')} onOpenImage={() => setView('images')} />}
      {view === 'folders' && <DirectoryCompareView />}
      {view === 'images' && <ImageCompareView />}
      {view === 'projects' && <ProjectsView onOpenText={() => setView('text')} />}
      {view === 'stats' && <StatsView />}
      {view === 'shortcuts' && <ShortcutsView />}
    </div>
  )
}
