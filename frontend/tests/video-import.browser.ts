import { grayscale } from '../src/features/video-import/pixels'
import { QuantityReader } from '../src/features/video-import/quantity'
import { cropCanvas, openRecording } from '../src/features/video-import/video'
import { checkAutomaticScan } from './video-import.automatic'
import { fixtureBase64 } from './video-import.fixture'

declare global {
  interface Window {
    videoImportTestResults?: { passed: number; failed: number; messages: string[]; done: boolean }
  }
}
const results = { passed: 0, failed: 0, messages: [] as string[], done: false }
window.videoImportTestResults = results
const render = () => {
  const output = document.getElementById('results')
  if (output) {
    output.textContent = `${results.passed} passed, ${results.failed} failed\n${results.messages.join('\n')}`
  }
}
const assert = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(message)
  }
}
async function check(name: string, work: () => void | Promise<void>) {
  try {
    await work()
    results.passed++
    results.messages.push(`PASS ${name}`)
  } catch (error) {
    results.failed++
    results.messages.push(`FAIL ${name}: ${String(error)}`)
  }
  render()
}
function digitImage(text: string, light: boolean, size = 32, font = 'Arial') {
  const canvas = document.createElement('canvas')
  canvas.width = 200
  canvas.height = 64
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('Canvas unavailable')
  }
  context.fillStyle = light ? '#202020' : '#f0f0f0'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.font = `600 ${size}px ${font}`
  context.textBaseline = 'top'
  context.fillStyle = light ? '#f8f8f8' : '#202020'
  context.fillText(text, 8, 8)
  return grayscale(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
}
const reader = new QuantityReader()
for (const light of [false, true]) {
  for (const text of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '12', '30', '99', '123', '99+']) {
    await check(`${light ? 'light' : 'dark'} quantity ${text}`, () => {
      const result = reader.read(digitImage(text, light), light ? 'light' : 'dark')
      assert(result.kind !== 'unknown', `unexpected unknown: ${JSON.stringify(result)}`)
      if (result.kind !== 'unknown') {
        assert(result.value === Number(text.replace('+', '')), `wrong value: ${JSON.stringify(result)}`)
        assert(result.kind === (text.endsWith('+') ? 'at-least' : 'exact'), 'wrong count kind')
      }
    })
  }
}
await check('edge-clipped digits remain unknown', () => {
  const image = digitImage('12', false)
  const ink: { x: number; y: number }[] = []
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.pixels[y * image.width + x] < 128) {
        ink.push({ x, y })
      }
    }
  }
  const x0 = Math.min(...ink.map((pixel) => pixel.x))
  const y0 = Math.min(...ink.map((pixel) => pixel.y))
  const width = Math.max(...ink.map((pixel) => pixel.x)) - x0 + 1
  const height = Math.max(...ink.map((pixel) => pixel.y)) - y0 + 1
  const pixels = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      pixels[y * width + x] = image.pixels[(y + y0) * image.width + x + x0]
    }
  }
  assert(reader.read({ width, height, pixels }, 'dark').kind === 'unknown', 'clipped digits were treated as exact')
})
await check('blank quantity remains unknown', () => {
  assert(reader.read(digitImage('', false), 'auto').kind === 'unknown', 'blank became a number')
})
await check('supervised example can teach an unfamiliar digit font', () => {
  const image = digitImage('12', false, 27, 'monospace')
  reader.learn(image, '12', 'dark')
  const result = reader.read(image, 'dark')
  assert(result.kind === 'exact' && result.value === 12, JSON.stringify(result))
})
await check('incorrect teaching labels fail rather than guessing digit segmentation', () => {
  let failed = false
  try {
    reader.learn(digitImage('12', false), '12345', 'dark')
  } catch {
    failed = true
  }
  assert(failed, 'invalid teaching label accepted')
})
await check('clipped crop is rejected', () => {
  const canvas = document.createElement('canvas')
  canvas.width = 20
  canvas.height = 20
  let failed = false
  try {
    cropCanvas(canvas, { x: 19, y: 0, width: 4, height: 4 })
  } catch {
    failed = true
  }
  assert(failed, 'clipped crop was silently accepted')
})
const file = new File([Uint8Array.from(atob(fixtureBase64), (character) => character.charCodeAt(0))], 'synthetic-seek.mp4', { type: 'video/mp4' })
await check('native video decoder seeks to distinct frames and repeated timestamps', async () => {
  const recording = await openRecording(file)
  try {
    assert(recording.width === 64 && recording.height === 96, 'unexpected decoded dimensions')
    for (const timestamp of [0, 0.25, 0.95, 1.5, 1.5, 0.25, 0, 1.5]) {
      const frame = await recording.frame(timestamp)
      const pixel = frame.getContext('2d')?.getImageData(10, 10, 1, 1).data
      const isRed = timestamp < 1
      assert(pixel && pixel[isRed ? 0 : 2] > 200 && pixel[isRed ? 2 : 0] < 40, `stale frame at ${timestamp}s: ${pixel}`)
    }
  } finally {
    recording.dispose()
  }
  let failed = false
  try {
    await recording.frame(0)
  } catch {
    failed = true
  }
  assert(failed, 'disposed recording is still usable')
})
await check('cancel before opening never starts video decoding', async () => {
  const controller = new AbortController()
  controller.abort()
  let aborted = false
  try {
    await openRecording(file, controller.signal)
  } catch (error) {
    aborted = error instanceof DOMException && error.name === 'AbortError'
  }
  assert(aborted, 'abort was not honored')
})
await check('corrupt video rejects without producing a collection', async () => {
  let failed = false
  try {
    await openRecording(new File(['not a video'], 'bad.mp4', { type: 'video/mp4' }))
  } catch {
    failed = true
  }
  assert(failed, 'corrupt media was accepted')
})
await checkAutomaticScan(check, assert, file)
results.done = true
render()
