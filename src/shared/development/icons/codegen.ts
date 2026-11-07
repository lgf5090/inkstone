import type { IconCodegenTab } from './types'

export interface IconCodegenContext {
  body: string
  viewBox: string
  size: number
  strokeWidth: number
  color: string
  slug: string
}

const DEFAULT_VIEW_BOX = '0 0 24 24'
const COLOR_RE = /^(currentColor|#[0-9a-fA-F]{3,8})$/
const VIEW_BOX_RE = /^-?\d+(?:\.\d+)? -?\d+(?:\.\d+)? -?\d+(?:\.\d+)? -?\d+(?:\.\d+)?$/

const ATTRIBUTE_MAP: Record<string, string> = {
  'class': 'className',
  'clip-path': 'clipPath',
  'clip-rule': 'clipRule',
  'fill-opacity': 'fillOpacity',
  'fill-rule': 'fillRule',
  'stroke-width': 'strokeWidth',
  'stroke-linecap': 'strokeLinecap',
  'stroke-linejoin': 'strokeLinejoin',
  'stroke-opacity': 'strokeOpacity',
  'stroke-dasharray': 'strokeDasharray',
  'stroke-dashoffset': 'strokeDashoffset',
  'xlink:href': 'xlinkHref',
  'xmlns:xlink': 'xmlnsXlink',
}

function safeViewBox(viewBox: string): string {
  return VIEW_BOX_RE.test(viewBox.trim()) ? viewBox.trim() : DEFAULT_VIEW_BOX
}

function safeSize(size: number): number {
  return Number.isFinite(size) ? Math.min(512, Math.max(8, Math.round(size))) : 24
}

function safeStroke(strokeWidth: number): number {
  return Number.isFinite(strokeWidth) ? Math.min(4, Math.max(0.5, strokeWidth)) : 2
}

function safeColor(color: string): string {
  return COLOR_RE.test(color) ? color : 'currentColor'
}

function escapeJsxText(text: string): string {
  return text.replace(/[{}]/g, (character) => (character === '{' ? "{'{'}" : "{'}'}"))
}

function escapeJsxBody(body: string): string {
  return body
    .replace(/(>)([^<]*)(<)/g, (_match, open: string, text: string, close: string) => `${open}${escapeJsxText(text)}${close}`)
    .replace(/\bclass=/g, 'className=')
    .replace(/\b([a-z]+(?:-[a-z]+)+)=/g, (_match, name: string) => `${ATTRIBUTE_MAP[name] ?? name}=`)
}

function normalizedContext(context: IconCodegenContext): IconCodegenContext {
  return {
    body: context.body.trim(),
    viewBox: safeViewBox(context.viewBox),
    size: safeSize(context.size),
    strokeWidth: safeStroke(context.strokeWidth),
    color: safeColor(context.color),
    slug: context.slug.trim(),
  }
}

export function buildSvgString(context: IconCodegenContext): string {
  const value = normalizedContext(context)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${value.size}" height="${value.size}" viewBox="${value.viewBox}" fill="none" stroke-width="${value.strokeWidth}" style="color:${value.color}">${value.body}</svg>`
}

export function buildJsxString(context: IconCodegenContext): string {
  const value = normalizedContext(context)
  return `<svg xmlns="http://www.w3.org/2000/svg" width={${value.size}} height={${value.size}} viewBox="${value.viewBox}" fill="none" strokeWidth={${value.strokeWidth}} style={{ color: "${value.color}" }}>${escapeJsxBody(value.body)}</svg>`
}

export function buildDataUrl(context: IconCodegenContext): string {
  const svg = buildSvgString(context)
  const encoded = encodeURIComponent(svg).replace(/'/g, '%27').replace(/"/g, '%22')
  return `data:image/svg+xml,${encoded}`
}

export function buildComponentName(slug: string): string {
  const parts = slug
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  const name = parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  return name ? `Icon${name}` : 'IconAsset'
}

export function buildReactCode(context: IconCodegenContext): string {
  const value = normalizedContext(context)
  const name = buildComponentName(value.slug)
  return `import type { SVGProps } from "react"\n\nexport function ${name}(props: SVGProps<SVGSVGElement>) {\n  return (\n    ${buildJsxString(value).replace('<svg ', '<svg {...props} ')}\n  )\n}`
}

export function buildVueCode(context: IconCodegenContext): string {
  const value = normalizedContext(context)
  return `<template>\n  ${buildSvgString({ ...value, size: value.size })}\n</template>`
}

export function buildSvelteCode(context: IconCodegenContext): string {
  const value = normalizedContext(context)
  return `<script lang="ts">\n  export let size = ${value.size}\n</script>\n\n${buildSvgString({ ...value, size: value.size }).replace(`width="${value.size}" height="${value.size}"`, 'width={size} height={size}')}`
}

export function buildTsImport(context: IconCodegenContext): string {
  const name = buildComponentName(context.slug)
  return `import { ${name} } from "./icons/${name}"`
}

export function buildCodegen(tab: IconCodegenTab, context: IconCodegenContext): string {
  if (tab === 'svg') return buildSvgString(context)
  if (tab === 'data-url') return buildDataUrl(context)
  if (tab === 'jsx') return buildJsxString(context)
  if (tab === 'react') return buildReactCode(context)
  if (tab === 'vue') return buildVueCode(context)
  if (tab === 'svelte') return buildSvelteCode(context)
  if (tab === 'component') return buildComponentName(context.slug)
  return buildTsImport(context)
}
