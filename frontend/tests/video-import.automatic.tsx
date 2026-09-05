import { type ReactNode, StrictMode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { readAutomaticQuantity } from '../src/features/video-import/autoQuantity'
import { readBaseline } from '../src/features/video-import/csv'
import { QuantityReader } from '../src/features/video-import/quantity'
import { ObservationStore } from '../src/features/video-import/reconcile'
import { scanFrames } from '../src/features/video-import/scanFrames'
import VideoImportPage from '../src/features/video-import/VideoImportPage'
import { allCards } from '../src/lib/CardsDB'
import type { ExtractedCard } from '../src/services/scanner/CardDetectionService'
import '../src/index.css'

type Check = (name: string, work: () => void | Promise<void>) => Promise<void>
type Assert = (condition: unknown, message: string) => void

export async function checkAutomaticScan(check: Check, assert: Assert, file: File) {
  const identify = (match: ExtractedCard) => ({ id: match.matchedCard.card.internal_id, score: match.matchedCard.similarity })
  const recognize = async (frame: HTMLCanvasElement): Promise<ExtractedCard[]> => {
    const red = (frame.getContext('2d')?.getImageData(10, 10, 1, 1).data[0] ?? 0) > 100
    const imageUrl = frame.toDataURL('image/png')
    return (red ? [allCards[0], allCards[0], allCards[1]] : [allCards[0]]).map((card) => ({
      matchedCard: { card, similarity: 0.99 },
      imageUrl,
      resolvedImageUrl: imageUrl,
      increment: 1,
    }))
  }
  await check('automatic pipeline samples native video and counts each card once per frame', async () => {
    const progress: number[] = []
    const result = await scanFrames(file, recognize, identify, new AbortController().signal, (value) => progress.push(value.fraction))
    assert(result.sampled === 4, 'expected four samples from the two-second fixture')
    assert(result.cards[0].count === 4 && result.cards[1].count === 2, 'per-frame counts were not deduplicated correctly')
    assert(progress[0] === 0 && progress.at(-1) === 1, 'progress did not cover the full scan')
  })
  await check('cancellation during frame recognition rejects instead of returning partial counts', async () => {
    const controller = new AbortController()
    let aborted = false
    let visited = 0
    try {
      await scanFrames(
        file,
        async (frame) => {
          visited++
          controller.abort()
          return recognize(frame)
        },
        identify,
        controller.signal,
        () => {},
      )
    } catch (error) {
      aborted = error instanceof DOMException && error.name === 'AbortError'
    }
    assert(aborted && visited === 1, 'cancellation did not stop after the in-flight frame')
  })
  await check('recognition failures release the video without returning partial results', async () => {
    let failed = false
    let revoked = 0
    const original = URL.revokeObjectURL
    URL.revokeObjectURL = (url) => {
      revoked++
      original.call(URL, url)
    }
    try {
      await scanFrames(
        file,
        async () => {
          throw new Error('synthetic detector failure')
        },
        identify,
        new AbortController().signal,
        () => {},
      )
    } catch (error) {
      failed = error instanceof Error && error.message === 'synthetic detector failure'
    } finally {
      URL.revokeObjectURL = original
    }
    assert(failed && revoked === 1, 'failed scan leaked its recording or swallowed the error')
  })

  await check('automatic quantity-tab location reads totals without calibration at multiple sizes', () => {
    const reader = new QuantityReader()
    for (const width of [160, 240]) {
      const canvas = document.createElement('canvas')
      canvas.width = width + 40
      canvas.height = Math.round(width * 1.4) + 70
      const context = canvas.getContext('2d') as CanvasRenderingContext2D
      const card = { x: 20, y: 20, width, height: width * 1.4 }
      context.fillStyle = '#fff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.fillStyle = '#526575'
      context.fillRect(card.x, card.y + card.height * 0.9, card.width * 0.45, card.height * 0.1)
      context.fillStyle = '#fff'
      context.font = `600 ${Math.round(card.height * 0.072)}px Arial`
      context.textBaseline = 'middle'
      context.textAlign = 'center'
      context.fillText('12', card.x + card.width * 0.22, card.y + card.height * 0.95)
      const result = readAutomaticQuantity(canvas, card, reader).reading
      assert(result.kind === 'exact' && result.value === 12, `quantity tab not read at width ${width}: ${JSON.stringify(result)}`)
    }
  })
  await check('absent quantity tab remains unknown rather than one or zero', () => {
    const canvas = document.createElement('canvas')
    canvas.width = 300
    canvas.height = 400
    const context = canvas.getContext('2d') as CanvasRenderingContext2D
    context.fillStyle = '#fff'
    context.fillRect(0, 0, 300, 400)
    assert(readAutomaticQuantity(canvas, { x: 20, y: 20, width: 200, height: 280 }, new QuantityReader()).reading.kind === 'unknown', 'absent badge guessed')
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const renderPage = (page: ReactNode) => root.render(<StrictMode>{page}</StrictMode>)
  let calls = 0
  const scanner: NonNullable<Parameters<typeof VideoImportPage>[0]>['scanner'] = async (recording, signal, onProgress) => {
    calls++
    const result = await scanFrames(recording, recognize, identify, signal, onProgress)
    const observations = new ObservationStore()
    for (const [index, { sample, count }] of result.cards.entries()) {
      for (let frame = 0; frame < count; frame++) {
        observations.add({
          key: `${index}:${frame}`,
          timestamp: frame,
          fingerprint: String(index),
          internalId: sample.matchedCard.card.internal_id,
          candidates: [],
          quantity: { kind: 'exact', value: 3, score: 0.99 },
          cardImage: sample.imageUrl,
          badgeImage: sample.imageUrl,
        })
      }
    }
    return { ...result, cards: result.cards.map(({ sample }) => ({ ...sample, increment: 0 })), groups: observations.values() }
  }
  const until = async (condition: () => boolean) => {
    const end = performance.now() + 15_000
    while (performance.now() < end) {
      if (condition()) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`UI timeout: ${host.textContent}`)
  }
  const button = (text: string): HTMLButtonElement => {
    const found = [...host.querySelectorAll('button')].find((element) => element.textContent?.trim() === text)
    if (!found) {
      throw new Error(`Missing ${text} button`)
    }
    return found
  }
  const choose = (recording: File) => {
    if (!host.querySelector('input[type="file"]')) {
      flushSync(() => button('Scan more').click())
    }
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')
    if (!input) {
      throw new Error('Missing video input')
    }
    const transfer = new DataTransfer()
    transfer.items.add(recording)
    input.files = transfer.files
    flushSync(() => input.dispatchEvent(new Event('change', { bubbles: true })))
  }
  try {
    flushSync(() => renderPage(<VideoImportPage scanner={scanner} />))
    await check('simple UI requires only choosing a video and pressing Scan', async () => {
      assert(button('Scan').disabled, 'scan should require a video')
      choose(file)
      assert(!button('Scan').disabled && calls === 0, 'choosing the file unexpectedly starts a scan or requires setup')
      flushSync(() => {
        button('Scan').click()
      })
      await until(() => host.textContent?.includes('Found 2 cards') === true)
      assert(calls === 1, 'scan did not run exactly once')
      assert(!host.querySelector('canvas'), 'manual calibration canvas is still present')
      assert(!host.querySelector('input[type="number"]'), 'calibration coordinates are still required')
      assert(host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.value === '3', 'owned totals were not populated automatically')
      assert(host.querySelectorAll('[data-scan-card]').length === 2, 'image-style result cards were not rendered')
      assert(
        host.querySelectorAll('[data-scan-card] button[aria-pressed] img').length === 4,
        'captured and reference previews must be visible without expanding details',
      )
    })
    await check('result images toggle selection without losing the owned quantity', async () => {
      const tile = host.querySelector<HTMLElement>('[data-scan-card]') as HTMLElement
      const toggle = () => tile.querySelector<HTMLButtonElement>('button[aria-pressed]') as HTMLButtonElement
      assert(toggle().getAttribute('aria-pressed') === 'true', 'known total should initially be selected')
      flushSync(() => toggle().click())
      assert(toggle().getAttribute('aria-pressed') === 'false', 'image click did not exclude the card')
      assert(tile.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.value === '3', 'excluding a card destroyed its detected total')
      flushSync(() => toggle().click())
      assert(toggle().getAttribute('aria-pressed') === 'true', 'image click did not re-include the card')
      assert(tile.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.value === '3', 're-including guessed a new quantity')
    })
    await check('plus and minus adjust owned totals with the original image-scan buttons', () => {
      const tile = host.querySelector<HTMLElement>('[data-scan-card]') as HTMLElement
      const more = tile.querySelector<HTMLButtonElement>('button[aria-label^="Increase"]') as HTMLButtonElement
      const less = tile.querySelector<HTMLButtonElement>('button[aria-label^="Decrease"]') as HTMLButtonElement
      flushSync(() => more.click())
      assert(tile.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.value === '4', 'plus must adjust the total')
      flushSync(() => less.click())
      assert(tile.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.value === '3', 'minus must restore the total')
    })
    await check('CSV download contains actual scan data and the correct filename', async () => {
      const original = HTMLAnchorElement.prototype.click
      let filename = ''
      let contents: Promise<string> | undefined
      HTMLAnchorElement.prototype.click = function () {
        filename = this.download
        contents = fetch(this.href).then((response) => response.text())
      }
      try {
        button('Export CSV').click()
        assert(filename === 'video-collection.csv', `wrong download filename: ${filename}`)
        const text = await contents
        assert(text?.includes('NumberOwned'), 'download does not contain the collection CSV')
        assert(readBaseline(text ?? '', allCards).entries.get(allCards[0].internal_id)?.quantity === 3, 'sightings replaced owned total')
      } finally {
        HTMLAnchorElement.prototype.click = original
      }
    })
    await check('JSON export preserves snapshot semantics and distinguishes frame statistics', async () => {
      const original = HTMLAnchorElement.prototype.click
      let filename = ''
      let contents: Promise<string> | undefined
      HTMLAnchorElement.prototype.click = function () {
        filename = this.download
        contents = fetch(this.href).then((response) => response.text())
      }
      try {
        const additional = [...host.querySelectorAll('details')].find(
          (element) => element.querySelector('summary')?.textContent === 'Additional export options',
        )
        if (additional) {
          additional.open = true
        }
        button('Export JSON').click()
        const data = JSON.parse((await contents) ?? '{}')
        assert(filename === 'video-collection.json', 'wrong JSON filename')
        assert(data.mode === 'ownership-snapshot' && data.entries[0].quantity === 3 && data.sampledFrames === 4, 'wrong JSON contents')
      } finally {
        HTMLAnchorElement.prototype.click = original
      }
    })
    await check('embedded scanner applies absolute totals only after confirmation and keeps unseen cards out', async () => {
      let submitted: number | null = null
      const baseline = new Map([
        [allCards[0].internal_id, { quantity: 2, collected: true }],
        [allCards[2].internal_id, { quantity: 9, collected: true }],
      ])
      flushSync(() =>
        renderPage(
          <VideoImportPage
            scanner={scanner}
            embedded
            baseline={baseline}
            onApply={async (updates) => {
              submitted = updates.get(allCards[0].internal_id)?.quantity ?? null
              assert(!updates.has(allCards[2].internal_id), 'unseen card submitted')
            }}
          />,
        ),
      )
      assert(submitted === null, 'collection changed before confirmation')
      flushSync(() => button('Update selected cards').click())
      await until(() => host.textContent?.includes('Updated 2 cards.') === true)
      assert(submitted === 3, 'applied a frame count or increment instead of owned total')
    })
    await check('failed collection update stays recoverable instead of displaying success', async () => {
      flushSync(() =>
        renderPage(
          <VideoImportPage
            scanner={scanner}
            embedded
            onApply={async () => {
              throw new Error('synthetic update failure')
            }}
          />,
        ),
      )
      choose(file)
      flushSync(() => button('Scan').click())
      await until(() => host.textContent?.includes('Found 2 cards') === true)
      flushSync(() => button('Update selected cards').click())
      await until(() => host.textContent?.includes('synthetic update failure') === true)
      assert(host.textContent?.includes('Found 2 cards'), 'failed update discarded results')
      assert(!button('Update selected cards').disabled, 'failed update cannot be retried')
      flushSync(() => renderPage(<VideoImportPage scanner={scanner} />))
    })
    await check('corrupt recording shows a recoverable error and clears stale exports', async () => {
      choose(new File(['bad video'], 'bad.mp4', { type: 'video/mp4' }))
      flushSync(() => button('Scan').click())
      await until(() => !!host.querySelector('[role="alert"]'))
      assert(!button('Scan').disabled, 'scan is still disabled after failure')
      assert(!host.textContent?.includes('Export CSV'), 'stale scan can still be exported')
    })
    await check('Cancel stops scanning and the same selected video can be scanned again', async () => {
      choose(file)
      flushSync(() => button('Scan').click())
      flushSync(() => button('Cancel').click())
      await until(() => host.textContent?.includes('Scan canceled.') === true)
      assert(!button('Scan').disabled, 'cannot retry after cancellation')
      const previousCalls = calls
      flushSync(() => button('Scan').click())
      await until(() => host.textContent?.includes('Found 2 cards') === true)
      assert(calls === previousCalls + 1, 'rescan did not run exactly once')
      assert(host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.value === '3', 'owned quantity changed when re-scanning')
    })
    await check('badge-less video results default to one and export without typing quantities', async () => {
      const missingScanner: typeof scanner = async (...args) => {
        const scanned = await scanner(...args)
        return {
          ...scanned,
          groups: scanned.groups.map((group) => ({
            ...group,
            quantities: [],
            suggestedQuantity: null,
            hasUnknown: true,
            evidence: group.evidence.map((observation) => ({ ...observation, quantity: { kind: 'unknown' as const, reason: 'No badge in compact view' } })),
          })),
        }
      }
      flushSync(() => renderPage(<VideoImportPage scanner={missingScanner} />))
      choose(file)
      flushSync(() => button('Scan').click())
      await until(() => host.textContent?.includes('Found 2 cards') === true)
      assert(host.querySelectorAll('button[aria-pressed="true"]').length === 2, 'missing counts were not preselected')
      assert(host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.value === '1', 'missing quantity is not one')
      assert(host.textContent?.includes('default 1—not an exact count'), 'default was presented as a measured count')
      assert(!button('Export CSV').disabled, 'CSV export is blocked')
      const original = HTMLAnchorElement.prototype.click
      let contents: Promise<string> | undefined
      HTMLAnchorElement.prototype.click = function () {
        contents = fetch(this.href).then((response) => response.text())
      }
      try {
        button('Export CSV').click()
        const text = await contents
        assert(readBaseline(text ?? '', allCards).entries.get(allCards[0].internal_id)?.quantity === 1, 'CSV does not contain default one')
        assert(text?.includes('QuantitySource') && text.includes('default-1'), 'default provenance is missing from the CSV')
      } finally {
        HTMLAnchorElement.prototype.click = original
      }
    })
    await check('new collection data preserves higher totals for fallback rows without a new scan', async () => {
      let appliedQuantity: number | undefined
      const baseline = new Map([[allCards[0].internal_id, { quantity: 7, collected: true }]])
      flushSync(() =>
        renderPage(
          <VideoImportPage
            scanner={scanner}
            baseline={baseline}
            onApply={async (updates) => {
              appliedQuantity = updates.get(allCards[0].internal_id)?.quantity
            }}
          />,
        ),
      )
      assert(host.querySelector<HTMLInputElement>('input[inputmode="numeric"]')?.value === '7', 'default would lower the refreshed quantity')
      assert(!button('Update selected cards').disabled, 'preserving existing quantity requires manual entry')
      flushSync(() => button('Update selected cards').click())
      await until(() => host.textContent?.includes('Updated 2 cards.') === true)
      assert(appliedQuantity === 7, 'default overwrote an existing higher count')
    })
  } finally {
    flushSync(() => root.unmount())
    host.remove()
  }
  await check('bundled detector loads and full automatic pipeline rejects blank video', async () => {
    const { scanVideoFile } = await import('../src/services/scanner/VideoScanService')
    let rejected = false
    let sampled = 0
    try {
      await scanVideoFile(file, new AbortController().signal, (value) => {
        sampled = value.sampled
      })
    } catch (error) {
      rejected = error instanceof Error && error.message.startsWith('No cards could be matched.')
    }
    assert(rejected && sampled === 4, 'bundled model did not complete recognition on all four blank frames')
  })
}
