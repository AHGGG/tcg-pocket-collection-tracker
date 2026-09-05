import { useEffect, useRef, useState } from 'react'
import { allCards } from '@/lib/CardsDB'
import { Calibration, type Regions } from './Calibration'
import { exportCsv, readBaseline } from './csv'
import { badgeRect, makeProfile, toPixels, validateProfile } from './geometry'
import { initialDecisions } from './reconcile'
import { catalogueFingerprint, downloadText, makeReport } from './report'
import { CardOptions, ReviewRow } from './ReviewRow'
import { mergeSnapshot, selectedUpdates } from './snapshot'
import type { LayoutProfile, ReviewDecision, ReviewGroup, ScanStats, Snapshot } from './types'
import { cropCanvas, grayCanvas, openRecording, type Recording, throwIfAborted } from './video'

interface ScanResult {
  groups: ReviewGroup[]
  stats: ScanStats
  profile: LayoutProfile
  duration: number
}
const emptyRegions: Regions = { grid: null, card: null, badge: null }
const validIds = new Set(allCards.map((card) => card.internal_id))
const expansionIds = [...new Set(allCards.map((card) => card.expansion))]
const pageSize = 20
const searchableCards = new Map<number, string>()
for (const card of allCards) {
  searchableCards.set(card.internal_id, `${searchableCards.get(card.internal_id) ?? ''} ${card.card_id} ${card.name}`.toLowerCase())
}

function localDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

export default function VideoImportPage() {
  const [file, setFile] = useState<File | null>(null)
  const [baseline, setBaseline] = useState<Snapshot>(new Map())
  const [baselineName, setBaselineName] = useState<string | null>(null)
  const [baselineWarnings, setBaselineWarnings] = useState<string[]>([])
  const [preview, setPreview] = useState<{ image: string; width: number; height: number; duration: number; time: number } | null>(null)
  const [timeInput, setTimeInput] = useState('0')
  const [regions, setRegions] = useState<Regions>(emptyRegions)
  const [polarity, setPolarity] = useState<LayoutProfile['polarity']>('auto')
  const [exampleQuantity, setExampleQuantity] = useState('')
  const [quantityTest, setQuantityTest] = useState('')
  const [interval, setIntervalSeconds] = useState(0.5)
  const [expansion, setExpansion] = useState('')
  const [recordedAt, setRecordedAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState({ fraction: 0, message: '' })
  const [result, setResult] = useState<ScanResult | null>(null)
  const [decisions, setDecisions] = useState<Map<string, ReviewDecision>>(new Map())
  const [reviewed, setReviewed] = useState(false)
  const [fresh, setFresh] = useState(false)
  const [includeImages, setIncludeImages] = useState(false)
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const operation = useRef<AbortController | null>(null)
  const recording = useRef<Recording | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      operation.current?.abort()
      recording.current?.dispose()
      recording.current = null
    }
  }, [])

  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current) {
      return
    }
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setError('')
    setProgress({ fraction: 0, message: 'Processing local data…' })
    try {
      await work(controller.signal)
    } catch (caught) {
      if (alive.current) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      if (alive.current && operation.current === controller) {
        setBusy(false)
        operation.current = null
      }
    }
  }

  const profile = (): LayoutProfile => {
    if (!preview || !regions.grid || !regions.card || !regions.badge) {
      throw new Error('Mark the collection area, one complete card, and that card’s quantity first.')
    }
    return makeProfile(regions.grid, regions.card, regions.badge, preview.width / preview.height, polarity)
  }

  const loadVideo = (selected: File) => run(async (signal) => {
    setResult(null)
    setDecisions(new Map())
    setPreview(null)
    setFile(null)
    setRegions(emptyRegions)
    setQuantityTest('')
    setExampleQuantity('')
    setProgress({ fraction: 0, message: 'Opening local recording…' })
    recording.current?.dispose()
    recording.current = null
    const loaded = await openRecording(selected, signal)
    try {
      const time = Math.min(1, loaded.duration / 2)
      const canvas = await loaded.frame(time, signal)
      throwIfAborted(signal)
      recording.current = loaded
      setFile(selected)
      setRecordedAt(localDateTime(selected.lastModified || Date.now()))
      setTimeInput(time.toFixed(2))
      setPreview({ image: canvas.toDataURL('image/jpeg', 0.9), width: loaded.width, height: loaded.height, duration: loaded.duration, time })
    } catch (caught) {
      loaded.dispose()
      throw caught
    }
    setProgress({ fraction: 0, message: '' })
  })

  const capturePreview = () => run(async (signal) => {
    if (!file) {
      return
    }
    const loaded = recording.current ?? await openRecording(file, signal)
    recording.current = loaded
    const time = Math.max(0, Math.min(Number(timeInput), loaded.duration - 0.001))
    const canvas = await loaded.frame(time, signal)
    throwIfAborted(signal)
    setRegions({ grid: regions.grid, card: null, badge: null })
    setQuantityTest('')
    setPreview({ image: canvas.toDataURL('image/jpeg', 0.9), width: loaded.width, height: loaded.height, duration: loaded.duration, time })
  })

  const loadBaseline = (selected: File) => run(async (signal) => {
    if (selected.size > 20_000_000) {
      throw new Error('Baseline CSV must be smaller than 20 MB.')
    }
    const text = await selected.text()
    throwIfAborted(signal)
    const parsed = readBaseline(text, allCards)
    setBaseline(parsed.entries)
    setBaselineName(selected.name)
    setBaselineWarnings(parsed.warnings)
    setFresh(false)
    setReviewed(false)
    if (result) {
      setDecisions(initialDecisions(result.groups))
    }
  })

  const loadLayout = (selected: File) => run(async (signal) => {
    if (!preview || selected.size > 20_000) {
      throw new Error('Load a recording first; layout files must be smaller than 20 KB.')
    }
    const text = await selected.text()
    throwIfAborted(signal)
    const loaded = validateProfile(JSON.parse(text))
    if (Math.abs(preview.width / preview.height / loaded.frameAspect - 1) > 0.02) {
      throw new Error('Saved layout does not match this recording’s aspect ratio.')
    }
    setRegions({ grid: loaded.grid, card: loaded.card, badge: badgeRect(loaded.card, loaded.badge) })
    setPolarity(loaded.polarity)
    setQuantityTest('')
  })

  const testQuantity = () => run(async (signal) => {
    if (!file || !preview) {
      return
    }
    const layout = profile()
    const { QuantityReader } = await import('./quantity')
    const loaded = recording.current ?? await openRecording(file, signal)
    recording.current = loaded
    const frame = await loaded.frame(preview.time, signal)
    const image = grayCanvas(cropCanvas(frame, toPixels(badgeRect(layout.card, layout.badge), preview.width, preview.height)))
    const reader = new QuantityReader()
    if (exampleQuantity.trim()) {
      reader.learn(image, exampleQuantity.trim(), polarity)
    }
    const reading = reader.read(image, polarity)
    throwIfAborted(signal)
    setQuantityTest(reading.kind === 'unknown' ? `Unknown: ${reading.reason}` : `Suggested quantity: ${reading.value}${reading.kind === 'at-least' ? '+' : ''}. Verify this visually.`)
  })

  const startScan = () => run(async (signal) => {
    if (!file || !preview) {
      return
    }
    const layout = profile()
    setResult(null)
    setDecisions(new Map())
    setReviewed(false)
    setFresh(false)
    setProgress({ fraction: 0, message: 'Loading scanner…' })
    recording.current?.dispose()
    recording.current = null
    const { scanRecording } = await import('./pipeline')
    throwIfAborted(signal)
    const scanned = await scanRecording({
      file, profile: layout, calibrationTime: preview.time, exampleQuantity, interval, expansion, signal,
      onProgress: (value) => {
        if (alive.current && !signal.aborted) {
          setProgress({ fraction: value.fraction, message: value.message })
        }
      },
    })
    throwIfAborted(signal)
    setResult(scanned)
    setDecisions(initialDecisions(scanned.groups))
    setPage(0)
    setSearch('')
    setFilter('all')
  })

  const changeDecision = (key: string, decision: ReviewDecision) => {
    setDecisions((previous) => new Map(previous).set(key, decision))
    setReviewed(false)
  }

  const selectSuggestions = () => {
    if (!result) {
      return
    }
    const next = new Map(decisions)
    for (const group of result.groups) {
      if (group.internalId === null || group.suggestedQuantity === null || group.hasUnknown || group.hasLowerBound) {
        continue
      }
      const current = next.get(group.key)
      if (current && (current.internalId !== group.internalId || current.quantity !== String(group.suggestedQuantity))) {
        continue // Do not overwrite a manual correction with the model's suggestion.
      }
      const old = baseline.get(group.internalId)
      if (old && group.suggestedQuantity < old.quantity) {
        continue
      }
      next.set(group.key, { selected: true, internalId: group.internalId, quantity: String(group.suggestedQuantity), decreaseApproved: false })
    }
    setDecisions(next)
    setReviewed(false)
  }

  const exportResult = (kind: 'csv' | 'changes' | 'json') => run(async (signal) => {
    if (!result || !file || !reviewed || (baselineName && !fresh)) {
      throw new Error('Confirm your review and recording freshness before exporting.')
    }
    if (!recordedAt || !Number.isFinite(new Date(recordedAt).getTime())) {
      throw new Error('Enter a valid recording date before exporting.')
    }
    const updates = selectedUpdates(decisions)
    if (!updates.length) {
      throw new Error('Select at least one verified row to export.')
    }
    const snapshot = mergeSnapshot(baseline, updates, validIds)
    const stamp = new Date().toISOString().slice(0, 10)
    if (kind === 'csv' || kind === 'changes') {
      const output = kind === 'changes' ? new Map([...snapshot].filter(([id]) => updates.some((update) => update.internalId === id))) : snapshot
      downloadText(`collection-${kind === 'changes' ? 'changes' : baselineName ? 'merged' : 'partial'}-${stamp}.csv`, exportCsv(output, allCards), 'text/csv;charset=utf-8')
    } else {
      const catalogueHash = await catalogueFingerprint(allCards)
      throwIfAborted(signal)
      const report = makeReport({
        catalogueHash, cards: allCards,
        recording: { name: file.name, size: file.size, duration: result.duration, recordedAt: new Date(recordedAt).toISOString() },
        baselineName, profile: result.profile, stats: result.stats, groups: result.groups, decisions, snapshot, includeImages,
      })
      downloadText(`collection-review-${stamp}.json`, JSON.stringify(report, null, 2), 'application/json')
    }
  })

  const selectedCount = [...decisions.values()].filter((decision) => decision.selected).length
  const visibleGroups = (result?.groups ?? []).filter((group) => {
    const decision = decisions.get(group.key)
    if (filter === 'selected' && !decision?.selected) {
      return false
    }
    const previous = decision?.internalId === null || decision?.internalId === undefined ? undefined : baseline.get(decision.internalId)
    const isDecrease = previous && decision && /^\d+$/.test(decision.quantity) && Number(decision.quantity) < previous.quantity
    if (filter === 'attention' && group.internalId !== null && group.suggestedQuantity !== null && !group.hasUnknown && !group.hasLowerBound && !isDecrease) {
      return false
    }
    if (search.trim()) {
      const query = search.toLowerCase().trim()
      const ids = [...group.candidates.map((candidate) => candidate.internalId), decision?.internalId]
      return ids.some((id) => id !== null && id !== undefined && searchableCards.get(id)?.includes(query))
    }
    return true
  })
  const lastPage = Math.max(0, Math.ceil(visibleGroups.length / pageSize) - 1)
  const shownPage = Math.min(page, lastPage)

  return (
    <main className="video-import">
      <header className="page-header">
        <a href="./index.html">← Collection tracker</a>
        <span className="pill">LOCAL ONLY · EXPERIMENTAL</span>
        <h1>Recording → collection</h1>
        <p>Record one scroll. Review the evidence. Export owned quantities—not repeated sightings.</p>
      </header>
      <aside className="notice">
        <strong>No Nintendo login, ADB or upload.</strong> The page downloads static card hashes, model weights and reference images from this site.
        Your recording, CSV, crops and quantities stay in this browser. It never writes to your tracker account.
      </aside>
      {error && <div className="error" role="alert">{error}</div>}
      {busy && (
        <section className="panel" aria-live="polite">
          <p>{progress.message || 'Processing local data…'}</p>
          <progress value={progress.fraction} max="1" aria-label="Fraction of recording sampled" />
          <button type="button" onClick={() => operation.current?.abort()}>Cancel</button>
          <p className="muted">Progress measures the recording, not collection completeness.</p>
        </section>
      )}
      {!result && (
        <>
          <section className="panel">
            <h2><span>1</span> Choose your files</h2>
            <p>In Pocket, show owned quantities, keep one grid zoom and language, and scroll with overlapping views. Pause briefly on each view.
              Start with a short English-language recording of one expansion. Do not use a pack-opening video.</p>
            <div className="form-grid">
              <label>Screen recording<input type="file" accept="video/*,.mp4,.mov,.webm" disabled={busy} onChange={(event) => {
                const selected = event.target.files?.[0]
                if (selected) { void loadVideo(selected) }
                event.target.value = ''
              }} /></label>
              <label>Previous collection CSV (optional)<input type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => {
                const selected = event.target.files?.[0]
                if (selected) { void loadBaseline(selected) }
                event.target.value = ''
              }} /></label>
            </div>
            <p className="muted">{file?.name ?? 'No recording selected.'} · {baselineName ? `Baseline: ${baselineName} (${baseline.size} ownership entries)` : 'No baseline: export will contain confirmed cards only, not invented zeroes.'}</p>
            {baselineName && <button type="button" disabled={busy} onClick={() => { setBaseline(new Map()); setBaselineName(null); setBaselineWarnings([]) }}>Remove baseline</button>}
            {baselineWarnings.length > 0 && <details className="warning-text"><summary>{baselineWarnings.length} catalogue ID remapping(s)—review before proceeding</summary><pre>{baselineWarnings.join('\n')}</pre></details>}
          </section>
          {preview && (
            <section className="panel">
              <h2><span>2</span> Calibrate this recording</h2>
              <p>Choose a clear frame. Mark the collection area without navigation bars, one complete card, then its entire numeric quantity area, with margins and room for multi-digit counts.
                Save the layout to reuse it with the same phone and grid zoom.</p>
              <div className="button-row">
                <label>Preview timestamp (seconds)<input type="number" min="0" max={preview.duration} step="0.1" value={timeInput} disabled={busy} onChange={(event) => setTimeInput(event.target.value)} /></label>
                <button type="button" disabled={busy} onClick={() => { void capturePreview() }}>Capture preview frame</button>
                <label>Load saved layout<input type="file" accept=".json" disabled={busy} onChange={(event) => {
                  const selected = event.target.files?.[0]
                  if (selected) { void loadLayout(selected) }
                  event.target.value = ''
                }} /></label>
              </div>
              <p className="muted">Displayed frame: {preview.time.toFixed(2)}s · {preview.width} × {preview.height}</p>
              <fieldset disabled={busy}>
                <Calibration image={preview.image} width={preview.width} height={preview.height} regions={regions} onChange={(value) => { setRegions(value); setQuantityTest('') }} />
                <div className="form-grid">
                  <label>Quantity text<select value={polarity} onChange={(event) => setPolarity(event.target.value as LayoutProfile['polarity'])}><option value="auto">Auto</option><option value="dark">Dark digits on a light background</option><option value="light">Light digits on a dark background</option></select></label>
                  <label>Known quantity in this crop (optional teaching example)<input value={exampleQuantity} onChange={(event) => setExampleQuantity(event.target.value)} placeholder="For example: 12" /></label>
                </div>
                <div className="button-row">
                  <button type="button" onClick={() => { void testQuantity() }}>Test quantity crop</button>
                  <button type="button" onClick={() => { try { downloadText('pocket-video-layout.json', JSON.stringify(profile(), null, 2), 'application/json') } catch (caught) { setError(String(caught)) } }}>Save layout</button>
                </div>
                {quantityTest && <p role="status">{quantityTest}</p>}
              </fieldset>
            </section>
          )}
          {preview && (
            <section className="panel">
              <h2><span>3</span> Recognize locally</h2>
              <div className="form-grid">
                <label>Expansion shown in the recording<select disabled={busy} value={expansion} onChange={(event) => setExpansion(event.target.value)}><option value="">All expansions</option>{expansionIds.map((id) => <option key={id} value={id}>{id}</option>)}</select></label>
                <label>Sampling interval<select disabled={busy} value={interval} onChange={(event) => setIntervalSeconds(Number(event.target.value))}><option value={0.25}>0.25 seconds · more frames</option><option value={0.5}>0.5 seconds · default</option><option value={1}>1 second · longer pauses needed</option></select></label>
              </div>
              <p className="warning-text">Digit templates and similarity thresholds are experimental. No game-account sync or recognition-accuracy guarantee is implied. Uncertain results need review.</p>
              <button className="primary" type="button" disabled={busy} onClick={() => { void startScan() }}>Scan recording</button>
            </section>
          )}
        </>
      )}
      {result && (
        <>
          <section className="panel">
            <h2><span>4</span> Review → export</h2>
            <p><strong>{result.groups.length}</strong> review rows · <strong>{selectedCount}</strong> selected · {result.stats.sampled} sampled frames · {result.stats.duplicateFrames} duplicates skipped · {result.stats.blurryFrames} blurry frames skipped</p>
            <p className="muted">{result.stats.clippedCards} clipped or unsuitable detections were skipped. Unseen baseline entries will be preserved. Every row starts unselected.</p>
            {result.stats.gapTimestamps.length > 0 && <details className="warning-text"><summary>Possible coverage gaps: {result.stats.gapTimestamps.length}</summary><p>No recognized card overlapped adjacent usable views at: {result.stats.gapTimestamps.map((time) => `${time.toFixed(1)}s`).join(', ')}. These are warnings, not proof that every other card was covered.</p></details>}
            <div className="button-row">
              <button type="button" disabled={busy} onClick={selectSuggestions}>Select consistent suggestions for review</button>
              <button type="button" disabled={busy} onClick={() => { setDecisions(new Map([...decisions].map(([key, value]) => [key, { ...value, selected: false }]))); setReviewed(false) }}>Clear selections</button>
              <button type="button" disabled={busy} onClick={() => { setResult(null); setDecisions(new Map()); setProgress({ fraction: 0, message: '' }) }}>Back to calibration</button>
            </div>
            <p className="muted">Selecting suggestions is not approval. Inspect the selected rows; capped counts, conflicts, unknown identities and decreases are excluded from that shortcut.</p>
            <div className="form-grid">
              <label>Filter<select value={filter} onChange={(event) => { setFilter(event.target.value); setPage(0) }}><option value="all">All rows</option><option value="attention">Needs attention</option><option value="selected">Selected rows</option></select></label>
              <label>Search cards<input value={search} onChange={(event) => { setSearch(event.target.value); setPage(0) }} placeholder="Name or card ID" /></label>
            </div>
          </section>
          <CardOptions />
          {visibleGroups.slice(shownPage * pageSize, (shownPage + 1) * pageSize).map((group) => {
            const decision = decisions.get(group.key)
            return decision ? <ReviewRow key={group.key} group={group} decision={decision} baseline={baseline} onChange={(value) => changeDecision(group.key, value)} /> : null
          })}
          <nav className="button-row pagination" aria-label="Review pages">
            <button type="button" disabled={shownPage === 0} onClick={() => setPage(shownPage - 1)}>Previous</button>
            <span>Page {shownPage + 1} of {lastPage + 1} · {visibleGroups.length} rows</span>
            <button type="button" disabled={shownPage === lastPage} onClick={() => setPage(shownPage + 1)}>Next</button>
          </nav>
          <section className="panel export-panel">
            <h2>Export confirmed data</h2>
            <label>Recorded at (confirm this; the file date is only a guess)<input type="datetime-local" value={recordedAt} onChange={(event) => { setRecordedAt(event.target.value); setFresh(false) }} /></label>
            <label className="check-label"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />I reviewed the selected card identities and exact owned quantities.</label>
            {baselineName && <label className="check-label"><input type="checkbox" checked={fresh} onChange={(event) => setFresh(event.target.checked)} />This recording is not older than the collection changes in my baseline CSV.</label>}
            <label className="check-label"><input type="checkbox" checked={includeImages} onChange={(event) => setIncludeImages(event.target.checked)} />Include evidence crops in the downloaded JSON (larger; keep private).</label>
            <div className="button-row">
              <button className="primary" type="button" disabled={busy || !reviewed || (Boolean(baselineName) && !fresh) || selectedCount === 0} onClick={() => { void exportResult('csv') }}>{baselineName ? 'Download merged CSV' : 'Download partial CSV'}</button>
              <button type="button" disabled={busy || !reviewed || (Boolean(baselineName) && !fresh) || selectedCount === 0} onClick={() => { void exportResult('changes') }}>Download selected changes only</button>
              <button type="button" disabled={busy || !reviewed || (Boolean(baselineName) && !fresh) || selectedCount === 0} onClick={() => { void exportResult('json') }}>Download JSON audit</button>
            </div>
            <p className="muted">Nothing is uploaded or applied automatically. Keep your original CSV. “Selected changes only” is safest when importing into a tracker that may contain newer, unrelated changes.</p>
          </section>
        </>
      )}
      <footer>English card references · fixed grid layout · no account access · closing this page discards the in-memory review</footer>
    </main>
  )
}
