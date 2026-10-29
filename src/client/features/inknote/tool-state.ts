/** Derives the engine's tool state from the account's remembered per-tool choices. */
import type { InknoteSettings, InknoteTextBox } from '@shared/inknote/types'
import type { InknoteToolState } from './engine/inknote-engine-types'
import { randomLocalId } from '../../lib/random-id'

export function inknoteToolState(settings: InknoteSettings): InknoteToolState {
  const tool = settings.tool
  const color = tool === 'highlighter'
    ? settings.hlColor
    : tool === 'pen'
      ? settings.penColor
      : tool === 'ballpen'
        ? settings.ballpenColor
        : settings.color
  const width = tool === 'highlighter' ? settings.hlWidth : tool === 'pen' ? settings.penWidth : settings.ballpenWidth
  return {
    tool,
    color,
    width,
    style: tool === 'pen' ? settings.penStyle : settings.ballpenStyle,
    shape: settings.shape,
    eraserSize: settings.eraserSize,
    eraserMode: settings.eraserMode,
  }
}

export function inknoteTextDefaults(): InknoteTextBox {
  return {
    id: randomLocalId(),
    x: 0.1,
    y: 0.1,
    w: 0.45,
    h: 0.08,
    text: '',
    fontSize: 26,
    color: '#1e293b',
    align: 'left',
    bold: false,
    italic: false,
    underline: false,
    hl: null,
    lh: 1.3,
    list: null,
  }
}
