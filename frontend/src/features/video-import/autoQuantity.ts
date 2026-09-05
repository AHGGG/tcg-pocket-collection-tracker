import { contains } from './geometry'
import type { GrayImage } from './pixels'
import type { QuantityReader } from './quantity'
import type { QuantityReading, Rect } from './types'
import { cropCanvas, grayCanvas } from './video'

/** Locate Pocket's slate quantity tab near the bottom-left of a detected card.
 * Geometry is relative to the detector, not a device resolution or user calibration.
 * An unfamiliar layout is unknown, never an inferred count of one.
 */
export function locateQuantityTab(image: GrayImage, colors: Uint8ClampedArray): Rect | null {
  const { width, height } = image
  const mask = new Uint8Array(width * height)
  for (let i = 0; i < mask.length; i++) {
    const [r, g, b] = colors.subarray(i * 4, i * 4 + 3)
    mask[i] = Number(r >= 35 && r <= 145 && g >= r - 8 && b >= r && b - r <= 65 && b <= 175)
  }
  const candidates: Rect[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start]) {
      continue
    }
    const stack = [start]
    mask[start] = 0
    let left = width,
      top = height,
      right = 0,
      bottom = 0,
      area = 0
    while (stack.length) {
      const i = stack.pop() as number
      const x = i % width,
        y = Math.floor(i / width)
      left = Math.min(left, x)
      right = Math.max(right, x)
      top = Math.min(top, y)
      bottom = Math.max(bottom, y)
      area++
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
          continue
        }
        const next = ny * width + nx
        if (mask[next]) {
          mask[next] = 0
          stack.push(next)
        }
      }
    }
    const w = right - left + 1,
      h = bottom - top + 1
    if (w >= width * 0.58 && h >= height * 0.18 && h <= height * 0.8 && area / (w * h) >= 0.65 && left <= width * 0.18 && top > 0 && bottom < height - 1) {
      candidates.push({ x: left + 1, y: top + 1, width: w * 0.9 - 2, height: h - 2 })
    }
  }
  return candidates.length === 1 ? candidates[0] : null
}

export function readAutomaticQuantity(frame: HTMLCanvasElement, card: Rect, reader: QuantityReader): { reading: QuantityReading; image: string } {
  const unknown: QuantityReading = { kind: 'unknown', reason: 'Owned quantity could not be read automatically.' }
  const area = { x: card.x, y: card.y + card.height * 0.81, width: card.width * 0.54, height: card.height * 0.25 }
  if (!contains({ x: 0, y: 0, width: frame.width, height: frame.height }, area)) {
    return { reading: unknown, image: '' }
  }
  const strip = cropCanvas(frame, area)
  const context = strip.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return { reading: unknown, image: '' }
  }
  const tab = locateQuantityTab(grayCanvas(strip), context.getImageData(0, 0, strip.width, strip.height).data)
  if (!tab || tab.width < 5 || tab.height < 5) {
    return { reading: unknown, image: strip.toDataURL('image/png') }
  }
  const crop = cropCanvas(strip, tab)
  return { reading: reader.read(grayCanvas(crop), 'light'), image: crop.toDataURL('image/png') }
}
