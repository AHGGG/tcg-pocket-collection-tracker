import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Spinner } from '@/components/Spinner'
import { scanActionClass, scanGridClass, scanPanelClass } from '@/components/scanner/ScanPresentation'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { allCards, getCardByInternalId } from '@/lib/CardsDB'
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
  imageAction,
  language = 'en-US',
}: {
  scanner?: Scanner
  baseline?: Snapshot
  onApply?: (updates: Snapshot) => Promise<void>
  embedded?: boolean
  onBusyChange?: (busy: boolean) => void
  imageAction?: ReactNode
  language?: string
}) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [progress, setProgress] = useState<VideoScanProgress | null>(null)
  const [result, setResult] = useState<VideoScanResult | null>(null)
  const [decisions, setDecisions] = useState(new Map<string, ReviewDecision>())
  const [page, setPage] = useState(0)
  const [applied, setApplied] = useState<Snapshot | null>(null)
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
    setApplied(null)
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
        decision.selected = decision.internalId !== null && decision.quantity !== '' && (!previous || Number(decision.quantity) >= previous.quantity)
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
        setApplied(updates)
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

  const reset = () => {
    if (busy) {
      return
    }
    setFile(null)
    setResult(null)
    setApplied(null)
    setDecisions(new Map())
    setPage(0)
    setProgress(null)
    setError('')
    setMessage('')
  }
  const matches = new Map(result?.cards.map((match) => [match.matchedCard.card.internal_id, match]))

  return (
    <section className={embedded ? 'flex flex-col w-full gap-2' : scanPanelClass} aria-label="Video scanner">
      {!result && !applied && (
        <VideoScanControls
          file={file}
          onFileChange={(value) => {
            setFile(value)
            setError('')
            setMessage('')
            setDecisions(new Map())
          }}
          onScan={scan}
          busy={busy}
          onCancel={() => controller.current?.abort()}
          progress={progress}
          imageAction={imageAction}
        />
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Scan could not be completed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && !applied && (
        <p className="text-center text-sm text-neutral-400" role="status">
          {message}
        </p>
      )}
      {applied && (
        <div className="flex flex-col w-full max-w-lg mx-auto">
          <p className="text-xl text-center mb-4" role="status">
            {message}
          </p>
          <ul className="flex flex-col gap-2 mb-8">
            {[...applied].map(([id, entry]) => (
              <li key={id} className="flex gap-2 rounded bg-zinc-800 p-1">
                <span className="mr-auto">{getCardByInternalId(id)?.name}</span>
                <span className="text-neutral-400">×{entry.quantity}</span>
              </li>
            ))}
          </ul>
          <Button onClick={reset}>Scan more</Button>
        </div>
      )}
      {result && busy && (
        <Alert role="status">
          <AlertDescription className="flex items-center space-x-2">
            <Spinner size="inline" />
            <p>Updating your collection…</p>
          </AlertDescription>
        </Alert>
      )}
      {result && !busy && (
        <>
          <h2 className="text-center text-xl">Found {result.groups.length} cards</h2>
          <p className="text-center text-sm text-neutral-400 px-2">Adjust the owned total for matched cards. Click an image to exclude or include a card.</p>
          <p className="text-center text-xs text-neutral-500 px-2">
            {updates.size} selected · Totals replace counts, not add copies. Unreadable quantities are excluded.
          </p>
          <CardOptions />
          <div className={scanGridClass} data-scan-results>
            {result.groups.slice(page * 24, (page + 1) * 24).map((group) => (
              <ReviewRow
                key={group.key}
                group={group}
                decision={decisions.get(group.key) as ReviewDecision}
                baseline={baseline}
                language={language}
                match={group.internalId === null ? undefined : matches.get(group.internalId)}
                onChange={(decision) => setDecisions((previous) => new Map(previous).set(group.key, decision))}
              />
            ))}
          </div>
          {result.groups.length > 24 && (
            <nav className="flex items-center justify-center gap-3 my-2" aria-label="Scan result pages">
              <Button variant="outline" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>
                Previous
              </Button>
              <span className="text-sm">
                Page {page + 1} / {Math.ceil(result.groups.length / 24)}
              </span>
              <Button variant="outline" disabled={(page + 1) * 24 >= result.groups.length} onClick={() => setPage((value) => value + 1)}>
                Next
              </Button>
            </nav>
          )}
          {validationError && (
            <Alert variant="destructive">
              <AlertDescription>{validationError}</AlertDescription>
            </Alert>
          )}
          {onApply && (
            <Button className={scanActionClass} disabled={!updates.size || !!validationError} onClick={apply}>
              Update selected cards
            </Button>
          )}
          <Button
            variant={onApply ? 'outline' : 'default'}
            className={scanActionClass}
            disabled={!updates.size || !!validationError}
            onClick={() => downloadText('video-collection.csv', exportCsv(updates, allCards), 'text/csv;charset=utf-8')}
          >
            Export CSV
          </Button>
          <Button variant="outline" className={scanActionClass} onClick={reset}>
            Scan more
          </Button>
          <details className="text-sm text-neutral-400 px-2 my-2">
            <summary className="cursor-pointer text-center">Additional export options</summary>
            <div className="flex flex-col gap-2 mt-2">
              <Button
                variant="outline"
                className={scanActionClass}
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
              </Button>
              <p className="text-xs text-center">
                Exports contain selected cards only, not a complete backup. Do not clear your collection when importing them.
              </p>
            </div>
          </details>
        </>
      )}
    </section>
  )
}
