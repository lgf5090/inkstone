import { useEffect, useState } from 'react';

/**
 * How long collapsed children stay mounted after a folder closes.
 *
 * It is `--dur-slow`, the duration `.folder-children-grid` transitions `grid-template-rows` over in
 * `app.css`: unmounting earlier cuts the collapse short, unmounting later only holds a subtree nobody
 * can see. The token, not the number, is the thing being matched — so a retimed token has to be
 * retimed here too, which is why the coupling is written down rather than left to show.
 */
const COLLAPSE_DURATION_MS = 340;

export function useTreeChildrenMount(expanded: boolean, hasChildren: boolean): {
    childrenMounted: boolean;
    childrenVisible: boolean;
} {
    const [childrenMounted, setChildrenMounted] = useState(expanded && hasChildren);
    const [childrenVisible, setChildrenVisible] = useState(expanded && hasChildren);
    useEffect(() => {
        if (!hasChildren) {
            setChildrenVisible(false);
            setChildrenMounted(false);
            return;
        }
        if (expanded) {
            setChildrenMounted(true);
            const openTimer = window.setTimeout(() => setChildrenVisible(true), 0);
            return () => window.clearTimeout(openTimer);
        }
        setChildrenVisible(false);
        const closeTimer = window.setTimeout(() => setChildrenMounted(false), COLLAPSE_DURATION_MS);
        return () => window.clearTimeout(closeTimer);
    }, [expanded, hasChildren]);
    return { childrenMounted, childrenVisible };
}
