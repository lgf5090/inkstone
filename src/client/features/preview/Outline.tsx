import { useEffect, useRef, useState, type RefObject } from 'react';
import { ListTree } from 'lucide-react';
import type { Heading } from '../../lib/markdown/renderer';
import { cn } from '../../lib/cn';
import { Tooltip } from '../../components/overlay';
import { t } from "../../lib/i18n";

export function Outline({ headings, onSelect, scrollerRef, className, }: {
    headings: Heading[];
    onSelect: (heading: Heading) => void;
    scrollerRef?: RefObject<HTMLElement | null>;
    className?: string;
}) {
    const [active, setActive] = useState<string | null>(null);
    const rafRef = useRef(0);
    useEffect(() => {
        const scroller = scrollerRef?.current ?? document.querySelector<HTMLElement>('[data-preview-scroller]');
        if (!scroller || headings.length === 0)
            return;
        // One pass per layout change instead of one querySelector + one layout read per
        // heading per frame: 1428 headings used to cost ~43k DOM queries a second while scrolling.
        let measured: { headings: Heading[]; slugs: string[]; tops: number[]; height: number } | null = null;
        const measure = () => {
            const slugs: string[] = [];
            const tops: number[] = [];
            for (const heading of headings) {
                const el = scroller.querySelector<HTMLElement>(`#${CSS.escape(heading.slug)}`);
                if (!el)
                    continue;
                slugs.push(heading.slug);
                tops.push(el.offsetTop);
            }
            measured = { headings, slugs, tops, height: scroller.scrollHeight };
            return measured;
        };
        const onScroll = () => {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = requestAnimationFrame(() => {
                const top = scroller.scrollTop + 60;
                if (!measured || measured.headings !== headings || measured.height !== scroller.scrollHeight)
                    measure();
                const tops = measured!.tops;
                // Heads are in document order, so the active one is the last entry at or above top.
                let low = 0;
                let high = tops.length - 1;
                let found = -1;
                while (low <= high) {
                    const middle = (low + high) >> 1;
                    if (tops[middle]! <= top) {
                        found = middle;
                        low = middle + 1;
                    }
                    else {
                        high = middle - 1;
                    }
                }
                setActive(found >= 0 ? measured!.slugs[found]! : headings[0]?.slug ?? null);
            });
        };
        onScroll();
        scroller.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            scroller.removeEventListener('scroll', onScroll);
            cancelAnimationFrame(rafRef.current);
        };
    }, [headings, scrollerRef]);
    if (headings.length === 0)
        return null;
    let minLevel = headings[0]!.level;
    for (const heading of headings) if (heading.level < minLevel) minLevel = heading.level;
    return (<nav className={cn('sticky top-0 max-h-full w-[168px] shrink-0 self-start overflow-y-auto py-5 pr-3', className)} aria-label={t("common.outline")}>
      <div className="mb-2 flex items-center gap-1.5 px-2 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        <ListTree size={11}/>{t("common.outline")}</div>
      <ul className="space-y-px">
        {headings.map((heading, index) => {
            const isActive = heading.slug === active;
            return (<li key={`${heading.slug}-${index}`}>
              <Tooltip label={heading.text || t("preview.untitled")} side="left">
                <button type="button" aria-current={isActive ? 'location' : undefined} onClick={() => onSelect(heading)} className={cn('relative block w-full truncate rounded-[var(--r-sm)] py-1 pr-1.5 text-left text-[11.5px] leading-snug', 'transition-colors duration-[var(--dur-fast)]', isActive
                        ? 'font-medium text-[var(--accent)]'
                        : 'text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]')} style={{ paddingLeft: 8 + (heading.level - minLevel) * 10 }}>
                  {isActive && (<span className="absolute top-1/2 left-0 h-[13px] w-[2px] -translate-y-1/2 rounded-full bg-[var(--accent)]"/>)}
                  {heading.text || t("preview.untitled")}
                </button>
              </Tooltip>
            </li>);
        })}
      </ul>
    </nav>);
}
