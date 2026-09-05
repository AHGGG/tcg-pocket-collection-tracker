import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForDecodedMedia } from '../../frontend/src/features/video-import/mediaReady'

class MediaStub extends EventTarget {
  currentTime = 0
  readyState = 1
  seeking = true
  error: { code: number } | null = null
  private nextId = 1
  callbacks = new Map<number, () => void>()
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (listener) {
      const registered = this.listeners.get(type) ?? new Set()
      registered.add(listener)
      this.listeners.set(type, registered)
    }
    super.addEventListener(type, listener, options)
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (listener) {
      this.listeners.get(type)?.delete(listener)
    }
    super.removeEventListener(type, listener, options)
  }

  requestVideoFrameCallback(callback: () => void) {
    const id = this.nextId++
    this.callbacks.set(id, callback)
    return id
  }

  cancelVideoFrameCallback(id: number) {
    this.callbacks.delete(id)
  }

  present() {
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const callback of callbacks) {
      callback()
    }
  }

  decoded(emitEvent = true) {
    this.currentTime = 0.5
    this.readyState = 4
    this.seeking = false
    if (emitEvent) {
      this.dispatchEvent(new Event('seeked'))
    }
  }

  assertClean() {
    assert.equal(this.callbacks.size, 0, 'pending frame callbacks were not canceled')
    assert.equal([...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0, 'media listeners were not removed')
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const wait = (video: MediaStub, start: () => void, signals: AbortSignal[] = [], timeoutMs = 1_000) =>
  waitForDecodedMedia({
    video: video as unknown as HTMLVideoElement,
    start,
    ready: () => video.readyState >= 2 && !video.seeking && video.currentTime === 0.5,
    description: 'seeking to 0.500s',
    signals,
    timeoutMs,
  })

test('seeked without a compositor callback completes from decoded state', async () => {
  const video = new MediaStub()
  await wait(video, () => video.decoded())
  video.assertClean()
})

test('missing seeked and display callbacks recover by checking media state', async () => {
  const video = new MediaStub()
  await wait(video, () => {
    setTimeout(() => video.decoded(false), 10)
  })
  video.assertClean()
})

test('display callback arriving before seek completion cannot release a stale frame', async () => {
  const video = new MediaStub()
  let resolved = false
  const work = wait(video, () => video.present()).then(() => {
    resolved = true
  })
  await pause(25)
  assert.equal(resolved, false)
  video.decoded()
  await work
  video.assertClean()
})

test('callback registration precedes even a synchronous seek completion', async () => {
  const video = new MediaStub()
  await wait(video, () => {
    assert.equal(video.callbacks.size, 1)
    video.decoded()
    video.present()
  })
  video.assertClean()
})

test('a genuine decoder stall still times out with accurate diagnostic state', async () => {
  const video = new MediaStub()
  await assert.rejects(
    wait(video, () => video.present(), [], 150),
    /seeking to 0.500s.*readyState=1, seeking=true/,
  )
  video.assertClean()
})

test('a stale seeked event does not bypass the readiness predicate', async () => {
  const video = new MediaStub()
  await assert.rejects(
    wait(video, () => video.dispatchEvent(new Event('seeked')), [], 150),
    /Video decoding did not finish/,
  )
  video.assertClean()
})

test('state becoming unready during the display fallback cannot resolve', async () => {
  const video = new MediaStub()
  await assert.rejects(
    wait(
      video,
      () => {
        video.decoded()
        setTimeout(() => {
          video.readyState = 1
          video.seeking = true
        }, 5)
      },
      [],
      180,
    ),
    /readyState=1, seeking=true/,
  )
  video.assertClean()
})

test('abort before starting avoids media operations', async () => {
  const video = new MediaStub()
  const controller = new AbortController()
  controller.abort()
  let started = false
  await assert.rejects(
    wait(video, () => {
      started = true
    }, [controller.signal]),
    { name: 'AbortError' },
  )
  assert.equal(started, false)
  video.assertClean()
})

test('cancel during decoding removes callback and event waiters', async () => {
  const video = new MediaStub()
  const controller = new AbortController()
  const work = wait(video, () => {}, [controller.signal])
  controller.abort()
  await assert.rejects(work, { name: 'AbortError' })
  video.assertClean()
})

test('lifetime cancellation interrupts the bounded display fallback too', async () => {
  const video = new MediaStub()
  const lifetime = new AbortController()
  const user = new AbortController()
  const work = wait(video, () => video.decoded(), [user.signal, lifetime.signal])
  lifetime.abort()
  await assert.rejects(work, { name: 'AbortError' })
  video.assertClean()
})

test('media errors are distinct from display notification timeouts', async () => {
  const video = new MediaStub()
  await assert.rejects(
    wait(video, () => {
      video.error = { code: 3 }
      video.dispatchEvent(new Event('error'))
    }),
    /could not decode.*media error 3/,
  )
  video.assertClean()
})

test('synchronous load/seek exceptions do not leak resources', async () => {
  const video = new MediaStub()
  await assert.rejects(
    wait(video, () => {
      throw new Error('synthetic seek failure')
    }),
    /synthetic seek failure/,
  )
  video.assertClean()
})
