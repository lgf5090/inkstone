/**
 * The stacking tiers a surface sets from JavaScript, read off the scale in
 * `src/client/styles/tokens.css`.
 *
 * That list is the authority — this map is a mirror of the bands whose `z-index` reaches a component
 * as a prop or an inline style rather than as a class, and `tests/shared-component-contract.test.ts`
 * fails if a value here stops matching a band there, if the scale stops being strictly increasing, or
 * if a key here stops naming the token it carries. A surface whose stack level is fixed in CSS reads
 * the custom property (`z-[var(--z-modal)]`) and needs no key here.
 */
export const Z_INDEX = {
  /** `--z-drawer`: the drawer rail — above the app shell, below every dialog. */
  drawer: 190,
  /** `--z-workspace`: a full-height workspace panel, and the drawer that opens over it. */
  workspace: 230,
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
} as const
