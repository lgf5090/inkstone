import { FolderClosed, FolderOpen } from 'lucide-react';

export function FolderMotionIcon({ open, drawing }: {
    open: boolean;
    drawing: boolean;
}) {
    return (<span aria-hidden="true" data-open={open || undefined} data-drawing={drawing || undefined} className="folder-motion-icon">
      <FolderClosed size={14} className="folder-motion-icon__closed"/>
      <FolderOpen size={14} className="folder-motion-icon__open"/>
    </span>);
}
