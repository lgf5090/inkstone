/**
 * Microsoft Fluent Design Color System (Theme, Neutral, Accent rows, System status)
 */

import type { UiPaletteGroup } from './ui-flat'

export const FLUENT_UI_PALETTES: UiPaletteGroup[] = [
  {
    id: 'fluent-theme',
    name: 'Theme Primary (蓝调主色阶)',
    colors: [
      { name: 'themeDarker', hex: '#004578' },
      { name: 'themeDark', hex: '#005a9e' },
      { name: 'themeDarkAlt', hex: '#106ebe' },
      { name: 'themePrimary', hex: '#0078d4' },
      { name: 'themeSecondary', hex: '#2b88d8' },
      { name: 'themeTertiary', hex: '#71afe5' },
      { name: 'themeLight', hex: '#c7e0f4' },
      { name: 'themeLighter', hex: '#deecf9' },
      { name: 'themeLighterAlt', hex: '#eff6fc' },
    ],
  },
  {
    id: 'fluent-neutral',
    name: 'Neutral (中性灰阶)',
    colors: [
      { name: 'black', hex: '#000000' },
      { name: 'neutralDark', hex: '#201f1e' },
      { name: 'neutralPrimary', hex: '#323130' },
      { name: 'neutralPrimaryAlt', hex: '#3b3a39' },
      { name: 'neutralSecondary', hex: '#605e5c' },
      { name: 'neutralSecondaryAlt', hex: '#8a8886' },
      { name: 'neutralTertiary', hex: '#a19f9d' },
      { name: 'neutralTertiaryAlt', hex: '#c8c6c4' },
      { name: 'neutralLight', hex: '#edebe9' },
      { name: 'neutralLighter', hex: '#f3f2f1' },
      { name: 'neutralLighterAlt', hex: '#faf9f8' },
      { name: 'white', hex: '#ffffff' },
    ],
  },
  {
    id: 'fluent-accent',
    name: 'Accent Colors (高饱和强调色)',
    colors: [
      { name: 'Yellow', hex: '#ffb900' },
      { name: 'Orange', hex: '#d83b01' },
      { name: 'Red', hex: '#e81123' },
      { name: 'Magenta', hex: '#b4009e' },
      { name: 'Purple', hex: '#5c2d91' },
      { name: 'Blue', hex: '#0078d7' },
      { name: 'Teal', hex: '#008272' },
      { name: 'Green', hex: '#107c41' },
    ],
  },
  {
    id: 'fluent-status',
    name: 'Message & Status (系统状态反馈色)',
    colors: [
      { name: 'Success Dark', hex: '#0b6a0b' },
      { name: 'Success Primary', hex: '#107c10' },
      { name: 'Success Light', hex: '#dff6dd' },
      { name: 'Warning Dark', hex: '#794b02' },
      { name: 'Warning Primary', hex: '#797775' },
      { name: 'Warning Light', hex: '#fff4ce' },
      { name: 'Error Dark', hex: '#a80000' },
      { name: 'Error Primary', hex: '#d13438' },
      { name: 'Error Light', hex: '#fde7e9' },
    ],
  },
]
