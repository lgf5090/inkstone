export interface Quadrilateral {
  topLeftX: number
  topLeftY: number
  topRightX: number
  topRightY: number
  bottomRightX: number
  bottomRightY: number
  bottomLeftX: number
  bottomLeftY: number
}

export class PerspectiveTransformer {
  private ctxd: CanvasRenderingContext2D
  private cvso: HTMLCanvasElement
  private ctxt: CanvasRenderingContext2D

  constructor(ctxd: CanvasRenderingContext2D, target: ImageData) {
    this.ctxd = ctxd

    const cvso = document.createElement('canvas')
    cvso.width = Math.round(target.width)
    cvso.height = Math.round(target.height)
    const ctxo = cvso.getContext('2d')!
    ctxo.putImageData(target, 0, 0)

    const cvst = document.createElement('canvas')
    cvst.width = ctxd.canvas.width
    cvst.height = ctxd.canvas.height
    const ctxt = cvst.getContext('2d')!

    this.cvso = cvso
    this.ctxt = ctxt
  }

  draw(q: Quadrilateral): void {
    const {
      topLeftX,
      topLeftY,
      topRightX,
      topRightY,
      bottomRightX,
      bottomRightY,
      bottomLeftX,
      bottomLeftY,
    } = q

    const dims = [
      Math.hypot(topLeftX - topRightX, topLeftY - topRightY),
      Math.hypot(topRightX - bottomRightX, topRightY - bottomRightY),
      Math.hypot(bottomRightX - bottomLeftX, bottomRightY - bottomLeftY),
      Math.hypot(bottomLeftX - topLeftX, bottomLeftY - topLeftY),
    ]

    const ow = this.cvso.width
    const oh = this.cvso.height
    let baseIndex = 0
    let maxScaleRate = 0
    let zeroNum = 0

    for (let i = 0; i < 4; i++) {
      let r = 0
      if (i % 2 === 0) {
        r = dims[i] / ow
      } else {
        r = dims[i] / oh
      }
      if (r > maxScaleRate) {
        maxScaleRate = r
        baseIndex = i
      }
      if (dims[i] === 0) {
        zeroNum++
      }
    }

    if (zeroNum > 1) return

    let step = 2
    if (maxScaleRate < 1) {
      step = 4
    }

    const ctxt = this.ctxt
    ctxt.clearRect(0, 0, ctxt.canvas.width, ctxt.canvas.height)

    if (baseIndex % 2 === 0) {
      const isTopBase = baseIndex === 0
      const subSegments = Math.max(2, Math.floor(oh / step))
      for (let i = 0; i < subSegments; i++) {
        const sy1 = (i * oh) / subSegments
        const sy2 = ((i + 1) * oh) / subSegments
        const t1 = i / subSegments
        const t2 = (i + 1) / subSegments

        const x1l = topLeftX + (bottomLeftX - topLeftX) * t1
        const y1l = topLeftY + (bottomLeftY - topLeftY) * t1
        const x1r = topRightX + (bottomRightX - topRightX) * t1
        const y1r = topRightY + (bottomRightY - topRightY) * t1

        const x2l = topLeftX + (bottomLeftX - topLeftX) * t2
        const y2l = topLeftY + (bottomLeftY - topLeftY) * t2
        const x2r = topRightX + (bottomRightX - topRightX) * t2
        const y2r = topRightY + (bottomRightY - topRightY) * t2

        ctxt.save()
        ctxt.beginPath()
        ctxt.moveTo(x1l, y1l)
        ctxt.lineTo(x1r, y1r)
        ctxt.lineTo(x2r, y2r)
        ctxt.lineTo(x2l, y2l)
        ctxt.closePath()
        ctxt.clip()

        const dx = (x1r + x2r) / 2 - (x1l + x2l) / 2
        const dy = (y1r + y2r) / 2 - (y1l + y2l) / 2
        const angle = Math.atan2(dy, dx)
        const dist = Math.hypot(dx, dy)
        const scaleX = dist / ow
        const scaleY = Math.max(0.001, (t2 - t1) * (isTopBase ? 1 : 1))

        ctxt.translate((x1l + x2l) / 2, (y1l + y2l) / 2)
        ctxt.rotate(angle)
        ctxt.scale(scaleX, scaleY)
        ctxt.drawImage(this.cvso, 0, sy1, ow, sy2 - sy1, 0, 0, ow, sy2 - sy1)
        ctxt.restore()
      }
    } else {
      const subSegments = Math.max(2, Math.floor(ow / step))
      for (let i = 0; i < subSegments; i++) {
        const sx1 = (i * ow) / subSegments
        const sx2 = ((i + 1) * ow) / subSegments
        const t1 = i / subSegments
        const t2 = (i + 1) / subSegments

        const x1t = topLeftX + (topRightX - topLeftX) * t1
        const y1t = topLeftY + (topRightY - topLeftY) * t1
        const x1b = bottomLeftX + (bottomRightX - bottomLeftX) * t1
        const y1b = bottomLeftY + (bottomRightY - bottomLeftY) * t1

        const x2t = topLeftX + (topRightX - topLeftX) * t2
        const y2t = topLeftY + (topRightY - topLeftY) * t2
        const x2b = bottomLeftX + (bottomRightX - bottomLeftX) * t2
        const y2b = bottomLeftY + (bottomRightY - bottomLeftY) * t2

        ctxt.save()
        ctxt.beginPath()
        ctxt.moveTo(x1t, y1t)
        ctxt.lineTo(x2t, y2t)
        ctxt.lineTo(x2b, y2b)
        ctxt.lineTo(x1b, y1b)
        ctxt.closePath()
        ctxt.clip()

        const dx = (x1b + x2b) / 2 - (x1t + x2t) / 2
        const dy = (y1b + y2b) / 2 - (y1t + y2t) / 2
        const angle = Math.atan2(dy, dx) - Math.PI / 2
        const dist = Math.hypot(dx, dy)
        const scaleY = dist / oh
        const scaleX = Math.max(0.001, t2 - t1)

        ctxt.translate((x1t + x2t) / 2, (y1t + y2t) / 2)
        ctxt.rotate(angle)
        ctxt.scale(scaleX, scaleY)
        ctxt.drawImage(this.cvso, sx1, 0, sx2 - sx1, oh, 0, 0, sx2 - sx1, oh)
        ctxt.restore()
      }
    }

    this.ctxd.drawImage(this.ctxt.canvas, 0, 0)
  }
}
