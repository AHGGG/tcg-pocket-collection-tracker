import { contains } from './geometry'
import { waitForDecodedMedia } from './mediaReady'
import { grayscale } from './pixels'
import type { Rect } from './types'

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Import canceled. No collection changes were made.', 'AbortError')
  }
}

/** drawImage may still be a no-op during a browser's cold first-frame upload.
 * A pair of different sentinels detects a no-op without rejecting black or
 * transparent video. 'copy' also prevents pixels from a previous frame surviving.
 */
export function drawVideoPixels(context: CanvasRenderingContext2D, video: HTMLVideoElement): boolean {
  const { width, height } = context.canvas
  context.save()
  try {
    context.globalCompositeOperation = 'copy'
    for (const color of ['#132b47', '#e6c29a']) {
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const before = context.getImageData(0, 0, 1, 1).data
      context.drawImage(video, 0, 0, width, height)
      const after = context.getImageData(0, 0, 1, 1).data
      if (after.some((channel, index) => channel !== before[index])) {
        return true
      }
    }
    return false
  } finally {
    context.restore()
  }
}

export interface Recording {
  duration: number
  width: number
  height: number
  frame: (time: number, signal?: AbortSignal) => Promise<HTMLCanvasElement>
  dispose: () => void
}

export async function openRecording(file: File, signal?: AbortSignal): Promise<Recording> {
  throwIfAborted(signal)
  if (!file.size || file.size > 2_000_000_000) {
    throw new Error('Choose a non-empty recording smaller than 2 GB.')
  }
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true
  const url = URL.createObjectURL(file)
  let disposed = false
  let reading = false
  const lifetime = new AbortController()
  const dispose = () => {
    if (!disposed) {
      disposed = true
      lifetime.abort()
      video.pause()
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
    }
  }
  try {
    await waitForDecodedMedia({
      video,
      description: 'loading the first frame',
      signals: [signal, lifetime.signal],
      ready: () => video.readyState >= 2 && !video.seeking && video.videoWidth > 0 && video.videoHeight > 0,
      start: () => {
        video.src = url
        video.load()
      },
    })
    const { duration, videoWidth: width, videoHeight: height } = video
    if (!Number.isFinite(duration) || duration <= 0 || duration > 1800) {
      throw new Error('The recording must have a seekable duration of at most 30 minutes. Export a regular MP4 if duration metadata is missing.')
    }
    if (!width || !height || Math.max(width, height) > 4096) {
      throw new Error('Unsupported video dimensions. Use a recording at 4096 pixels per side or less.')
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      throw new Error('Canvas is unavailable.')
    }
    return {
      duration,
      width,
      height,
      async frame(time, frameSignal) {
        throwIfAborted(frameSignal)
        if (disposed || !Number.isFinite(time)) {
          throw new Error('Recording is closed or timestamp is invalid.')
        }
        if (reading) {
          throw new Error('A frame is already being decoded. Read recording frames sequentially.')
        }
        reading = true
        try {
          const target = Math.max(0, Math.min(time, Math.max(0, duration - 0.001)))
          if (Math.abs(video.currentTime - target) > 0.001 || video.seeking || video.readyState < 2) {
            await waitForDecodedMedia({
              video,
              description: `seeking to ${target.toFixed(3)}s`,
              signals: [frameSignal, lifetime.signal],
              ready: () => video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - target) <= 0.001,
              start: () => {
                video.currentTime = target
              },
            })
          }
          throwIfAborted(frameSignal)
          throwIfAborted(lifetime.signal)
          const deadline = performance.now() + 2000
          while (!drawVideoPixels(context, video)) {
            throwIfAborted(frameSignal)
            throwIfAborted(lifetime.signal)
            if (performance.now() >= deadline) {
              throw new Error(`Video pixels were not available at ${target.toFixed(3)}s. Retry the scan.`)
            }
            await waitForDecodedMedia({
              video,
              description: `reading pixels at ${target.toFixed(3)}s`,
              signals: [frameSignal, lifetime.signal],
              ready: () => video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - target) <= 0.001,
              start: () => {},
            })
          }
          throwIfAborted(frameSignal)
          throwIfAborted(lifetime.signal)
          return canvas
        } finally {
          reading = false
        }
      },
      dispose,
    }
  } catch (error) {
    dispose()
    throw error
  }
}

export function cropCanvas(source: HTMLCanvasElement, rect: Rect, maxWidth = Number.POSITIVE_INFINITY): HTMLCanvasElement {
  if (!contains({ x: 0, y: 0, width: source.width, height: source.height }, rect) || rect.width < 1 || rect.height < 1) {
    throw new Error('Crop is clipped or outside the decoded frame.')
  }
  const scale = Math.min(1, maxWidth / rect.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(rect.width * scale))
  canvas.height = Math.max(1, Math.round(rect.height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('Canvas is unavailable.')
  }
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, canvas.width, canvas.height)
  return canvas
}

export function grayCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('Canvas is unavailable.')
  }
  return grayscale(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
}
