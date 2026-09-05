export interface GrayImage {
  width: number
  height: number
  pixels: Uint8Array
}

export interface Glyph {
  aspect: number
  pixels: Float32Array
}

export function grayscale(data: ArrayLike<number>, width: number, height: number): GrayImage {
  if (data.length !== width * height * 4 || width <= 0 || height <= 0) {
    throw new Error('Invalid RGBA image dimensions.')
  }
  const pixels = new Uint8Array(width * height)
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = Math.round(data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114)
  }
  return { width, height, pixels }
}

export function frameDifference(a: GrayImage, b: GrayImage): number {
  if (a.width !== b.width || a.height !== b.height) {
    return Number.POSITIVE_INFINITY
  }
  let sum = 0
  for (let i = 0; i < a.pixels.length; i++) {
    sum += Math.abs(a.pixels[i] - b.pixels[i])
  }
  return sum / a.pixels.length
}

export function sharpness(image: GrayImage): number {
  const { width, height, pixels } = image
  let total = 0
  let count = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      total += Math.abs(4 * pixels[i] - pixels[i - 1] - pixels[i + 1] - pixels[i - width] - pixels[i + width])
      count++
    }
  }
  return count ? total / count : 0
}

function otsu(pixels: Uint8Array): number | null {
  const histogram = new Array<number>(256).fill(0)
  let sum = 0
  let min = 255
  let max = 0
  for (const value of pixels) {
    histogram[value]++
    sum += value
    min = Math.min(min, value)
    max = Math.max(max, value)
  }
  if (max - min < 30) {
    return null
  }
  let lowerCount = 0
  let lowerSum = 0
  let best = -1
  let threshold = min
  for (let i = min; i < max; i++) {
    lowerCount += histogram[i]
    lowerSum += i * histogram[i]
    const upperCount = pixels.length - lowerCount
    if (!lowerCount || !upperCount) {
      continue
    }
    const difference = lowerSum / lowerCount - (sum - lowerSum) / upperCount
    const variance = lowerCount * upperCount * difference * difference
    if (variance > best) {
      best = variance
      threshold = i
    }
  }
  return threshold
}

/** Segments only the calibrated digit strip, not names or whole screenshots. */
export function segmentGlyphs(image: GrayImage, polarity: 'dark' | 'light'): Glyph[] {
  const threshold = otsu(image.pixels)
  if (threshold === null) {
    return []
  }
  const { width, height, pixels } = image
  const mask = pixels.map((value) => Number(polarity === 'dark' ? value <= threshold : value > threshold))
  const visited = new Uint8Array(mask.length)
  const components: { x: number; y: number; right: number; bottom: number; area: number }[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) {
      continue
    }
    const stack = [start]
    visited[start] = 1
    let x = width
    let y = height
    let right = 0
    let bottom = 0
    let area = 0
    while (stack.length) {
      const index = stack.pop() as number
      const px = index % width
      const py = Math.floor(index / width)
      x = Math.min(x, px)
      y = Math.min(y, py)
      right = Math.max(right, px)
      bottom = Math.max(bottom, py)
      area++
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx
          const ny = py + dy
          const next = ny * width + nx
          if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[next] && !visited[next]) {
            visited[next] = 1
            stack.push(next)
          }
        }
      }
    }
    if (area >= Math.max(3, height * 0.1)) {
      components.push({ x, y, right, bottom, area })
    }
  }
  if (!components.length) {
    return []
  }
  const tallest = Math.max(...components.map((component) => component.bottom - component.y + 1))
  const useful = components.filter((component) => component.bottom - component.y + 1 >= tallest * 0.45).sort((a, b) => a.x - b.x)
  if (useful.length > 9) {
    return []
  }
  const result: Glyph[] = []
  for (const component of useful) {
    const w = component.right - component.x + 1
    const h = component.bottom - component.y + 1
    // A digit clipped by the calibrated strip can resemble another digit. Reject all edge-touching glyphs.
    if (h < 4 || w / h > 1.3 || component.x === 0 || component.y === 0 || component.right === width - 1 || component.bottom === height - 1) {
      return []
    }
    const normalized = new Float32Array(16 * 24)
    for (let gy = 0; gy < 24; gy++) {
      for (let gx = 0; gx < 16; gx++) {
        // Area sampling is less sensitive to the recorded pixel size than nearest-neighbor.
        let sum = 0
        let samples = 0
        const x0 = Math.floor((gx * w) / 16)
        const x1 = Math.max(x0 + 1, Math.ceil(((gx + 1) * w) / 16))
        const y0 = Math.floor((gy * h) / 24)
        const y1 = Math.max(y0 + 1, Math.ceil(((gy + 1) * h) / 24))
        for (let py = y0; py < Math.min(h, y1); py++) {
          for (let px = x0; px < Math.min(w, x1); px++) {
            sum += mask[(component.y + py) * width + component.x + px]
            samples++
          }
        }
        normalized[gy * 16 + gx] = sum / samples
      }
    }
    result.push({ aspect: w / h, pixels: normalized })
  }
  return result
}

export function glyphDistance(a: Glyph, b: Glyph): number {
  let difference = 0
  for (let i = 0; i < a.pixels.length; i++) {
    difference += Math.abs(a.pixels[i] - b.pixels[i])
  }
  return (difference / a.pixels.length) * 0.8 + Math.min(1, Math.abs(a.aspect - b.aspect)) * 0.2
}
