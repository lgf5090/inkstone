import { describe, expect, it } from 'vitest'
import { BUILT_IN_PROJECT_TEMPLATES, localizeProjectTemplate } from './templates'

const welcome = BUILT_IN_PROJECT_TEMPLATES.find((template) => template.title === 'Welcome to Boards')!

describe('built-in template localization (UI-3)', () => {
  it('zh resolves titles, properties, options, views and demo content', () => {
    const zh = localizeProjectTemplate(welcome, 'zh-CN')
    expect(zh.title).toBe('欢迎使用看板')
    expect(zh.properties.find((p) => p.name === '状态')).toBeTruthy()
    expect(zh.properties.flatMap((p) => p.options).some((o) => o.value === '未开始')).toBe(true)
    expect(zh.views.map((v) => v.title)).toContain('表格')
    expect(zh.cards.map((c) => c.title)).toContain('打开卡片即可编辑')
    expect(zh.cards.flatMap((c) => c.contents ?? []).some((c) => c.title === '卡片包含属性、正文与评论。')).toBe(true)
  })

  it('non-zh locales keep the source strings', () => {
    expect(localizeProjectTemplate(welcome, 'en-US')).toEqual(welcome)
  })

  it('ids are untouched so re-instantiation never collides', () => {
    const zh = localizeProjectTemplate(welcome, 'zh-CN')
    expect(zh.id).toBe(welcome.id)
    expect(zh.properties.map((p) => p.id)).toEqual(welcome.properties.map((p) => p.id))
  })
})