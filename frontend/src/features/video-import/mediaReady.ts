/** A compositor notification is useful, but is not proof that a seek completed.
 * In particular, paused/hidden videos may complete a seek without another rVFC.
 * Wait for decoded media state first, then allow a bounded rendering opportunity.
 */
export function waitForDecodedMedia({
  video,
  start,
  ready,
  description,
  signals = [],
  timeoutMs = 15_000,
}: {
  video: HTMLVideoElement
  start: () => void
  ready: () => boolean
  description: string
  signals?: readonly (AbortSignal | undefined)[]
  timeoutMs?: number
}): Promise<void> {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  const canceled = () => new DOMException('Scan canceled. No collection changes were made.', 'AbortError')
  if (activeSignals.some((signal) => signal.aborted)) {
    return Promise.reject(canceled())
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let started = false
    let frameCallback: number | undefined
    let paintCallback: number | undefined
    let paintTimer: ReturnType<typeof setTimeout> | undefined
    const events = ['loadeddata', 'canplay', 'seeked', 'timeupdate']
    const cancelPaint = () => {
      if (paintCallback !== undefined) {
        cancelAnimationFrame(paintCallback)
        paintCallback = undefined
      }
      clearTimeout(paintTimer)
      paintTimer = undefined
    }
    const cleanup = () => {
      clearTimeout(timeout)
      clearInterval(poll)
      cancelPaint()
      if (frameCallback !== undefined) {
        video.cancelVideoFrameCallback(frameCallback)
      }
      for (const event of events) {
        video.removeEventListener(event, check)
      }
      video.removeEventListener('error', failed)
      for (const signal of activeSignals) {
        signal.removeEventListener('abort', aborted)
      }
    }
    const finish = (error?: Error) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const failed = () => finish(new Error(`This browser could not decode the video (media error ${video.error?.code ?? 'unknown'}).`))
    const aborted = () => finish(canceled())
    const afterPaint = () => {
      // This timer is a compositor fallback, NEVER a decode timeout bypass.
      // Do not accept pixels if the decoder is still seeking or has no frame.
      cancelPaint()
      if (video.error) {
        failed()
      } else if (ready()) {
        finish()
      }
    }
    function check() {
      if (settled || !started) {
        return
      }
      if (video.error) {
        failed()
      } else if (!ready()) {
        cancelPaint()
      } else if (paintTimer === undefined) {
        // Always settle rendering after decoded readiness, even if an early
        // rVFC already fired: it can precede canvas-readable first-frame pixels.
        // Timers still work when hidden tabs suspend rendering callbacks.
        paintTimer = setTimeout(afterPaint, 100)
        if (typeof requestAnimationFrame === 'function') {
          paintCallback = requestAnimationFrame(() => {
            paintCallback = requestAnimationFrame(afterPaint)
          })
        }
      }
    }
    const timeout = setTimeout(() => {
      finish(
        new Error(
          `Video decoding did not finish ${description} (time=${video.currentTime.toFixed(3)}s, readyState=${video.readyState}, seeking=${video.seeking}). No collection changes were applied.`,
        ),
      )
    }, timeoutMs)
    // Check state too: a coalesced/missed seeked event must not strand the scan.
    const poll = setInterval(check, 50)
    for (const event of events) {
      video.addEventListener(event, check)
    }
    video.addEventListener('error', failed)
    for (const signal of activeSignals) {
      signal.addEventListener('abort', aborted, { once: true })
    }
    try {
      // Register BEFORE starting the load/seek, not after the frame may be ready.
      if (typeof video.requestVideoFrameCallback === 'function') {
        frameCallback = video.requestVideoFrameCallback(() => {
          check()
        })
      }
      start()
      started = true
      check()
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
