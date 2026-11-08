/**
 * The collections a fresh personal library starts with.
 *
 * They are imported by the worker into the reader's own R2/D1 space the first time the library is
 * opened, so the grid shows real icons instead of an empty state. The list is shared with the client
 * so the import dialog can describe every library before a single request goes out.
 */
export type IconBuiltinStyle = 'line' | 'fill' | 'mixed' | 'brand'

export interface IconBuiltinLibrary {
  prefix: string
  name: string
  description: string
  license: string
  homepage: string
  style: IconBuiltinStyle
  totalIcons: number
  /** How many icons the automatic first-run import takes from this library. */
  seedLimit: number
}

export const ICON_BUILTIN_LIBRARIES: readonly IconBuiltinLibrary[] = [
  {
    prefix: 'lucide',
    name: 'Lucide',
    description: 'Clean 24px stroke icons, the default set for modern interfaces.',
    license: 'ISC',
    homepage: 'https://lucide.dev',
    style: 'line',
    totalIcons: 1960,
    seedLimit: 140,
  },
  {
    prefix: 'tabler',
    name: 'Tabler Icons',
    description: 'Over 6000 free stroke icons on a 24px grid.',
    license: 'MIT',
    homepage: 'https://tabler.io/icons',
    style: 'line',
    totalIcons: 6147,
    seedLimit: 140,
  },
  {
    prefix: 'material-symbols',
    name: 'Material Symbols',
    description: 'Google’s variable icon family, built for product UI.',
    license: 'Apache-2.0',
    homepage: 'https://fonts.google.com/icons',
    style: 'fill',
    totalIcons: 3000,
    seedLimit: 120,
  },
  {
    prefix: 'ph',
    name: 'Phosphor Icons',
    description: 'A flexible family with six weights and 7000+ icons.',
    license: 'MIT',
    homepage: 'https://phosphoricons.com',
    style: 'mixed',
    totalIcons: 7500,
    seedLimit: 120,
  },
  {
    prefix: 'heroicons',
    name: 'Heroicons',
    description: 'Hand-drawn outline and solid icons by the Tailwind team.',
    license: 'MIT',
    homepage: 'https://heroicons.com',
    style: 'mixed',
    totalIcons: 324,
    seedLimit: 120,
  },
  {
    prefix: 'bi',
    name: 'Bootstrap Icons',
    description: 'Free, high quality icons for Bootstrap and beyond.',
    license: 'MIT',
    homepage: 'https://icons.getbootstrap.com',
    style: 'fill',
    totalIcons: 2078,
    seedLimit: 120,
  },
  {
    prefix: 'fe',
    name: 'Feather',
    description: 'Simply beautiful open source icons on a 24px grid.',
    license: 'MIT',
    homepage: 'https://feathericons.com',
    style: 'line',
    totalIcons: 287,
    seedLimit: 120,
  },
  {
    prefix: 'ri',
    name: 'Remix Icon',
    description: 'Neutral style icons for designers and developers.',
    license: 'Apache-2.0',
    homepage: 'https://remixicon.com',
    style: 'mixed',
    totalIcons: 3229,
    seedLimit: 120,
  },
  {
    prefix: 'simple-icons',
    name: 'Simple Icons',
    description: 'Brand icons for popular products and services.',
    license: 'CC0-1.0',
    homepage: 'https://simpleicons.org',
    style: 'brand',
    totalIcons: 3000,
    seedLimit: 120,
  },
]

export const ICON_LINE_PREFIXES = [
  'lucide',
  'tabler',
  'fe',
  'iconoir',
  'radix-icons',
  'teenyicons',
  'akar-icons',
] as const

export const ICON_FILL_PREFIXES = [
  'material-symbols',
  'bi',
  'simple-icons',
  'octicon',
  'carbon',
  'bx',
  'ion',
  'gg',
] as const

export const ICON_BRAND_PREFIXES = ['simple-icons', 'devicon'] as const

export const ICON_BUILTIN_PREFIXES = ICON_BUILTIN_LIBRARIES.map((library) => library.prefix)

export function builtinLibrary(prefix: string): IconBuiltinLibrary | undefined {
  return ICON_BUILTIN_LIBRARIES.find((library) => library.prefix === prefix)
}

/** The first-run import is deliberately bounded so it finishes in the background in a few minutes. */
export function seedIconCount(): number {
  return ICON_BUILTIN_LIBRARIES.reduce((total, library) => total + library.seedLimit, 0)
}
