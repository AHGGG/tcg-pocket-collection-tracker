import { useEffect, useRef, useState } from 'react'
import { allCards } from '@/lib/CardsDB'
import type { VideoScanResult } from '@/services/scanner/VideoScanService'
import { exportCsv } from './csv'
import { CardOptions, ReviewRow } from './ReviewRow'
import { initialDecisions } from './reconcile'
import { downloadText } from './report'
import type { VideoScanProgress } from './scanFrames'
import { mergeSnapshot, selectedUpdates } from './snapshot'
import type { ReviewDecision, Snapshot } from './types'
import { VideoScanControls } from './VideoScanControls'
import { throwIfAborted } from './video'

type Scanner = (file: File, signal: AbortSignal, onProgress: (progress: VideoScanProgress) => void) => Promise<VideoScanResult>
const emptyBaseline: Snapshot = new Map()
const validIds = new Set(allCards.map((card) => card.internal_id))
const localScanner: Scanner = async (...args) => {
  const { scanVideoFile } = await import('@/services/scanner/VideoScanService')
  return scanVideoFile(...args)
}

/** No required setup. The tracker supplies its current collection; standalone exports a partial snapshot. */
export default function VideoImportPage({
  scanner = localScanner,
  baseline = emptyBaseline,
  onApply,
  embedded = false,
  onBusyChange,
}: {
  scanner?: Scanner
  baseline?: Snapshot
  onApply?: (updates: Snapshot) => Promise<void>
  embedded?: boolean
  onBusyChange?: (busy: boolean) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState<VideoScanProgress | null>(null)
  const [result, setResult] = useState<VideoScanResult | null>(null)
  const [decisions, setDecisions] = useState(new Map<string, ReviewDecision>())
  const [page, setPage] = useState(0)
  const controller = useRef<AbortController | null>(null)
  const applying = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
    }
  }, [])
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])

  const scan = async () => {
    if (!file || controller.current || applying.current) {
      return
    }
    const run = new AbortController()
    controller.current = run
    setBusy(true)
    setError('')
    setMessage('')
    setResult(null)
    setProgress(null)
    setPage(0)
    try {
      const scanned = await scanner(file, run.signal, (value) => {
        if (!run.signal.aborted && mounted.current) {
          setProgress(value)
        }
      })
      throwIfAborted(run.signal)
      if (!scanned.groups.length) {
        throw new Error('No cards could be matched. Try a clearer recording.')
      }
      const initial = initialDecisions(scanned.groups)
      for (const decision of initial.values()) {
        const previous = decision.internalId === null ? undefined : baseline.get(decision.internalId)
        decision.selected = decision.quantity !== '' && (!previous || Number(decision.quantity) >= previous.quantity)
      }
      setDecisions(initial)
      setResult(scanned)
    } catch (caught) {
      if (mounted.current) {
        if (run.signal.aborted) {
          setMessage('Scan canceled. Nothing was exported or applied.')
        } else {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    } finally {
      if (controller.current === run) {
        controller.current = null
        if (mounted.current) {
          setBusy(false)
        }
      }
    }
  }

  let validationError = ''
  let updates: Snapshot = new Map()
  try {
    const selected = selectedUpdates(decisions)
    const merged = mergeSnapshot(baseline, selected, validIds)
    updates = new Map(selected.map(({ internalId }) => [internalId, merged.get(internalId) as NonNullable<ReturnType<Snapshot['get']>>]))
  } catch (caught) {
    validationError = caught instanceof Error ? caught.message : String(caught)
  }

  const apply = async () => {
    if (!onApply || !updates.size || validationError || controller.current || applying.current) {
      return
    }
    applying.current = true
    setBusy(true)
    setError('')
    try {
      await onApply(updates)
      if (mounted.current) {
        setMessage(`Updated ${updates.size} cards. Unseen cards were left unchanged.`)
        setResult(null)
        setDecisions(new Map())
      }
    } catch (caught) {
      if (mounted.current) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      applying.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  return (
    <section className={embedded ? 'w-full' : 'video-import'} aria-label="Video scanner">
      {!embedded && (
        <header className="page-header">
          <h1>Scan a video</h1>
          <p>Choose a video, then press Scan. Cards and owned quantities are read automatically.</p>
        </header>
      )}
      <VideoScanControls
        file={file}
        onFileChange={(value) => {
          setFile(value)
          setError('')
          setMessage('')
          setResult(null)
          setDecisions(new Map())
        }}
        onScan={scan}
        busy={busy}
        onCancel={() => controller.current?.abort()}
        progress={progress}
      />
      <p className="muted">No calibration, layout file or baseline CSV required. Your video stays in this browser.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {result && (
        <fieldset disabled={busy}>
          <h2>Found {result.groups.length} cards</h2>
          <p>Owned totals, not additions. Repeated frames do not add copies. {updates.size} cards selected.</p>
          <p className="muted">Unreadable or conflicting quantities stay unselected. Check matches below before applying or exporting.</p>
          <div className="button-row">
            {onApply && (
              <button type="button" className="primary" disabled={!updates.size || !!validationError} onClick={apply}>
                Update selected cards
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={!updates.size || !!validationError}
              onClick={() => downloadText('video-collection.csv', exportCsv(updates, allCards), 'text/csv;charset=utf-8')}
            >
              Export CSV
            </button>
            <button
              type="button"
              disabled={!!validationError}
              onClick={() =>
                downloadText(
                  'video-collection.json',
                  JSON.stringify(
                    {
                      version: 2,
                      mode: 'ownership-snapshot',
                      partial: true,
                      sampledFrames: result.sampled,
                      duration: result.duration,
                      entries: [...updates].map(([internalId, entry]) => ({ internalId, ...entry })),
                      unresolved: result.groups
                        .filter((group) => !decisions.get(group.key)?.selected)
                        .map((group) => ({ internalId: group.internalId, quantities: group.quantities, hasLowerBound: group.hasLowerBound })),
                    },
                    null,
                    2,
                  ),
                  'application/json',
                )
              }
            >
              Export JSON
            </button>
          </div>
          {!embedded && (
            <p className="muted">
              CSV contains selected, observed cards only—not a complete collection backup. Do not use a destination’s “clear collection” option.
            </p>
          )}
          {validationError && (
            <p className="error" role="alert">
              {validationError}
            </p>
          )}
          <CardOptions />
          {result.groups.slice(page * 24, (page + 1) * 24).map((group) => (
            <details key={group.key} className="review-row">
              <summary>
                {allCards.find((card) => card.internal_id === group.internalId)?.name ?? 'Unresolved card'} —{' '}
                {decisions.get(group.key)?.quantity || 'quantity needs review'}
                {decisions.get(group.key)?.selected ? ' · selected' : ' · excluded'}
              </summary>
              <ReviewRow
                group={group}
                decision={decisions.get(group.key) as ReviewDecision}
                baseline={baseline}
                onChange={(decision) => setDecisions((previous) => new Map(previous).set(group.key, decision))}
              />
            </details>
          ))}
          {result.groups.length > 24 && (
            <div className="button-row">
              <button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>
                Previous
              </button>
              <span>
                Page {page + 1} / {Math.ceil(result.groups.length / 24)}
              </span>
              <button type="button" disabled={(page + 1) * 24 >= result.groups.length} onClick={() => setPage((value) => value + 1)}>
                Next
              </button>
            </div>
          )}
        </fieldset>
      )}
    </section>
  )
}
