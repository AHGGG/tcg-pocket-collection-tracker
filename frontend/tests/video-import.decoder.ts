import { openRecording } from '../src/features/video-import/video'

type Check = (name: string, work: () => void | Promise<void>) => Promise<void>
type Assert = (condition: unknown, message: string) => void

/** Real native decoding with fault-injected presentation callbacks. No user media. */
export async function checkDecoderRegressions(check: Check, assert: Assert, file: File) {
  const checkPixel = (frame: HTMLCanvasElement, timestamp: number) => {
    const pixel = frame.getContext('2d')?.getImageData(10, 10, 1, 1).data
    const red = timestamp < 1
    assert(pixel && pixel[red ? 0 : 2] > 200 && pixel[red ? 2 : 0] < 40, `Wrong decoded pixels at ${timestamp}s: ${pixel}`)
  }
  const times = [0, 0.005, 0.25, 0.251, 0.95, 1, 1.005, 1.5, 1.5, 1.999, 0.25, 0, 1.5]
  const sample = async () => {
    const recording = await openRecording(file)
    try {
      for (const time of times) {
        checkPixel(await recording.frame(time), time)
      }
    } finally {
      recording.dispose()
    }
  }
  await check('repeated cold opens return opaque first frames and correct forward/backward pixels', async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const recording = await openRecording(file)
      try {
        for (const time of [0, 1.5, 0, 0.25]) {
          checkPixel(await recording.frame(time), time)
        }
      } finally {
        recording.dispose()
      }
    }
  })
  await check('dropped display callbacks cannot turn successful seeks into timeouts', async () => {
    const original = HTMLVideoElement.prototype.requestVideoFrameCallback
    HTMLVideoElement.prototype.requestVideoFrameCallback = function () {
      return original.call(this, () => {})
    }
    try {
      await sample()
    } finally {
      HTMLVideoElement.prototype.requestVideoFrameCallback = original
    }
  })
  await check('native decoding works when requestVideoFrameCallback is unavailable', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'requestVideoFrameCallback')
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', { configurable: true, value: undefined })
    try {
      await sample()
    } finally {
      if (descriptor) {
        Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', descriptor)
      }
    }
  })
  await check('suspended video AND animation callbacks still produce decoded—not stale—pixels', async () => {
    const requestVideo = HTMLVideoElement.prototype.requestVideoFrameCallback
    const requestPaint = window.requestAnimationFrame
    const cancelPaint = window.cancelAnimationFrame
    let handle = 0
    HTMLVideoElement.prototype.requestVideoFrameCallback = function () {
      return requestVideo.call(this, () => {})
    }
    window.requestAnimationFrame = () => ++handle
    window.cancelAnimationFrame = () => {}
    try {
      await sample()
    } finally {
      HTMLVideoElement.prototype.requestVideoFrameCallback = requestVideo
      window.requestAnimationFrame = requestPaint
      window.cancelAnimationFrame = cancelPaint
    }
  })
  await check('concurrent seeks are rejected without corrupting the in-flight frame', async () => {
    const recording = await openRecording(file)
    try {
      const first = recording.frame(1.5)
      let rejected = false
      try {
        await recording.frame(0.25)
      } catch (error) {
        rejected = error instanceof Error && error.message.includes('sequentially')
      }
      assert(rejected, 'two seeks raced on the same video element')
      checkPixel(await first, 1.5)
      checkPixel(await recording.frame(0.25), 0.25)
    } finally {
      recording.dispose()
    }
  })
  await check('disposing a recording immediately cancels a pending seek', async () => {
    const recording = await openRecording(file)
    const pending = recording.frame(1.5)
    recording.dispose()
    let aborted = false
    try {
      await pending
    } catch (error) {
      aborted = error instanceof DOMException && error.name === 'AbortError'
    }
    assert(aborted, 'disposing left the seek pending or returned a frame')
    recording.dispose()
  })
  await check('cancel mid-seek then retry in the same recording returns the requested frame', async () => {
    const recording = await openRecording(file)
    const controller = new AbortController()
    try {
      const pending = recording.frame(1.5, controller.signal)
      controller.abort()
      let aborted = false
      try {
        await pending
      } catch (error) {
        aborted = error instanceof DOMException && error.name === 'AbortError'
      }
      assert(aborted, 'seek did not honor cancellation')
      checkPixel(await recording.frame(0.25), 0.25)
      checkPixel(await recording.frame(1.5), 1.5)
    } finally {
      recording.dispose()
    }
  })
}
