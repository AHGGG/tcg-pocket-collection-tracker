import assert from 'node:assert/strict'
import test from 'node:test'
import { exportCsv, readBaseline } from '../../frontend/src/features/video-import/csv'
import { initialVideoDecisions, quantityProvenance, resolveDefaultQuantity } from '../../frontend/src/features/video-import/defaultQuantities'
import { ObservationStore } from '../../frontend/src/features/video-import/reconcile'
import { mergeSnapshot, selectedUpdates } from '../../frontend/src/features/video-import/snapshot'
import type { QuantityReading, ReviewDecision, Snapshot } from '../../frontend/src/features/video-import/types'

const catalogue = [{ internal_id: 101, card_id: 'T1-1', name: 'Test card', expansion: 'T1', pack: 'Test', rarity: '◊' }]
const empty: Snapshot = new Map()
const validIds = new Set([101, 102])
const unknown: QuantityReading = { kind: 'unknown', reason: 'Compact grid has no count badge' }
function groups(readings: QuantityReading[] = [unknown], internalId: number | null = 101) {
  const store = new ObservationStore()
  for (const [index, quantity] of readings.entries()) {
    store.add({
      key: String(index),
      timestamp: index / 2,
      fingerprint: 'test',
      internalId,
      quantity,
      candidates: [],
      cardImage: '',
      badgeImage: '',
    })
  }
  return store.values()
}

test('compact-grid card with no count defaults to one and is preselected', () => {
  const rows = initialVideoDecisions(groups(), empty)
  assert.deepEqual(rows.get('card:101'), { internalId: 101, quantity: '1', selected: true, decreaseApproved: false, quantitySource: 'default' })
  assert.equal(groups()[0].suggestedQuantity, null, 'do not relabel missing evidence as exact OCR')
})
test('20 badge-less sightings and rescanning still represent one card, not 20 copies', () => {
  const rows = initialVideoDecisions(groups(Array(20).fill(unknown)), empty)
  const first = mergeSnapshot(empty, selectedUpdates(rows), validIds)
  const second = mergeSnapshot(first, selectedUpdates(initialVideoDecisions(groups(), first)), validIds)
  assert.equal(first.get(101)?.quantity, 1)
  assert.deepEqual(second, first)
})
test('missing badge preserves known higher quantities and leaves unseen cards alone', () => {
  const baseline: Snapshot = new Map([
    [101, { quantity: 7, collected: true }],
    [102, { quantity: 9, collected: true }],
  ])
  const rows = initialVideoDecisions(groups(), baseline)
  const decision = rows.get('card:101') as ReviewDecision
  assert.equal(decision.quantity, '7')
  assert.equal(quantityProvenance(decision, baseline), 'existing')
  assert.deepEqual(mergeSnapshot(baseline, selectedUpdates(rows), validIds), baseline)
})
test('existing zero plus a detected owned card becomes at least one', () => {
  const rows = initialVideoDecisions(groups(), new Map([[101, { quantity: 0, collected: true }]]))
  assert.equal(rows.get('card:101')?.quantity, '1')
})
test('collection refresh during review cannot turn a default into a decrease', () => {
  const decision = initialVideoDecisions(groups(), empty).get('card:101') as ReviewDecision
  const latest: Snapshot = new Map([[101, { quantity: 12, collected: true }]])
  const resolved = resolveDefaultQuantity(decision, latest)
  assert.equal(resolved.quantity, '12')
  assert.equal(resolved.selected, true)
  assert.equal(decision.quantity, '1', 'resolution must not mutate state')
})
test('manual edits override defaulting, but still require approval for decreases', () => {
  const baseline: Snapshot = new Map([[101, { quantity: 7, collected: true }]])
  const decision = { ...(initialVideoDecisions(groups(), baseline).get('card:101') as ReviewDecision), quantity: '2', quantitySource: 'manual' as const }
  assert.equal(resolveDefaultQuantity(decision, baseline).quantity, '2')
  assert.throws(() => mergeSnapshot(baseline, selectedUpdates(new Map([['a', decision]])), validIds), /decrease/)
})
test('readable quantities retain their exact value including zero', () => {
  for (const value of [0, 3, 12]) {
    const row = initialVideoDecisions(groups([{ kind: 'exact', value, score: 0.99 }]), empty).get('card:101') as ReviewDecision
    assert.equal(row.quantity, String(value))
    assert.equal(row.quantitySource, 'read')
    assert.equal(row.selected, true)
  }
})
test('unknown observations never dilute a later readable total', () => {
  const row = initialVideoDecisions(groups([unknown, { kind: 'exact', value: 4, score: 0.99 }, unknown]), empty).get('card:101') as ReviewDecision
  assert.equal(row.quantity, '4')
  assert.equal(row.quantitySource, 'read')
})
test('conflicts and capped counts stay excluded, not replaced by default one', () => {
  for (const readings of [
    [
      { kind: 'exact', value: 3, score: 0.99 },
      { kind: 'exact', value: 8, score: 0.99 },
    ],
    [{ kind: 'at-least', value: 99, score: 0.99 }, unknown],
  ] as QuantityReading[][]) {
    const row = initialVideoDecisions(groups(readings), empty).get('card:101') as ReviewDecision
    assert.equal(row.selected, false)
    assert.equal(row.quantity, '')
    assert.equal(row.quantitySource, undefined)
  }
})
test('unknown card identity is not made selectable by a default quantity', () => {
  const row = [...initialVideoDecisions(groups([unknown], null), empty).values()][0]
  assert.equal(row.selected, false)
  assert.equal(row.quantity, '')
})
test('reassigning a defaulted match recomputes the existing quantity for that identity', () => {
  const row = initialVideoDecisions(groups(), empty).get('card:101') as ReviewDecision
  const baseline: Snapshot = new Map([[102, { quantity: 5, collected: true }]])
  assert.equal(resolveDefaultQuantity({ ...row, internalId: 102 }, baseline).quantity, '5')
})
test('CSV includes provenance without breaking the existing required columns or round trip', () => {
  const rows = initialVideoDecisions(groups(), empty)
  const snapshot = mergeSnapshot(empty, selectedUpdates(rows), validIds)
  const text = exportCsv(snapshot, catalogue, new Map([[101, 'default-1']]))
  assert.match(text, /NumberOwned,Expansion,Pack,Rarity,Collected,QuantitySource/)
  assert.match(text, /default-1/)
  assert.deepEqual(readBaseline(text, catalogue).entries, snapshot)
  assert.doesNotMatch(exportCsv(snapshot, catalogue), /QuantitySource/, 'legacy callers keep their schema')
})
