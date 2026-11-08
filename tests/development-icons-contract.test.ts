import { describe, expect, it } from 'vitest'
import {
  DEVELOPMENT_ICONS_CORE_SCHEMA_VERSION,
  DEVELOPMENT_ICONS_SCHEMA_VERSIONS,
  DEVELOPMENT_ICONS_SETTINGS_SCHEMA_VERSION,
  ICON_ICO_PRESETS,
  ICON_PAGE_SIZE_DEFAULT,
  ICON_PAGE_SIZE_MAX,
  ICON_PNG_PRESETS,
  ICON_SPRITE_PADDING_DEFAULT,
} from '../src/shared/development/icons/limits'
import {
  IconExportCreateSchema,
  IconImportCreateSchema,
  IconJobCreateSchema,
  IconListQuerySchema,
  IconSettingsPatchSchema,
} from '../src/shared/development/icons/schemas'
import {
  buildCodegen,
  buildComponentName,
  buildDataUrl,
  buildJsxString,
  buildSvgString,
  type IconCodegenContext,
} from '../src/shared/development/icons/codegen'
import { decodeIconCursor, encodeIconCursor } from '../src/shared/development/icons/cursor'
import {
  defaultIconJobOptions,
  iconJobProgress,
  isIconJobTerminal,
} from '../src/shared/development/icons/jobs'

const context: IconCodegenContext = {
  body: '<path class="a" stroke-width="2" d="M0 0L4 4"/><text>Hi {there}</text>',
  viewBox: '0 0 24 24',
  size: 48,
  strokeWidth: 1.5,
  color: '#112233',
  slug: 'arrow-right',
}

describe('development icons contract', () => {
  it('keeps the agreed schema versions and presets', () => {
    expect(DEVELOPMENT_ICONS_CORE_SCHEMA_VERSION).toBe(320)
    expect(DEVELOPMENT_ICONS_SETTINGS_SCHEMA_VERSION).toBe(321)
    expect(DEVELOPMENT_ICONS_SCHEMA_VERSIONS).toEqual([320, 321, 325, 326])
    expect(ICON_PNG_PRESETS).toEqual([24, 48, 96, 192, 512])
    expect(ICON_ICO_PRESETS).toEqual([16, 32, 48, 256])
    expect(ICON_PAGE_SIZE_DEFAULT).toBe(60)
    expect(ICON_PAGE_SIZE_MAX).toBe(120)
  })

  it('parses list queries with defaults and rejects oversized pages', () => {
    expect(IconListQuerySchema.parse({})).toMatchObject({ limit: 60, state: 'all', sort: 'created' })
    expect(IconListQuerySchema.parse({ limit: '120', state: 'favorites' })).toMatchObject({ limit: 120 })
    expect(IconListQuerySchema.safeParse({ limit: 121 }).success).toBe(false)
    expect(IconListQuerySchema.safeParse({ q: 'x'.repeat(65) }).success).toBe(false)
  })

  it('accepts only the agreed PNG and ICO presets', () => {
    expect(IconJobCreateSchema.safeParse({ assetIds: ['a1'], options: { kind: 'png', sizes: [24, 512] } }).success).toBe(true)
    expect(IconJobCreateSchema.safeParse({ assetIds: ['a1'], options: { kind: 'png', sizes: [32] } }).success).toBe(false)
    expect(IconJobCreateSchema.safeParse({ assetIds: ['a1'], options: { kind: 'png', sizes: [24, 24] } }).success).toBe(false)
    expect(IconJobCreateSchema.safeParse({ assetIds: ['a1'], options: { kind: 'ico', sizes: [16, 256] } }).success).toBe(true)
    expect(IconJobCreateSchema.safeParse({ assetIds: ['a1'], options: { kind: 'ico', sizes: [128] } }).success).toBe(false)
  })

  it('applies sprite defaults and rejects unsupported scales', () => {
    const parsed = IconJobCreateSchema.parse({
      assetIds: ['a1'],
      options: { kind: 'sprite_png' },
    })
    expect(parsed.options).toMatchObject({ kind: 'sprite_png', padding: ICON_SPRITE_PADDING_DEFAULT, scales: [1], scss: false })
    expect(IconJobCreateSchema.safeParse({ assetIds: ['a1'], options: { kind: 'sprite_png', scales: [3] } }).success).toBe(false)
    expect(IconJobCreateSchema.safeParse({ assetIds: ['a1'], options: { kind: 'sprite_svg', padding: 40 } }).success).toBe(false)
  })

  it('validates settings and export payloads', () => {
    expect(IconSettingsPatchSchema.safeParse({ quotaBytes: 1024 }).success).toBe(true)
    expect(IconSettingsPatchSchema.safeParse({}).success).toBe(false)
    expect(IconExportCreateSchema.safeParse({ format: 'zip', assetIds: ['a1'] }).success).toBe(true)
    expect(IconExportCreateSchema.safeParse({ format: 'gif', assetIds: ['a1'] }).success).toBe(false)
  })

  it('accepts only whitelisted Iconify prefixes', () => {
    expect(IconImportCreateSchema.safeParse({ kind: 'iconify', prefix: 'lucide' }).success).toBe(true)
    expect(IconImportCreateSchema.safeParse({ kind: 'iconify', prefix: 'unknown' }).success).toBe(false)
    expect(IconImportCreateSchema.safeParse({ kind: 'upload' }).success).toBe(true)
  })

  it('round-trips cursors and rejects malformed ones', () => {
    const cursor = { sort: 'name' as const, key: '箭头', id: 'abc123' }
    expect(decodeIconCursor(encodeIconCursor(cursor))).toEqual(cursor)
    expect(decodeIconCursor('not-base64!')).toBeNull()
    expect(decodeIconCursor(btoa(JSON.stringify({ sort: 'bad', key: 1, id: 'a' })))).toBeNull()
    expect(decodeIconCursor('x'.repeat(600))).toBeNull()
  })

  it('builds SVG and escaped JSX', () => {
    const svg = buildSvgString(context)
    expect(svg).toContain('width="48"')
    expect(svg).toContain('viewBox="0 0 24 24"')
    expect(svg).toContain('color:#112233')
    const jsx = buildJsxString(context)
    expect(jsx).toContain('width={48}')
    expect(jsx).toContain('strokeWidth={1.5}')
    expect(jsx).toContain('className="a"')
    expect(jsx).toContain("{'{'}")
  })

  it('builds a data URL, component name and framework snippets', () => {
    expect(buildDataUrl(context).startsWith('data:image/svg+xml,')).toBe(true)
    expect(buildComponentName('arrow-right')).toBe('IconArrowRight')
    expect(buildCodegen('react', context)).toContain('export function IconArrowRight')
    expect(buildCodegen('vue', context)).toContain('<template>')
    expect(buildCodegen('svelte', context)).toContain('export let size')
    expect(buildCodegen('component', context)).toBe('IconArrowRight')
  })

  it('describes job defaults and progress', () => {
    expect(defaultIconJobOptions('png')).toEqual({ kind: 'png', sizes: [...ICON_PNG_PRESETS] })
    expect(defaultIconJobOptions('ico')).toEqual({ kind: 'ico', sizes: [...ICON_ICO_PRESETS] })
    expect(isIconJobTerminal('partial')).toBe(true)
    expect(isIconJobTerminal('running')).toBe(false)
    expect(iconJobProgress({ totalItems: 10, processedItems: 6, failedItems: 2 })).toBe(80)
    expect(iconJobProgress({ totalItems: 0, processedItems: 0, failedItems: 0 })).toBe(0)
  })
})
