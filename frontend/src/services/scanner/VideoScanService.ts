import type { GraphModel } from '@tensorflow/tfjs'
import { readAutomaticQuantity } from '@/features/video-import/autoQuantity'
import { contains } from '@/features/video-import/geometry'
import { QuantityReader } from '@/features/video-import/quantity'
import { ObservationStore } from '@/features/video-import/reconcile'
import { scanFrames, type VideoScanProgress } from '@/features/video-import/scanFrames'
import type { ReviewGroup } from '@/features/video-import/types'
import { cropCanvas, throwIfAborted } from '@/features/video-import/video'
import { getCardByInternalId } from '@/lib/CardsDB'
import { calculatePerceptualHash, calculateSimilarity, type Hashes, imageToBuffers } from '@/lib/hash'
import { getLocalizedImagePath } from '@/lib/imageLocales'
import { detectCanvasFrame, type ExtractedCard, loadModel } from './CardDetectionService'

export interface VideoScanResult {
  cards: ExtractedCard[]
  groups: ReviewGroup[]
  sampled: number
  duration: number
}

/** The same detector and catalogue as image scanning; no crop or digit calibration. */
export async function scanVideo(
  file: File,
  model: GraphModel,
  hashes: Hashes,
  language: string,
  signal: AbortSignal,
  onProgress: (progress: VideoScanProgress) => void,
): Promise<VideoScanResult> {
  throwIfAborted(signal)
  const references = Object.entries(hashes)
    .map(([id, hash]) => ({ card: getCardByInternalId(Number(id)), hash }))
    .filter((reference) => reference.card !== undefined)
  if (references.length < 2) {
    throw new Error('Card recognition assets are not available. Reload and try again.')
  }
  const reader = new QuantityReader()
  const observations = new ObservationStore()
  let frameIndex = 0
  const result = await scanFrames(
    file,
    async (frame, frameSignal): Promise<ExtractedCard[]> => {
      const timestamp = frameIndex++ * 0.5
      const detections = await detectCanvasFrame(model, frame)
      throwIfAborted(frameSignal)
      const matches: ExtractedCard[] = []
      for (const detection of detections) {
        if (detection.confidence < 50) {
          continue
        }
        const [[x1, y1], , [x2, y2]] = detection.points
        const box = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
        // A partly visible card is not a reliable match. The next frame may show it fully.
        if (box.width < 12 || box.height < 16 || !contains({ x: 0, y: 0, width: frame.width, height: frame.height }, box)) {
          continue
        }
        const crop = cropCanvas(frame, box)
        const hash = calculatePerceptualHash(await imageToBuffers(crop.toDataURL('image/png')))
        throwIfAborted(frameSignal)
        const ranked = references
          .map((reference) => ({ card: reference.card, similarity: calculateSimilarity(hash, reference.hash) }))
          .sort((a, b) => b.similarity - a.similarity)
        const [best, next] = ranked
        if (!best.card || best.similarity < 0.86 || best.similarity - next.similarity < 0.025) {
          continue
        }
        const quantity = readAutomaticQuantity(frame, box, reader)
        const imageUrl = cropCanvas(frame, box, 180).toDataURL('image/webp', 0.8)
        observations.add({
          key: `${timestamp}:${matches.length}`,
          timestamp,
          fingerprint: String(best.card.internal_id),
          internalId: best.card.internal_id,
          candidates: ranked
            .slice(0, 3)
            .filter((match) => match.card !== undefined)
            .map((match) => ({ internalId: match.card?.internal_id as number, similarity: match.similarity })),
          quantity: quantity.reading,
          cardImage: imageUrl,
          badgeImage: quantity.image,
        })
        matches.push({
          matchedCard: { card: best.card, similarity: best.similarity },
          imageUrl,
          resolvedImageUrl: getLocalizedImagePath(best.card, language),
          increment: 1,
        })
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        throwIfAborted(frameSignal)
      }
      return matches
    },
    (match) => ({ id: match.matchedCard.card.internal_id, score: match.matchedCard.similarity }),
    signal,
    onProgress,
  )
  if (!result.cards.length) {
    throw new Error('No cards could be matched. Try a clearer recording with larger, fully visible cards.')
  }
  return {
    ...result,
    // The legacy image field is not used for video updates: never turn sightings into copies.
    cards: result.cards.map(({ sample }) => ({ ...sample, increment: 0 })),
    groups: observations.values(),
  }
}

/** Standalone entry loads only local static assets, with no tracker session or backend. */
export async function scanVideoFile(file: File, signal: AbortSignal, onProgress: (progress: VideoScanProgress) => void): Promise<VideoScanResult> {
  const base = import.meta.env.BASE_URL
  const response = await fetch(`${base}hashes/en-US/hashes.json`, { signal, credentials: 'omit', redirect: 'error' })
  if (!response.ok) {
    throw new Error(`Cannot load card recognition assets (${response.status}).`)
  }
  const data: unknown = await response.json()
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Invalid reference catalogue.')
  }
  const hashes: Hashes = {}
  for (const [id, value] of Object.entries(data)) {
    if (typeof value !== 'string') {
      throw new Error('Invalid reference hash.')
    }
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
    if (bytes.length !== 24) {
      throw new Error('Reference hash dimensions changed. Update the scanner.')
    }
    hashes[id] = bytes.buffer
  }
  throwIfAborted(signal)
  const model = await loadModel(`${base}model/model.json`, { signal, credentials: 'omit' })
  try {
    return await scanVideo(file, model, hashes, 'en-US', signal, onProgress)
  } finally {
    model.dispose()
  }
}
