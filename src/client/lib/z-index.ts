/**
 * The stacking tiers a surface sets from JavaScript, read off the scale in
 * `src/client/styles/tokens.css`.
 *
 * That list is the authority — this map is a mirror of the bands whose `z-index` reaches a component
 * as a prop or an inline style rather than as a class, and `tests/shared-component-contract.test.ts`
 * fails if a value here stops matching a band there, if the scale stops being strictly increasing, or
 * if a key here stops naming the token it carries. A surface whose stack level is fixed in CSS reads
 * the custom property (`z-[var(--z-modal)]`) and needs no key here.
 *
 * Two keys carry a name the scale no longer uses, and both are debt with a pending rename rather than
 * an extra tier: `menu` is the band `--z-pop` (260) names, and `hoverPinned` is `--z-pinned` (280).
 * They stay spelled as they are only because their call sites do — renaming the key without renaming
 * the call site would move a surface two hundred tiers, which is the class of mistake this file exists
 * to stop. Renaming the seven call sites is what lets both keys go; until then the contract test
 * allows exactly these two name overlaps and no others.
 */
export const Z_INDEX = {
  /** `--z-drawer`: the drawer rail — above the app shell, below every dialog. */
  drawer: 190,
  /** `--z-prompt`: a command prompt, omnisearch prompt, filter sheet or preview card. */
  prompt: 240,
  /** `--z-pop`: the floating `Menu` tier, and the image lightbox. */
  pop: 260,
  /** `--z-submenu`: a submenu flyout, one above the menu that opened it. */
  submenu: 265,
  /** `--z-hover-card`: a wiki-link hover card and a context menu opened over one. */
  hoverCard: 270,
  /** `--z-pinned`: a pinned hover card and the menus it owns. */
  pinned: 280,
  /** `--z-pinned-menu`: a menu opened from a pinned card; the shelf's drop veil rides this tier. */
  pinnedMenu: 300,

  /** @deprecated The band `pop` / `--z-pop` above. Rename at the call site, then delete this. */
  menu: 260,
  /** @deprecated The band `pinned` / `--z-pinned` above. Rename at the call site, then delete this. */
  hoverPinned: 280,
} as const
