import { ScanSearch } from 'lucide-react';
import { APP_SHORTCUTS } from '../../lib/shortcuts';
import { Tooltip } from '../../components/overlay';
import { IconButton } from '../../components/primitives';
import { t } from '../../lib/i18n';
import { useSession } from '../../store/session';
import { openOmnisearch } from './store';

/** Both switches have to agree: `enabled` stops the index, `ribbonButton` only hides the entry. */
export function useOmnisearchEntryEnabled(): boolean {
    return useSession((state) => state.settings.search.enabled && state.settings.search.ribbonButton);
}

/**
 * The Omnisearch entry for the surfaces that have no command palette of their own: the sidebar header
 * and the phone library toolbar. It stays out of the sidebar's tab strip because the tabs own a panel
 * each, and this opens a prompt over whichever one is showing. The collapsed rail draws its own button
 * shape, so it takes {@link useOmnisearchEntryEnabled} and keeps its `RailButton` styling.
 */
export function OmnisearchEntry({ onCollapse = false, mobile = false, className }: {
    onCollapse?: boolean;
    mobile?: boolean;
    className?: string;
}) {
    const enabled = useOmnisearchEntryEnabled();
    if (!enabled) return null;
    const label = t('shell.omnisearch');
    const open = () => openOmnisearch({
        mode: 'vault',
    });
    return (<Tooltip label={label} side={onCollapse || mobile ? 'bottom' : 'left'} combo={mobile ? undefined : APP_SHORTCUTS.omnisearch}>
        <IconButton label={label} size="sm" className={className} onClick={open}>
          <ScanSearch size={mobile ? 17 : 15}/>
        </IconButton>
      </Tooltip>);
}
