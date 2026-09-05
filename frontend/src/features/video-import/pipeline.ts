import { allCards } from '@/lib/CardsDB'
import { calculatePerceptualHash, calculateSimilarity, type Hashes, imageToBuffers } from '@/lib/hash'
import { detectCanvasFrame, loadModel } from '@/services/scanner/CardDetectionService'
import { badgeRect, contains, makeProfile, toPixels, validateProfile } from './geometry'
import { frameDifference, type GrayImage, sharpness } from './pixels'
import { QuantityReader } from './quantity'
import { ObservationStore } from './reconcile'
import type { Candidate, LayoutProfile, Rect, ReviewGroup, ScanStats } from './types'
import { cropCanvas, grayCanvas, openRecording, throwIfAborted } from './video'

export interface ScanOptions {
  file: File
  profile: LayoutProfile
  calibrationTime: number
  exampleQuantity: string
  interval: number
  expansion: string
  signal: AbortSignal
  onProgress: (progress: { fraction: number; message: string; stats: ScanStats }) => void
}

function intersectionOverUnion(a: Rect, b: Rect): number {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return intersection / (a.width * a.height + b.width * b.height - intersection)
}

function decodeHash(value: unknown): ArrayBuffer {
  if (typeof value !== 'string') {
    throw new Error('Invalid reference hash data.')
  }
  const decoded = atob(value)
  // hash.ts uses 189 bits, stored in six 32-bit words.
  if (decoded.length !== 24) {
    throw new Error('Reference hash dimensions changed. Update the importer before continuing.')
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0)).buffer
}

export async function scanRecording(options: ScanOptions): Promise<{ groups: ReviewGroup[]; stats: ScanStats; profile: LayoutProfile; duration: number }> {
  const { signal } = options
  throwIfAborted(signal)
  const profile = validateProfile(options.profile)
  if (![0.25, 0.5, 1].includes(options.interval)) {
    throw new Error('Unsupported sampling interval.')
  }
  const started = performance.now()
  const stats: ScanStats = {
    sampled: 0,
    recognized: 0,
    duplicateFrames: 0,
    blurryFrames: 0,
    clippedCards: 0,
    gapTimestamps: [],
    elapsedSeconds: 0,
  }
  const progress = (fraction: number, message: string) => {
    stats.elapsedSeconds = (performance.now() - started) / 1000
    options.onProgress({ fraction, message, stats: { ...stats, gapTimestamps: [...stats.gapTimestamps] } })
  }
  progress(0, 'Loading local recognition assets…')
  const base = import.meta.env.BASE_URL
  // Only static, same-origin asset GETs. No recording, crops or collection data are sent.
  const hashesResponse = await fetch(`${base}hashes/en-US/hashes.json`, { signal, credentials: 'omit', redirect: 'error' })
  if (!hashesResponse.ok) {
    throw new Error(`Cannot load reference hashes (${hashesResponse.status}). Check the static assets in this checkout.`)
  }
  const raw: unknown = await hashesResponse.json()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Invalid hash catalogue.')
  }
  const allowedIds = new Set(allCards.filter((card) => !options.expansion || card.expansion === options.expansion).map((card) => card.internal_id))
  const hashes: Hashes = {}
  for (const [key, value] of Object.entries(raw)) {
    if (allowedIds.has(Number(key))) {
      hashes[key] = decodeHash(value)
    }
  }
  const references = Object.entries(hashes).map(([key, hash]) => ({ internalId: Number(key), hash }))
  if (references.length < 2) {
    throw new Error('Not enough reference cards for this expansion. Update the scanner hashes.')
  }
  const model = await loadModel(`${base}model/model.json`, { signal, credentials: 'omit' })
  try {
    throwIfAborted(signal)
    const recording = await openRecording(options.file, signal)
    try {
      if (Math.abs(recording.width / recording.height / profile.frameAspect - 1) > 0.02) {
        throw new Error('Recording aspect ratio does not match this layout. Recalibrate it.')
      }
      const grid = toPixels(profile.grid, recording.width, recording.height)
      const findBoxes = async (frame: HTMLCanvasElement): Promise<Rect[]> => {
        const area = cropCanvas(frame, grid)
        const detections = await detectCanvasFrame(model, area)
        throwIfAborted(signal)
        return detections.filter((detection) => detection.confidence >= 50).map((detection) => {
          const [[x1, y1], , [x2, y2]] = detection.points
          return { x: x1 + grid.x, y: y1 + grid.y, width: x2 - x1, height: y2 - y1 }
        })
      }
      const calibrationFrame = await recording.frame(options.calibrationTime, signal)
      const expected = toPixels(profile.card, recording.width, recording.height)
      const anchors = (await findBoxes(calibrationFrame)).sort((a, b) => intersectionOverUnion(b, expected) - intersectionOverUnion(a, expected))
      if (!anchors[0] || intersectionOverUnion(anchors[0], expected) < 0.5 || !contains(grid, anchors[0])) {
        throw new Error('The detector cannot find your marked example card. Choose a clear, fully visible card and recalibrate.')
      }
      const anchor = anchors[0]
      const normalizedAnchor = { x: anchor.x / recording.width, y: anchor.y / recording.height, width: anchor.width / recording.width, height: anchor.height / recording.height }
      const originalBadge = badgeRect(profile.card, profile.badge)
      // Align quantity offsets with actual model bounds, rather than approximate mouse bounds.
      const effectiveProfile = makeProfile(profile.grid, normalizedAnchor, originalBadge, profile.frameAspect, profile.polarity)
      const quantityReader = new QuantityReader()
      if (options.exampleQuantity.trim()) {
        quantityReader.learn(grayCanvas(cropCanvas(calibrationFrame, toPixels(originalBadge, recording.width, recording.height))), options.exampleQuantity.trim(), profile.polarity)
      }
      const calibrationSharpness = sharpness(grayCanvas(cropCanvas(calibrationFrame, grid, 128)))
      const store = new ObservationStore()
      let previousFrame: GrayImage | null = null
      let previousIds = new Set<number>()
      const steps = Math.ceil(recording.duration / options.interval)
      for (let index = 0; index < steps; index++) {
        throwIfAborted(signal)
        const timestamp = index * options.interval
        const frame = await recording.frame(timestamp, signal)
        const gray = grayCanvas(cropCanvas(frame, grid, 128))
        stats.sampled++
        if (previousFrame && frameDifference(previousFrame, gray) < 1.2) {
          stats.duplicateFrames++
        } else if (sharpness(gray) < Math.max(2, calibrationSharpness * 0.3)) {
          stats.blurryFrames++
        } else {
          const boxes = await findBoxes(frame)
          const visibleIds = new Set<number>()
          for (const [boxIndex, box] of boxes.entries()) {
            throwIfAborted(signal)
            const quantityBox = badgeRect(box, effectiveProfile.badge)
            const ratio = box.width / box.height / (anchor.width / anchor.height)
            if (
              !contains(grid, box) || !contains(grid, quantityBox) || box.width < anchor.width * 0.6 ||
              box.width > anchor.width * 1.5 || ratio < 0.7 || ratio > 1.3 || quantityBox.height < 5 || quantityBox.width < 3
            ) {
              stats.clippedCards++
              continue
            }
            const cardCanvas = cropCanvas(frame, box)
            const hash = calculatePerceptualHash(await imageToBuffers(cardCanvas.toDataURL('image/png')))
            throwIfAborted(signal)
            const candidates: Candidate[] = references.map((reference) => ({
              internalId: reference.internalId,
              similarity: calculateSimilarity(hash, reference.hash),
            })).sort((a, b) => b.similarity - a.similarity).slice(0, 3)
            const [best, next] = candidates
            const internalId = best.similarity >= 0.86 && best.similarity - next.similarity >= 0.025 ? best.internalId : null
            if (internalId !== null) {
              visibleIds.add(internalId)
            }
            const quantityCanvas = cropCanvas(frame, quantityBox)
            const quantity = quantityReader.read(grayCanvas(quantityCanvas), profile.polarity)
            store.add({
              key: `${index}:${boxIndex}`,
              timestamp,
              fingerprint: [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join(''),
              candidates,
              internalId,
              quantity,
              cardImage: cropCanvas(frame, box, 160).toDataURL('image/webp', 0.75),
              badgeImage: cropCanvas(frame, quantityBox, 160).toDataURL('image/png'),
            })
            // Give cancellation and rendering a turn between expensive card matches.
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
          }
          if (previousIds.size && visibleIds.size && ![...visibleIds].some((id) => previousIds.has(id))) {
            stats.gapTimestamps.push(timestamp)
          }
          if (visibleIds.size) {
            previousIds = visibleIds
          }
          previousFrame = gray
          stats.recognized++
        }
        progress((index + 1) / steps, `Scanned ${timestamp.toFixed(1)} / ${recording.duration.toFixed(1)} seconds`)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
      throwIfAborted(signal)
      const groups = store.values()
      if (!groups.length) {
        throw new Error('No usable cards were found. Check the crop, zoom, recording language and pauses.')
      }
      progress(1, 'Recognition finished. Nothing has been applied; review the proposed quantities.')
      return { groups, stats, profile: effectiveProfile, duration: recording.duration }
    } finally {
      recording.dispose()
    }
  } finally {
    model.dispose()
  }
}
