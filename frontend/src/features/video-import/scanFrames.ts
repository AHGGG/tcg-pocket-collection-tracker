import { FrameCounts } from './frameCounts'
import { openRecording, throwIfAborted } from './video'

export const VIDEO_SAMPLE_SECONDS = 0.5

export interface VideoScanProgress {
  fraction: number
  sampled: number
  total: number
}

/** Decode and recognize sequentially: one live full-size frame, bounded evidence. */
export async function scanFrames<T>(
  file: File,
  recognize: (frame: HTMLCanvasElement, signal: AbortSignal) => Promise<readonly T[]>,
  identify: (match: T) => { id: number; score: number },
  signal: AbortSignal,
  onProgress: (progress: VideoScanProgress) => void,
): Promise<{ cards: { sample: T; count: number }[]; sampled: number; duration: number }> {
  throwIfAborted(signal)
  const recording = await openRecording(file, signal)
  try {
    const counts = new FrameCounts(identify)
    const total = Math.ceil(recording.duration / VIDEO_SAMPLE_SECONDS)
    onProgress({ fraction: 0, sampled: 0, total })
    for (let index = 0; index < total; index++) {
      throwIfAborted(signal)
      const frame = await recording.frame(index * VIDEO_SAMPLE_SECONDS, signal)
      const matches = await recognize(frame, signal)
      throwIfAborted(signal)
      counts.add(index, matches)
      onProgress({ fraction: (index + 1) / total, sampled: index + 1, total })
      // Keep Cancel, progress and browser rendering responsive between samples.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }
    throwIfAborted(signal)
    return { cards: counts.values(), sampled: total, duration: recording.duration }
  } finally {
    recording.dispose()
  }
}
