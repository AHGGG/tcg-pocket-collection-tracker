import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { exportCsv, readBaseline } from '../../frontend/src/features/video-import/csv'
import { FrameCounts } from '../../frontend/src/features/video-import/frameCounts'
import { ObservationStore } from '../../frontend/src/features/video-import/reconcile'
import { mergeSnapshot } from '../../frontend/src/features/video-import/snapshot'

const identify = (match: { id: number; score: number }) => match

test('video counts a repeated card at most once within one sampled frame', () => {
  const counts = new FrameCounts(identify)
  counts.add(0, [
    { id: 101, score: 0.9 },
    { id: 101, score: 0.95 },
    { id: 102, score: 0.9 },
  ])
  assert.deepEqual(
    counts.values().map((entry) => [entry.sample.id, entry.count]),
    [
      [101, 1],
      [102, 1],
    ],
  )
  assert.equal(counts.values()[0].sample.score, 0.95)
})
test('diagnostic sightings count distinct frames but are not owned quantity', () => {
  const counts = new FrameCounts(identify)
  for (let frame = 0; frame < 20; frame++) {
    counts.add(frame, [
      { id: 101, score: 0.9 },
      { id: 101, score: 0.95 },
    ])
  }
  assert.equal(counts.values()[0].count, 20)
})
test('retrying the same frame ID does not add more copies', () => {
  const counts = new FrameCounts(identify)
  counts.add(1, [{ id: 101, score: 0.9 }])
  counts.add(1, [{ id: 101, score: 0.95 }])
  assert.equal(counts.values()[0].count, 1)
})
test('empty frames do not add counts and separate scan sessions do not share state', () => {
  const counts = new FrameCounts(identify)
  counts.add(0, [])
  assert.deepEqual(counts.values(), [])
  counts.add(1, [{ id: 101, score: 0.9 }])
  assert.deepEqual(new FrameCounts(identify).values(), [])
})
test('later lower-quality evidence increases the count without replacing the best image', () => {
  const counts = new FrameCounts(identify)
  counts.add(0, [{ id: 101, score: 0.99 }])
  counts.add(1, [{ id: 101, score: 0.9 }])
  assert.deepEqual(counts.values(), [{ sample: { id: 101, score: 0.99 }, count: 2 }])
})
test('invalid frame or match cannot poison an accumulator', () => {
  const counts = new FrameCounts(identify)
  assert.throws(() => counts.add(-1, []), /frame/)
  assert.throws(() => counts.add(0, [{ id: 101, score: NaN }]), /match/)
  counts.add(0, [{ id: 101, score: 0.99 }])
  assert.equal(counts.values()[0].count, 1)
})
test('automatic scan keeps owned totals and does not sum sightings', () => {
  const store = new ObservationStore()
  for (let i = 0; i < 20; i++) {
    store.add({
      key: String(i),
      timestamp: i,
      fingerprint: 'same',
      candidates: [],
      internalId: 101,
      quantity: { kind: 'exact', value: 3, score: 0.99 },
      cardImage: '',
      badgeImage: '',
    })
  }
  const group = store.values()[0]
  assert.equal(group.sightings, 20)
  assert.equal(group.suggestedQuantity, 3)
  const cards = [{ internal_id: 101, card_id: 'T1-1', name: 'Test', expansion: 'T1', rarity: 'x', pack: 'Test' }]
  const updates = [{ internalId: 101, quantity: group.suggestedQuantity as number, decreaseApproved: false }]
  const snapshot = mergeSnapshot(new Map(), updates, new Set([101]))
  const twice = mergeSnapshot(snapshot, updates, new Set([101]))
  assert.deepEqual(readBaseline(exportCsv(twice, cards), cards).entries, snapshot)
})
test('automatic scan keeps conflicting or unreadable badge counts unresolved', () => {
  const store = new ObservationStore()
  for (const value of [3, 8]) {
    store.add({
      key: String(value),
      timestamp: value,
      fingerprint: 'same',
      candidates: [],
      internalId: 101,
      quantity: { kind: 'exact', value, score: 0.99 },
      cardImage: '',
      badgeImage: '',
    })
  }
  assert.equal(store.values()[0].suggestedQuantity, null)
})
test('main image scanner retains image extraction and adds the shared automatic video flow', () => {
  const code = readFileSync('frontend/src/pages/scan/Scan.tsx', 'utf8')
  assert.match(code, /accept="image\/\*" multiple/)
  assert.match(code, /detectImages\(model, imageFiles\)/)
  assert.match(code, /extractCardImages\(imageFile, detectionResults\[i\]/)
  assert.match(code, /<VideoImportPage/)
  assert.match(code, /amount_owned: entry.quantity|amount_owned:entry.quantity/)
  assert.doesNotMatch(code, /makeProfile|Calibration|exampleQuantity/)
})
test('standalone scan has no calibration or mandatory baseline setup', () => {
  const code = readFileSync('frontend/src/features/video-import/VideoImportPage.tsx', 'utf8')
  assert.match(code, /<VideoScanControls/)
  assert.doesNotMatch(code, /<Calibration|loadBaseline|setExampleQuantity|readBaseline|useCollection/)
})

test('image and video share the same result layout and tile component', () => {
  for (const file of ['frontend/src/pages/scan/Scan.tsx', 'frontend/src/features/video-import/VideoImportPage.tsx']) {
    assert.match(readFileSync(file, 'utf8'), /scanGridClass/)
    assert.match(readFileSync(file, 'utf8'), /scanPanelClass/)
  }
  for (const file of ['frontend/src/pages/scan/Scan.tsx', 'frontend/src/features/video-import/ReviewRow.tsx']) {
    assert.match(readFileSync(file, 'utf8'), /<ScanMatchCard/)
  }
  const entry = readFileSync('frontend/src/features/video-import/main.tsx', 'utf8')
  assert.match(entry, /index\.css/)
  assert.doesNotMatch(entry, /video-import\.css/)
  assert.match(readFileSync('frontend/vite.video-import.config.ts', 'utf8'), /tailwindcss\(\)/)
})
