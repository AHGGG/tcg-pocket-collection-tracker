import { type Glyph, type GrayImage, glyphDistance, grayscale, segmentGlyphs } from './pixels'
import type { QuantityReading } from './types'

interface Template {
  character: string
  glyph: Glyph
}

export function parseReading(text: string, score: number): QuantityReading {
  if (!/^\d{1,8}\+?$/.test(text)) {
    return { kind: 'unknown', reason: 'The quantity strip was not an exact number.' }
  }
  const value = Number(text.replace('+', ''))
  return text.endsWith('+') ? { kind: 'at-least', value, score } : { kind: 'exact', value, score }
}

export class QuantityReader {
  private templates: Template[] = []

  constructor() {
    const canvas = document.createElement('canvas')
    canvas.width = 80
    canvas.height = 80
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      throw new Error('Canvas is unavailable.')
    }
    // Generic starting templates, not a claim of accuracy on an untested game font.
    for (const family of ['Arial', 'Roboto', 'sans-serif', 'system-ui']) {
      for (const weight of [400, 600, 800]) {
        for (const size of [24, 36, 48]) {
          for (const character of '0123456789+') {
            context.fillStyle = '#fff'
            context.fillRect(0, 0, 80, 80)
            context.fillStyle = '#000'
            context.font = `${weight} ${size}px ${family}`
            context.textBaseline = 'top'
            context.fillText(character, 8, 8)
            const glyphs = segmentGlyphs(grayscale(context.getImageData(0, 0, 80, 80).data, 80, 80), 'dark')
            if (glyphs.length === 1) {
              this.templates.push({ character, glyph: glyphs[0] })
            }
          }
        }
      }
    }
  }

  learn(image: GrayImage, text: string, polarity: 'dark' | 'light' | 'auto'): void {
    if (!/^\d{1,8}\+?$/.test(text)) {
      throw new Error('Teach a visible number such as 3 or 12, with an optional trailing +.')
    }
    const options = polarity === 'auto' ? (['dark', 'light'] as const) : [polarity]
    const choices = options.map((option) => segmentGlyphs(image, option)).filter((glyphs) => glyphs.length === text.length)
    if (choices.length !== 1) {
      throw new Error('Cannot separate the example digits. Tighten the quantity crop or choose dark/light text explicitly.')
    }
    for (const [index, glyph] of choices[0].entries()) {
      this.templates.push({ character: text[index], glyph })
    }
  }

  read(image: GrayImage, polarity: 'dark' | 'light' | 'auto'): QuantityReading {
    const options = polarity === 'auto' ? (['dark', 'light'] as const) : [polarity]
    const readings = options.map((option) => this.readOne(image, option)).filter((reading) => reading.kind !== 'unknown')
    if (readings.length === 0) {
      return { kind: 'unknown', reason: 'Digits are absent, clipped, too small or ambiguous. Check the quantity crop.' }
    }
    const first = readings[0]
    if (readings.some((reading) => reading.kind !== first.kind || reading.value !== first.value)) {
      return { kind: 'unknown', reason: 'Dark and light text interpretations disagree.' }
    }
    return first
  }

  private readOne(image: GrayImage, polarity: 'dark' | 'light'): QuantityReading {
    const glyphs = segmentGlyphs(image, polarity)
    if (!glyphs.length) {
      return { kind: 'unknown', reason: 'No readable digits.' }
    }
    let text = ''
    let score = 1
    for (const glyph of glyphs) {
      const bestByCharacter = new Map<string, number>()
      for (const template of this.templates) {
        const distance = glyphDistance(glyph, template.glyph)
        bestByCharacter.set(template.character, Math.min(bestByCharacter.get(template.character) ?? 1, distance))
      }
      const matches = [...bestByCharacter].sort((a, b) => a[1] - b[1])
      const [best, runnerUp] = matches
      // Heuristic distances, deliberately NOT probabilities. Every export is reviewed.
      if (!best || !runnerUp || best[1] > 0.2 || runnerUp[1] - best[1] < 0.018) {
        return { kind: 'unknown', reason: 'Ambiguous digit shapes.' }
      }
      text += best[0]
      score = Math.min(score, 1 - best[1])
    }
    return parseReading(text, score)
  }
}
