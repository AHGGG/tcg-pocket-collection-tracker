import { contains } from './geometry'
import { grayscale } from './pixels'
import type { Rect } from './types'

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Import canceled. No collection changes were made.', 'AbortError')
  }
}

function waitForMedia(video: HTMLVideoElement, event: string, signal: AbortSignal | undefined, start: () => void): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      video.removeEventListener(event, done)
      video.removeEventListener('error', failed)
      signal?.removeEventListener('abort', aborted)
    }
    const done = () => {
      cleanup()
      resolve()
    }
    const failed = () => {
      cleanup()
      reject(new Error(`Video could not be decoded (media error ${video.error?.code ?? 'unknown'}). Try an H.264 MP4 recording.`))
    }
    const aborted = () => {
      cleanup()
      reject(new DOMException('Import canceled.', 'AbortError'))
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Video decoding timed out while waiting for ${event}. Try a shorter recording or a supported codec.`))
    }, 15_000)
    video.addEventListener(event, done, { once: true })
    video.addEventListener('error', failed, { once: true })
    signal?.addEventListener('abort', aborted, { once: true })
    try {
      start()
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
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
  const dispose = () => {
    if (!disposed) {
      disposed = true
      video.pause()
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
    }
  }
  try {
    await waitForMedia(video, 'loadeddata', signal, () => {
      video.src = url
      video.load()
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
        const target = Math.max(0, Math.min(time, Math.max(0, duration - 0.001)))
        if (Math.abs(video.currentTime - target) > 0.001 || video.seeking) {
          await waitForMedia(video, 'seeked', frameSignal, () => {
            video.currentTime = target
          })
        }
        if (video.readyState < 2) {
          await waitForMedia(video, 'loadeddata', frameSignal, () => {})
        }
        throwIfAborted(frameSignal)
        context.drawImage(video, 0, 0, width, height)
        return canvas
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
