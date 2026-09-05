import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { exportCsv, parseCsv, readBaseline } from '../../frontend/src/features/video-import/csv'
import { badgeRect, contains, makeProfile, toPixels, validateProfile, validateRect } from '../../frontend/src/features/video-import/geometry'
import { frameDifference, grayscale, segmentGlyphs, sharpness } from '../../frontend/src/features/video-import/pixels'
import { parseReading } from '../../frontend/src/features/video-import/quantity'
import { initialDecisions, ObservationStore } from '../../frontend/src/features/video-import/reconcile'
import { catalogueFingerprint, makeReport } from '../../frontend/src/features/video-import/report'
import { canonicalCards, mergeSnapshot, parseQuantity, selectedUpdates } from '../../frontend/src/features/video-import/snapshot'
import type { CatalogCard, Observation, OwnedEntry, ReviewDecision } from '../../frontend/src/features/video-import/types'
import { throwIfAborted } from '../../frontend/src/features/video-import/video'

// Entirely synthetic data. Never commit a user's collection CSV or recording.
const cards: CatalogCard[] = [
  { internal_id: 101, card_id: 'T1-1', name: 'Example, One', expansion: 'T1', pack: 'test', rarity: '◊' },
  { internal_id: 101, card_id: 'T2-1', name: 'Example, One', expansion: 'T2', pack: 'test', rarity: '◊' },
  { internal_id: 102, card_id: 'T1-2', name: 'Example, One', expansion: 'T1', pack: 'test', rarity: '☆' },
  { internal_id: 103, card_id: 'T1-3', name: 'Example "Three"\nwith newline', expansion: 'T1', pack: 'test', rarity: '◊' },
]
const validIds = new Set(cards.map((card) => card.internal_id))
const baseline = new Map<number, OwnedEntry>([
  [101, { quantity: 2, collected: true }],
  [102, { quantity: 4, collected: true }],
])
const update = (quantity = 3, internalId = 101, decreaseApproved = false) => ({ internalId, quantity, decreaseApproved })
const csv = (rows: string) => `Id,InternalId,NumberOwned,Collected\n${rows}`
const makeObservation = (value: number | null, index = 0, internalId: number | null = 101): Observation => ({
  key: `observation-${index}`,
  timestamp: index,
  fingerprint: 'synthetic-hash',
  internalId,
  candidates: [
    { internalId: 101, similarity: 0.95 },
    { internalId: 102, similarity: 0.7 },
  ],
  quantity: value === null ? { kind: 'unknown', reason: 'unreadable' } : { kind: 'exact', value, score: 0.99 },
  cardImage: 'data:image/png;base64,synthetic-card',
  badgeImage: 'data:image/png;base64,synthetic-badge',
})
const layout = makeProfile(
  { x: 0, y: 0.1, width: 1, height: 0.8 },
  { x: 0.1, y: 0.2, width: 0.2, height: 0.25 },
  { x: 0.15, y: 0.46, width: 0.08, height: 0.025 },
  0.5,
  'dark',
)

test('quantity parser accepts zero and positive integers', () => {
  assert.equal(parseQuantity('0'), 0)
  assert.equal(parseQuantity(' 12 '), 12)
  assert.equal(parseQuantity('0003'), 3)
  assert.equal(parseQuantity(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER)
})
for (const invalid of ['', ' ', '-1', '1.5', '1e3', 'NaN', 'Infinity', '99+', '+3', '1,000', '9007199254740992']) {
  test(`quantity parser rejects ${JSON.stringify(invalid)} instead of guessing`, () => assert.throws(() => parseQuantity(invalid)))
}
test('canonical ownership keys merge linked aliases, not names', () => {
  assert.equal(canonicalCards(cards).size, 3)
  assert.equal(canonicalCards(cards).get(101)?.card_id, 'T1-1')
})
test('snapshot replacement does not increment the baseline', () => {
  assert.equal(mergeSnapshot(baseline, [update()], validIds).get(101)?.quantity, 3)
  assert.equal(baseline.get(101)?.quantity, 2)
})
test('unseen baseline entries remain unchanged', () => {
  assert.deepEqual(mergeSnapshot(baseline, [update()], validIds).get(102), baseline.get(102))
})
test('twenty sightings and repeated imports are idempotent', () => {
  const once = mergeSnapshot(
    baseline,
    Array.from({ length: 20 }, () => update()),
    validIds,
  )
  const twice = mergeSnapshot(
    once,
    Array.from({ length: 20 }, () => update()),
    validIds,
  )
  assert.deepEqual(twice, once)
  assert.equal(twice.get(101)?.quantity, 3)
})
test('conflicting duplicate updates fail atomically', () => {
  assert.throws(() => mergeSnapshot(baseline, [update(3), update(8)], validIds), /disagree/)
  assert.equal(baseline.get(101)?.quantity, 2)
})
test('decrease requires explicit approval on every selected row', () => {
  assert.throws(() => mergeSnapshot(baseline, [update(1)], validIds), /decrease/)
  assert.equal(mergeSnapshot(baseline, [update(1, 101, true)], validIds).get(101)?.quantity, 1)
})
test('zero preserves historical Collected state', () => {
  assert.deepEqual(mergeSnapshot(baseline, [update(0, 101, true)], validIds).get(101), { quantity: 0, collected: true })
})
test('new positive entry sets Collected; an unobserved card is not created', () => {
  const next = mergeSnapshot(new Map(), [update(3)], validIds)
  assert.deepEqual(next.get(101), { quantity: 3, collected: true })
  assert.equal(next.has(102), false)
})
test('unknown catalogue IDs are rejected', () => assert.throws(() => mergeSnapshot(baseline, [update(3, 9999)], validIds), /Unknown/))
test('non-integer and unsafe numeric updates are rejected', () => {
  for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => mergeSnapshot(baseline, [update(value)], validIds))
  }
})
test('unselected unknown observations never become zero-valued updates', () => {
  const decisions = new Map<string, ReviewDecision>([['unknown', { selected: false, internalId: null, quantity: '', decreaseApproved: false }]])
  assert.deepEqual(selectedUpdates(decisions), [])
  decisions.set('unknown', { selected: true, internalId: null, quantity: '', decreaseApproved: false })
  assert.throws(() => selectedUpdates(decisions), /Choose a card/)
})
test('CSV parser supports BOM, CRLF, commas, quotes and embedded newlines', () => {
  assert.deepEqual(parseCsv('\uFEFFA,B\r\n"one, two","three ""quoted""\nlines"\r\n'), [
    ['A', 'B'],
    ['one, two', 'three "quoted"\nlines'],
  ])
})
test('empty trailing CSV lines are ignored', () =>
  assert.deepEqual(parseCsv('A,B\n1,2\n\n'), [
    ['A', 'B'],
    ['1', '2'],
  ]))
test('malformed CSV quotes are rejected', () => {
  for (const value of ['A\n"unterminated', 'A\nword"bad', 'A\n"closed"bad']) {
    assert.throws(() => parseCsv(value), /quot/)
  }
})
test('CSV blank counts are not parsed as zero', () => assert.throws(() => readBaseline(csv('T1-1,101,,TRUE'), cards), /Quantity/))
test('CSV non-exact counts are not silently normalized', () => assert.throws(() => readBaseline(csv('T1-1,101,99+,TRUE'), cards)))
test('Collected FALSE is parsed as false, not a truthy string', () => {
  assert.deepEqual(readBaseline(csv('T1-1,101,0,FALSE'), cards).entries.get(101), { quantity: 0, collected: false })
})
test('invalid Collected text is rejected', () => assert.throws(() => readBaseline(csv('T1-1,101,0,nope'), cards), /Collected/))
test('duplicate column names are rejected', () =>
  assert.throws(() => readBaseline('Id,Id,InternalId,NumberOwned,Collected\nT1-1,T1-1,101,0,FALSE', cards), /duplicate/))
test('missing required columns are rejected', () => assert.throws(() => readBaseline('Id,NumberOwned\nT1-1,3', cards), /Missing/))
test('incorrect row width is rejected', () => assert.throws(() => readBaseline(csv('T1-1,101,3,TRUE,extra'), cards), /columns/))
test('empty CSV is rejected', () => assert.throws(() => readBaseline('', cards), /no collection rows/))
test('unknown card IDs never disappear silently from a baseline', () => assert.throws(() => readBaseline(csv('NEW-1,999,3,TRUE'), cards), /Unknown card/))
test('stable card ID remaps an outdated internal ID with a warning', () => {
  const parsed = readBaseline(csv('T1-1,999,3,TRUE'), cards)
  assert.equal(parsed.entries.get(101)?.quantity, 3)
  assert.equal(parsed.entries.has(999), false)
  assert.equal(parsed.warnings.length, 1)
})
test('linked aliases with equal totals are deduplicated, not summed', () => {
  const parsed = readBaseline(csv('T1-1,101,3,TRUE\nT2-1,101,3,TRUE'), cards)
  assert.equal(parsed.entries.size, 1)
  assert.equal(parsed.entries.get(101)?.quantity, 3)
})
test('linked aliases with conflicting values require correction', () => {
  assert.throws(() => readBaseline(csv('T1-1,101,3,TRUE\nT2-1,101,2,TRUE'), cards), /Conflicting/)
  assert.throws(() => readBaseline(csv('T1-1,101,0,TRUE\nT2-1,101,0,FALSE'), cards), /Conflicting/)
})
test('CSV round trip preserves exact quantities and history flags', () => {
  const data = new Map<number, OwnedEntry>([
    [101, { quantity: 0, collected: true }],
    [102, { quantity: 0, collected: false }],
    [103, { quantity: 12, collected: true }],
  ])
  const text = exportCsv(data, cards)
  assert.deepEqual(readBaseline(text, cards).entries, data)
  assert.equal(parseCsv(text).length, 4)
  assert.match(text, /Id,CardName,InternalId,NumberOwned,Expansion,Pack,Rarity,Collected/)
})
test('partial export omits unknown/unobserved entries', () => {
  const rows = parseCsv(exportCsv(new Map([[101, { quantity: 3, collected: true }]]), cards))
  assert.equal(rows.length, 2)
  assert.equal(rows[1][0], 'T1-1')
})
test('spreadsheet-like catalogue strings are escaped on export', () => {
  const malicious = [{ ...cards[0], name: '=HYPERLINK("bad")' }]
  assert.ok(parseCsv(exportCsv(new Map([[101, { quantity: 1, collected: true }]]), malicious))[1][1].startsWith("'="))
})
test('CSV exporter rejects unknown keys and invalid quantities', () => {
  assert.throws(() => exportCsv(new Map([[999, { quantity: 1, collected: true }]]), cards))
  assert.throws(() => exportCsv(new Map([[101, { quantity: Number.NaN, collected: true }]]), cards))
})
test('rectangle validation rejects non-finite and clipped layouts', () => {
  assert.throws(() => validateRect({ x: 0, y: 0, width: Number.NaN, height: 1 }))
  assert.throws(() => validateRect({ x: 0.9, y: 0, width: 0.2, height: 1 }, true))
  assert.throws(() => validateProfile({ ...layout, version: 9 }))
  assert.throws(() => validateProfile({ ...layout, polarity: 'guess' }))
})
test('calibration maps the quantity strip relative to each detected card', () => {
  const actual = badgeRect(toPixels(layout.card, 1000, 2000), layout.badge)
  assert.ok(Math.abs(actual.x - 150) < 1e-8)
  assert.ok(Math.abs(actual.y - 920) < 1e-8)
  assert.ok(Math.abs(actual.width - 80) < 1e-8)
  assert.ok(Math.abs(actual.height - 50) < 1e-8)
})
test('quantity outside the recorded frame is rejected', () => {
  assert.throws(() => validateProfile({ ...layout, badge: { ...layout.badge, y: 100 } }))
  assert.equal(contains({ x: 0, y: 0, width: 10, height: 10 }, { x: 9, y: 9, width: 2, height: 2 }), false)
})
test('identical frames have zero difference; changed dimensions are not identical', () => {
  const image = { width: 3, height: 3, pixels: new Uint8Array(9) }
  assert.equal(frameDifference(image, image), 0)
  assert.equal(frameDifference(image, { width: 2, height: 2, pixels: new Uint8Array(4) }), Number.POSITIVE_INFINITY)
})
test('flat images have no sharpness or readable digits', () => {
  const image = { width: 16, height: 24, pixels: new Uint8Array(16 * 24).fill(128) }
  assert.equal(sharpness(image), 0)
  assert.deepEqual(segmentGlyphs(image, 'dark'), [])
  assert.deepEqual(segmentGlyphs(image, 'light'), [])
})
test('RGBA conversion validates dimensions', () => {
  assert.throws(() => grayscale(new Uint8Array(3), 1, 1))
  assert.equal(grayscale([255, 255, 255, 255], 1, 1).pixels[0], 255)
})
test('capped quantities remain lower bounds, not exact counts', () => {
  assert.deepEqual(parseReading('99+', 0.9), { kind: 'at-least', value: 99, score: 0.9 })
  assert.equal(parseReading('?', 0.9).kind, 'unknown')
})
test('20 observations of quantity 3 reconcile to one suggestion of 3', () => {
  const store = new ObservationStore()
  for (let i = 0; i < 20; i++) {
    store.add(makeObservation(3, i))
  }
  const [group] = store.values()
  assert.equal(store.values().length, 1)
  assert.equal(group.suggestedQuantity, 3)
  assert.equal(group.sightings, 20)
  assert.equal(group.evidence.length, 1)
  assert.equal(initialDecisions([group]).get(group.key)?.selected, false)
})
test('conflicting quantities are not resolved with maximum or majority', () => {
  const store = new ObservationStore()
  for (const [index, count] of [3, 3, 8].entries()) {
    store.add(makeObservation(count, index))
  }
  assert.equal(store.values()[0].suggestedQuantity, null)
  assert.deepEqual(store.values()[0].quantities, [3, 8])
  assert.equal(store.values()[0].evidence.length, 2)
})
test('unknown quantities do not become 1 or 0', () => {
  const store = new ObservationStore()
  store.add(makeObservation(null))
  const [group] = store.values()
  assert.equal(group.suggestedQuantity, null)
  assert.equal(initialDecisions([group]).get(group.key)?.quantity, '')
})
test('lower bound observations disable exact suggestions', () => {
  const store = new ObservationStore()
  store.add({ ...makeObservation(99), quantity: { kind: 'at-least', value: 99, score: 0.99 } })
  assert.equal(store.values()[0].hasLowerBound, true)
  assert.equal(store.values()[0].suggestedQuantity, null)
})
test('ambiguous card identity stays unresolved', () => {
  const store = new ObservationStore()
  store.add(makeObservation(3, 0, null))
  assert.equal(store.values()[0].internalId, null)
  assert.equal(initialDecisions(store.values()).values().next().value?.internalId, null)
})
test('evidence is bounded while conflicts remain explicit', () => {
  const store = new ObservationStore()
  for (let i = 0; i < 20; i++) {
    store.add(makeObservation(i, i))
  }
  assert.equal(store.values()[0].evidence.length, 4)
  assert.equal(store.values()[0].quantities.length, 20)
  assert.equal(store.values()[0].suggestedQuantity, null)
})
test('memory guard stops import rather than dropping evidence silently', () => {
  const store = new ObservationStore()
  assert.throws(() => store.add({ ...makeObservation(3), cardImage: 'x'.repeat(31_000_000) }), /memory limit/)
})
test('aborted work throws before it can export', () => {
  const controller = new AbortController()
  controller.abort()
  assert.throws(() => throwIfAborted(controller.signal), { name: 'AbortError' })
})
test('catalogue fingerprint is order-independent but changes on ID remapping', async () => {
  assert.equal(await catalogueFingerprint(cards), await catalogueFingerprint([...cards].reverse()))
  assert.notEqual(await catalogueFingerprint(cards), await catalogueFingerprint(cards.map((card) => ({ ...card, internal_id: card.internal_id + 1 }))))
})
test('JSON report preserves stable IDs and omits images by default', () => {
  const store = new ObservationStore()
  store.add(makeObservation(3))
  const groups = store.values()
  const decisions = initialDecisions(groups)
  decisions.set(groups[0].key, { selected: true, internalId: 101, quantity: '3', decreaseApproved: false })
  const options = {
    catalogueHash: 'test',
    cards,
    recording: { name: 'synthetic.mp4', size: 123, duration: 2, recordedAt: '2026-01-01T00:00:00Z' },
    baselineName: 'synthetic.csv',
    profile: layout,
    stats: { sampled: 1, recognized: 1, duplicateFrames: 0, blurryFrames: 0, clippedCards: 0, gapTimestamps: [], elapsedSeconds: 1 },
    groups,
    decisions,
    snapshot: mergeSnapshot(baseline, [update()], validIds),
    includeImages: false,
  }
  const report = makeReport(options)
  assert.equal(report.completeCollectionVerified, false)
  assert.equal(JSON.stringify(report).includes('data:image'), false)
  assert.deepEqual(report.entries[0].cardIds, ['T1-1', 'T2-1'])
  assert.equal(report.entries.find((entry) => entry.internalId === 102)?.provenance, 'carried-forward-from-baseline')
  assert.equal(JSON.stringify(makeReport({ ...options, includeImages: true })).includes('data:image'), true)
})
test('standalone entry does not bootstrap account/session or telemetry code', () => {
  const root = process.cwd()
  const entry = readFileSync(`${root}/frontend/src/features/video-import/main.tsx`, 'utf8')
  const pipeline = readFileSync(`${root}/frontend/src/features/video-import/pipeline.ts`, 'utf8')
  assert.doesNotMatch(entry, /supabase|useCollection|analytics|App\.tsx/)
  assert.doesNotMatch(pipeline, /useUpdateCards|collectionService|increment:\s*1/)
})

test('edge-touching quantity glyphs are rejected instead of reading a clipped number', () => {
  const pixels = new Uint8Array(12 * 12).fill(255)
  for (let y = 2; y < 10; y++) {
    for (let x = 0; x < 4; x++) {
      pixels[y * 12 + x] = 0
    }
  }
  assert.deepEqual(segmentGlyphs({ width: 12, height: 12, pixels }, 'dark'), [])
})

test('a calibrated quantity outside the scrolling grid is rejected', () => {
  assert.throws(
    () =>
      makeProfile(
        { x: 0, y: 0.1, width: 1, height: 0.5 },
        { x: 0.1, y: 0.2, width: 0.2, height: 0.25 },
        { x: 0.15, y: 0.7, width: 0.08, height: 0.025 },
        0.5,
        'dark',
      ),
    /collection area/,
  )
})
