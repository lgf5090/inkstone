import { encode, QrCodeDataType, type QrCodeGenerateResult } from 'uqr'
import type {
  QrErrorCorrectionLevel,
  QrMarginNoiseSpace,
  QrRenderPointsType,
  QrStylingOptions,
  QrToolkitMarkerInnerShape,
  QrToolkitMarkerShape,
  QrToolkitMarkerState,
  QrToolkitOptions,
  QrToolkitPixelStyle,
} from '../../../../../shared/tools/qrcode/types'
import { crystalize } from './effects/crystalize'
import { liquidify } from './effects/liquidify'
import { PerspectiveTransformer } from './effects/perspective'

export interface ToolkitQrResult {
  width: number
  height: number
  size: number
  version: number
  maskPattern: number
  ecc: QrErrorCorrectionLevel
}

interface MarkerInfo {
  x: number
  y: number
  position: 'top-left' | 'top-right' | 'bottom-left' | 'sub'
  isCenter: boolean
  isBorder: boolean
  isInner: boolean
  style: QrToolkitMarkerState
}

interface PixelInfo {
  x: number
  y: number
  isDark: boolean
  isBorder: boolean
  isIgnored: boolean
  marker?: MarkerInfo
}

function createRng(seed: number) {
  let s = Math.abs(seed || 1)
  return (...extra: (string | number)[]) => {
    let str = extra.join('|')
    let hash = s
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) & 0xffffffff
    }
    const x = Math.sin(hash) * 10000
    return x - Math.floor(x)
  }
}

export function isToolkitRenderingNeeded(options: QrStylingOptions): boolean {
  const tk = options.toolkitOptions
  if (!tk) return false
  if (tk.enabled) return true
  if (tk.effect && tk.effect !== 'none') return true
  if (tk.marginNoise) return true
  if (tk.transformPerspectiveX || tk.transformPerspectiveY) return true
  if (Boolean(tk.rotate)) return true
  if (tk.invert) return true
  if (tk.markers && tk.markers.length > 0) return true
  if (tk.pixelStyle && ['squircle', 'row', 'column'].includes(tk.pixelStyle)) return true
  if (tk.markerShape && ['plus', 'box', 'octagon', 'random', 'tiny-plus'].includes(tk.markerShape)) return true
  if (tk.markerInnerShape && ['plus', 'diamond', 'eye'].includes(tk.markerInnerShape)) return true
  return false
}

export async function renderToolkitQRCode(
  outCanvas: HTMLCanvasElement,
  text: string,
  options: QrStylingOptions,
): Promise<ToolkitQrResult> {
  const tk: QrToolkitOptions = options.toolkitOptions ?? {}
  const ecc = options.errorCorrectionLevel ?? 'M'
  const seed = tk.seed ?? 12345
  const rng = createRng(seed)

  const minVersion = Math.max(1, Math.min(40, tk.minVersion ?? 1))
  const maxVersion = Math.max(minVersion, Math.min(40, tk.maxVersion ?? 40))
  const maskPattern = typeof tk.maskPattern === 'number' ? tk.maskPattern : -1
  const boostEcc = Boolean(tk.boostECC)

  const qr: QrCodeGenerateResult = encode(text || 'https://inkstone.app', {
    minVersion,
    maxVersion,
    ecc,
    maskPattern,
    boostEcc,
    border: 0,
  })

  const targetWidth = options.width ?? 1000
  const marginCells = Math.max(0, Math.floor(options.margin ?? 4))
  const totalCells = qr.size + marginCells * 2
  const cell = Math.max(2, Math.floor(targetWidth / totalCells))
  const halfcell = cell / 2
  const width = totalCells * cell
  const height = width

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.clearRect(0, 0, width, height)
  ctx.imageSmoothingEnabled = false

  const darkColorHex = options.dotsOptions?.color || '#000000'
  const lightColorHex = options.backgroundOptions?.color || '#ffffff'
  const invert = Boolean(tk.invert)

  const pixelStyle: QrToolkitPixelStyle = tk.pixelStyle || 'square'
  const defaultMarkerShape: QrToolkitMarkerShape = tk.markerShape || 'square'
  const defaultMarkerInnerShape: QrToolkitMarkerInnerShape = tk.markerInnerShape || 'auto'
  const markerSub = tk.markerSub || 'square'
  const marginNoise = Boolean(tk.marginNoise)
  const marginNoiseRate = tk.marginNoiseRate ?? 0.5
  const marginNoiseSpace: QrMarginNoiseSpace = tk.marginNoiseSpace || 'marker'
  const renderPointsType: QrRenderPointsType = tk.renderPointsType || 'all'
  const rotate = tk.rotate || 0

  function getBorderOpacity(x: number, y: number): number {
    if (typeof tk.marginNoiseOpacity === 'number') {
      return tk.marginNoiseOpacity
    }
    if (Array.isArray(tk.marginNoiseOpacity) && tk.marginNoiseOpacity.length >= 2) {
      const [min, max] = tk.marginNoiseOpacity
      return rng(x, y, 'noise-op') * (max - min) + min
    }
    return 1
  }

  function resolveMarkerStyle(index: number): QrToolkitMarkerState {
    const customList = tk.markers || []
    const m = index === 0 ? null : customList[index - 1]
    const markerShape = m?.markerShape || defaultMarkerShape
    let markerInnerShape = m?.markerInnerShape || defaultMarkerInnerShape

    if (markerInnerShape === 'auto') {
      if (markerShape === 'circle') markerInnerShape = 'circle'
      else if (markerShape === 'tiny-plus') markerInnerShape = 'plus'
      else if (markerShape === 'octagon') markerInnerShape = 'diamond'
      else markerInnerShape = 'square'
    }

    return { markerShape, markerInnerShape }
  }

  function getModule(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= qr.size || y >= qr.size) return false
    return qr.data[y]?.[x] ?? false
  }

  function getType(x: number, y: number): QrCodeDataType {
    if (x < 0 || y < 0 || x >= qr.size || y >= qr.size) return QrCodeDataType.Border
    return qr.types[y]?.[x] ?? QrCodeDataType.Border
  }

  function getInfo(x: number, y: number): PixelInfo {
    let isBorder =
      marginNoiseSpace === 'full'
        ? x < -1 || y < -1 || x > qr.size || y > qr.size
        : x < 0 || y < 0 || x >= qr.size || y >= qr.size
    let isIgnored = false
    let isDark = false

    if (isBorder && marginNoise) {
      isDark = rng(x, y, 'border-noise') < marginNoiseRate
    } else {
      isDark = getModule(x, y)
      if (renderPointsType === 'data' && getType(x, y) !== QrCodeDataType.Data) {
        isDark = false
        isIgnored = true
      } else if (
        (renderPointsType === 'function' || renderPointsType === 'guide' || renderPointsType === 'marker') &&
        getType(x, y) < QrCodeDataType.Function
      ) {
        isDark = false
        isIgnored = true
      }
    }

    if (renderPointsType !== 'data' && renderPointsType !== 'guide') {
      if (marginNoiseSpace === 'marker') {
        if (
          (x >= -1 && x <= 7 && y >= -1 && y <= 7) ||
          (x >= -1 && x <= 7 && y >= qr.size - 8 && y <= qr.size) ||
          (x >= qr.size - 8 && x <= qr.size && y >= -1 && y <= 7)
        ) {
          isBorder = false
          isIgnored = false
        }
      } else if (marginNoiseSpace === 'minimal' || marginNoiseSpace === 'extreme') {
        if (
          (y >= 2 && y <= 4 && (x === -1 || x === qr.size)) ||
          (x >= 2 && x <= 4 && (y === -1 || y === qr.size)) ||
          (y >= qr.size - 5 && y <= qr.size - 3 && (x === -1 || x === 7)) ||
          (x >= qr.size - 5 && x <= qr.size - 3 && (y === -1 || y === 7))
        ) {
          isBorder = false
          isIgnored = false
        }
      }
    }

    let marker: MarkerInfo | undefined

    function createMarker(mx: number, my: number, pos: MarkerInfo['position']) {
      const isInner = pos === 'sub' ? mx === 2 && my === 2 : mx >= 2 && mx <= 4 && my >= 2 && my <= 4
      const isCenter = pos === 'sub' ? mx === 2 && my === 2 : mx === 3 && my === 3
      const isMarkerBorder = !isInner

      return {
        x: mx,
        y: my,
        position: pos,
        isInner,
        isBorder: isMarkerBorder,
        isCenter,
        style: resolveMarkerStyle(pos === 'top-left' ? 0 : pos === 'top-right' ? 1 : pos === 'bottom-left' ? 2 : 3),
      }
    }

    if (x >= 0 && x < 7 && y >= 0 && y < 7) {
      marker = createMarker(x, y, 'top-left')
    } else if (x >= 0 && x < 7 && y >= qr.size - 7 && y < qr.size) {
      marker = createMarker(x, y - qr.size + 7, 'bottom-left')
    } else if (x >= qr.size - 7 && x < qr.size && y >= 0 && y < 7) {
      marker = createMarker(x - qr.size + 7, y, 'top-right')
    } else if (getType(x, y) === QrCodeDataType.Alignment) {
      let dx = x
      let dy = y
      while (getType(dx, dy) === QrCodeDataType.Alignment) dx -= 1
      dx += 1
      while (getType(dx, dy) === QrCodeDataType.Alignment) dy -= 1
      dy += 1
      marker = createMarker(x - dx, y - dy, 'sub')
    }

    if (marker) {
      if (marker.position !== 'sub') {
        if (marker.isBorder) {
          const { markerShape } = marker.style
          if (markerShape === 'circle' || markerShape === 'octagon') {
            isDark = false
          } else if (markerShape === 'plus') {
            if (!((marker.x >= 2 && marker.x <= 4) || (marker.y >= 2 && marker.y <= 4))) {
              isDark = false
            }
          } else if (markerShape === 'box') {
            if (!((marker.x >= 1 && marker.x <= 5) || (marker.y >= 1 && marker.y <= 5))) {
              isDark = false
            }
          } else if (markerShape === 'random') {
            if (marker.x !== 3 && marker.y !== 3) {
              if (isDark) isDark = rng(x, y, 'marker') < 0.5
            }
          } else if (markerShape === 'tiny-plus') {
            if (marker.x !== 3 && marker.y !== 3) {
              isDark = false
            }
          }
        }

        if (marker.isInner && marker.style.markerInnerShape === 'plus') {
          if (marker.x !== 3 && marker.y !== 3) isDark = false
        }
      } else if (marker.position === 'sub') {
        if (marker.isBorder) {
          if (markerSub === 'circle') isDark = false
          else if (markerSub === 'plus') {
            if (marker.x !== 2 && marker.y !== 2) isDark = false
          } else if (markerSub === 'box') {
            if (!((marker.x >= 1 && marker.x <= 3) || (marker.y >= 1 && marker.y <= 3))) isDark = false
          } else if (markerSub === 'random') {
            if (marker.x !== 2 && marker.y !== 2) {
              if (isDark) isDark = rng(x, y, 'marker-sub') < 0.5
            }
          }
        }
      }
    }

    let targetX = x
    let targetY = y
    if (x >= -1 && y >= -1 && x < qr.size + 1 && y < qr.size + 1) {
      if (rotate === 90) {
        targetX = qr.size - x - 1
        ;[targetX, targetY] = [targetY, targetX]
      } else if (rotate === 180) {
        targetX = qr.size - x - 1
        targetY = qr.size - y - 1
      } else if (rotate === 270) {
        targetY = qr.size - y - 1
        ;[targetX, targetY] = [targetY, targetX]
      }
    }

    targetX += marginCells
    targetY += marginCells

    if (renderPointsType === 'guide' && marker) {
      isDark = false
      isIgnored = true
    }
    if (renderPointsType === 'marker' && !marker) {
      isDark = false
      isIgnored = true
    }

    return {
      isDark,
      isBorder,
      marker,
      isIgnored,
      x: targetX,
      y: targetY,
    }
  }

  const pixels: PixelInfo[] = []
  for (let y = -marginCells; y < qr.size + marginCells; y++) {
    for (let x = -marginCells; x < qr.size + marginCells; x++) {
      pixels.push(getInfo(x, y))
    }
  }

  pixels.sort((a, b) => {
    const getOrder = (p: PixelInfo) => {
      if (p.marker?.isBorder) return 0
      if (p.marker?.isCenter) return 1
      if (p.marker?.isInner) return 2
      return 4
    }
    return getOrder(a) - getOrder(b)
  })

  const darkHex = invert ? lightColorHex : darkColorHex

  for (const { isDark, marker, x, y, isBorder, isIgnored } of pixels) {
    if (isIgnored) continue

    let curPixelStyle = pixelStyle
    const opacity = isBorder ? getBorderOpacity(x, y) : 1
    const finalDarkColor =
      opacity === 1 ? darkColorHex : darkHex + Math.round(opacity * 255).toString(16).padStart(2, '0')

    const drawLightColor = invert ? finalDarkColor : lightColorHex
    const drawDarkColor = invert ? lightColorHex : finalDarkColor
    ctx.fillStyle = drawDarkColor

    const cX = x * cell + halfcell
    const cY = y * cell + halfcell

    if (marker && marker.position !== 'sub') {
      const { markerShape } = marker.style
      if (renderPointsType === 'data') continue

      if (markerShape === 'circle') {
        if (marker.isBorder) continue
        if (marker.isCenter) {
          ctx.fillStyle = drawLightColor
          ctx.fillRect(cX - cell * 3.5, cY - cell * 3.5, cell * 7, cell * 7)
          ctx.beginPath()
          ctx.fillStyle = drawDarkColor
          ctx.arc(cX, cY, cell * 3.5, 0, Math.PI * 2)
          ctx.fill()
          ctx.beginPath()
          ctx.fillStyle = drawLightColor
          ctx.arc(cX, cY, cell * 2.5, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = drawDarkColor
        }
      } else if (markerShape === 'octagon') {
        if (marker.isBorder) continue
        if (marker.isCenter) {
          ctx.fillStyle = drawLightColor
          ctx.fillRect(cX - cell * 3.5, cY - cell * 3.5, cell * 7, cell * 7)
          const octagonFor = (dx: number, dy: number) =>
            [
              [dx, dy],
              [-dx, dy],
              [-dy, dx],
              [-dy, -dx],
              [-dx, -dy],
              [dx, -dy],
              [dy, -dx],
              [dy, dx],
            ] as const

          const drawOct = (size: number) => {
            ctx.beginPath()
            const pts = octagonFor((1.5 / 3.5) * size, size)
            pts.forEach(([px, py], i) => {
              if (i === 0) ctx.moveTo(cX + px * cell, cY + py * cell)
              else ctx.lineTo(cX + px * cell, cY + py * cell)
            })
            ctx.closePath()
            ctx.fill()
          }

          ctx.fillStyle = drawDarkColor
          drawOct(3.5)
          ctx.fillStyle = drawLightColor
          drawOct(2.5)
          ctx.fillStyle = drawDarkColor
        }
      }

      if (marker.isInner) {
        const { markerInnerShape } = marker.style
        if (markerInnerShape === 'circle') {
          if (marker.isCenter) {
            ctx.fillStyle = drawLightColor
            ctx.fillRect(cX - cell * 1.5, cY - cell * 1.5, cell * 3, cell * 3)
            ctx.beginPath()
            ctx.fillStyle = drawDarkColor
            ctx.arc(cX, cY, cell * 1.5, 0, Math.PI * 2)
            ctx.fill()
          }
          continue
        } else if (markerInnerShape === 'eye') {
          if (marker.isCenter) {
            ctx.fillStyle = drawLightColor
            ctx.fillRect(cX - cell * 1.5, cY - cell * 1.5, cell * 3, cell * 3)
            ctx.beginPath()
            ctx.fillStyle = drawDarkColor
            ctx.moveTo(cX, cY - cell * 1.5)
            ctx.arcTo(cX + cell * 1.5, cY, cX, cY + cell * 1.5, cell)
            ctx.lineTo(cX, cY + cell * 1.5)
            ctx.arcTo(cX - cell * 1.5, cY, cX, cY - cell * 1.5, cell)
            ctx.fill()
          }
          continue
        } else if (markerInnerShape === 'diamond') {
          if (marker.isCenter) {
            ctx.fillStyle = drawLightColor
            ctx.fillRect(cX - cell * 1.5, cY - cell * 1.5, cell * 3, cell * 3)
            ctx.beginPath()
            ctx.fillStyle = drawDarkColor
            ctx.moveTo(cX, cY - cell * 1.5)
            ctx.lineTo(cX + cell * 1.5, cY)
            ctx.lineTo(cX, cY + cell * 1.5)
            ctx.lineTo(cX - cell * 1.5, cY)
            ctx.fill()
          }
          continue
        }
      }
    }

    if (marker?.position === 'sub' && markerSub === 'circle') {
      if (renderPointsType !== 'data') {
        if (marker.isBorder) continue
        if (marker.isCenter) {
          ctx.fillStyle = drawLightColor
          ctx.fillRect(cX - cell * 2.5, cY - cell * 2.5, cell * 5, cell * 5)
          ctx.beginPath()
          ctx.fillStyle = drawDarkColor
          ctx.arc(cX, cY, cell * 2.5, 0, Math.PI * 2)
          ctx.fill()
          ctx.beginPath()
          ctx.fillStyle = drawLightColor
          ctx.arc(cX, cY, cell * 1.5, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = drawDarkColor
        }
      }
    }

    function drawSquare(c = isDark ? drawDarkColor : drawLightColor) {
      ctx.fillStyle = c
      ctx.fillRect(x * cell, y * cell, cell, cell)
    }

    function drawDot(c = isDark ? drawDarkColor : drawLightColor) {
      ctx.fillStyle = c
      ctx.beginPath()
      ctx.arc(x * cell + halfcell, y * cell + halfcell, halfcell, 0, Math.PI * 2)
      ctx.fill()
    }

    function drawCorner(index: number, c?: string) {
      const pos = [
        [0, 0, 0, 1, 1, 0],
        [0, 2, 0, 1, 1, 2],
        [2, 0, 2, 1, 1, 0],
        [2, 2, 2, 1, 1, 2],
      ][index]
      if (c) ctx.fillStyle = c
      ctx.beginPath()
      ctx.moveTo(x * cell + halfcell * pos[0], y * cell + halfcell * pos[1])
      ctx.lineTo(x * cell + halfcell * pos[2], y * cell + halfcell * pos[3])
      ctx.arcTo(
        x * cell + halfcell * pos[0],
        y * cell + halfcell * pos[1],
        x * cell + halfcell * pos[4],
        y * cell + halfcell * pos[5],
        halfcell + 2,
      )
      ctx.fill()
    }

    if (curPixelStyle === 'dot') {
      drawDot()
    } else if (curPixelStyle === 'squircle') {
      drawDot()
      for (let i = 0; i < 4; i++) {
        if (rng(x, y, `squircle-${i}`) < 0.5) {
          drawCorner(i)
        }
      }
    } else if (curPixelStyle === 'rounded' || curPixelStyle === 'row' || curPixelStyle === 'column') {
      const shouldConnect = (dx: number, dy: number) => {
        const p = pixels.find((pxl) => pxl.x === x + dx && pxl.y === y + dy)
        if (!p) return true
        if (p.isIgnored || (p.isBorder && !p.isDark)) return null
        return p.isDark
      }

      const top = shouldConnect(0, -1)
      const bottom = shouldConnect(0, 1)
      const left = shouldConnect(-1, 0)
      const right = shouldConnect(1, 0)

      if (isDark) {
        const corners: (null | boolean)[] = [null, null, null, null]
        if (curPixelStyle !== 'row') {
          corners[0] ||= top
          corners[2] ||= top
          corners[1] ||= bottom
          corners[3] ||= bottom
        }
        if (curPixelStyle !== 'column') {
          corners[0] ||= left
          corners[1] ||= left
          corners[2] ||= right
          corners[3] ||= right
        }
        corners.forEach((c, idx) => {
          if (c != null) drawCorner(idx, c ? drawDarkColor : drawLightColor)
        })
      } else {
        if (curPixelStyle === 'row') {
          if (left != null) {
            drawCorner(0, drawLightColor)
            drawCorner(1, drawLightColor)
          }
          if (right != null) {
            drawCorner(2, drawLightColor)
            drawCorner(3, drawLightColor)
          }
        } else if (curPixelStyle === 'column') {
          if (top != null) {
            drawCorner(0, drawLightColor)
            drawCorner(2, drawLightColor)
          }
          if (bottom != null) {
            drawCorner(1, drawLightColor)
            drawCorner(3, drawLightColor)
          }
        }
      }
      drawDot()
    } else {
      drawSquare()
    }
  }

  // 3D Perspective Transformation
  if (tk.transformPerspectiveX || tk.transformPerspectiveY) {
    const pX = tk.transformPerspectiveX || 0
    const pY = tk.transformPerspectiveY || 0
    const data = ctx.getImageData(0, 0, width, height)
    ctx.clearRect(0, 0, width, height)
    const perspective = new PerspectiveTransformer(ctx, data)
    const quad = {
      topLeftX: 0,
      topLeftY: 0,
      topRightX: width,
      topRightY: 0,
      bottomRightX: width,
      bottomRightY: height,
      bottomLeftX: 0,
      bottomLeftY: height,
    }
    if (pX !== 0) {
      const offsetX = Math.abs((width * pX) / 2)
      const offsetY = Math.abs((height * pX) / 3)
      if (pX > 0) {
        quad.topLeftX += offsetX
        quad.bottomLeftX += offsetX
        quad.topRightY += offsetY
        quad.bottomRightY -= offsetY
      } else {
        quad.topRightX -= offsetX
        quad.bottomRightX -= offsetX
        quad.topLeftY += offsetY
        quad.bottomLeftY -= offsetY
      }
    }
    if (pY !== 0) {
      const offsetX = Math.abs((width * pY) / 3)
      const offsetY = Math.abs((height * pY) / 2)
      if (pY > 0) {
        quad.topLeftY += offsetY
        quad.topRightY += offsetY
        quad.bottomLeftX += offsetX
        quad.bottomRightX -= offsetX
      } else {
        quad.bottomLeftY -= offsetY
        quad.bottomRightY -= offsetY
        quad.topLeftX += offsetX
        quad.topRightX -= offsetX
      }
    }
    perspective.draw(quad)
  }

  // Apply Organic Effects (crystalize or liquidify)
  if (tk.effect === 'crystalize' && tk.effectCrystalizeRadius) {
    const rawData = ctx.getImageData(0, 0, width, height)
    const crystalData = crystalize(rawData, tk.effectCrystalizeRadius, seed)
    ctx.putImageData(crystalData, 0, 0)
  } else if (tk.effect === 'liquidify' && tk.effectLiquidifyRadius) {
    const rawData = ctx.getImageData(0, 0, width, height)
    const liquidData = liquidify(
      rawData,
      tk.effectLiquidifyRadius,
      tk.effectLiquidifyThreshold ?? 128,
      lightColorHex,
      darkColorHex,
    )
    ctx.putImageData(liquidData, 0, 0)
  }

  // Output to final canvas with scale
  outCanvas.width = width
  outCanvas.height = height
  const outCtx = outCanvas.getContext('2d')!
  outCtx.save()
  outCtx.fillStyle = invert ? darkColorHex : lightColorHex
  outCtx.fillRect(0, 0, width, height)

  const scale = tk.transformScale ?? 1
  if (scale !== 1) {
    outCtx.setTransform(scale, 0, 0, scale, (-(scale - 1) * width) / 2, (-(scale - 1) * height) / 2)
  }
  outCtx.drawImage(canvas, 0, 0)
  outCtx.restore()

  return {
    width,
    height,
    size: qr.size,
    version: qr.version,
    maskPattern: qr.maskPattern,
    ecc,
  }
}
