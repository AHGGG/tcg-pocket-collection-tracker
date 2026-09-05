import type { CatalogCard, ConfirmedUpdate, OwnedEntry, ReviewDecision, Snapshot } from './types'

export function parseQuantity(value: string): number {
  const text = value.trim()
  if (!/^\d+$/.test(text)) {
    throw new Error('Quantity must be an exact, non-negative whole number. Blank and 99+ are not exact quantities.')
  }
  const quantity = Number(text)
  if (!Number.isSafeInteger(quantity)) {
    throw new Error('Quantity is outside the supported integer range.')
  }
  return quantity
}

export function canonicalCards(cards: readonly CatalogCard[]): Map<number, CatalogCard> {
  const result = new Map<number, CatalogCard>()
  for (const card of cards) {
    if (!result.has(card.internal_id)) {
      result.set(card.internal_id, card)
    }
  }
  return result
}

export function selectedUpdates(decisions: ReadonlyMap<string, ReviewDecision>): ConfirmedUpdate[] {
  const result: ConfirmedUpdate[] = []
  for (const [key, decision] of decisions) {
    if (!decision.selected) {
      continue
    }
    if (decision.internalId === null) {
      throw new Error(`Choose a card for selected row ${key}.`)
    }
    result.push({
      internalId: decision.internalId,
      quantity: parseQuantity(decision.quantity),
      decreaseApproved: decision.decreaseApproved,
    })
  }
  return result
}

/** Pure, transactional and idempotent. Missing observations never become zero. */
export function mergeSnapshot(baseline: Snapshot, updates: readonly ConfirmedUpdate[], validIds: ReadonlySet<number>): Map<number, OwnedEntry> {
  const unique = new Map<number, ConfirmedUpdate>()
  for (const update of updates) {
    if (!validIds.has(update.internalId)) {
      throw new Error(`Unknown catalogue ID: ${update.internalId}`)
    }
    if (!Number.isSafeInteger(update.quantity) || update.quantity < 0) {
      throw new Error(`Invalid quantity for ${update.internalId}`)
    }
    const previous = baseline.get(update.internalId)
    if (previous && update.quantity < previous.quantity && !update.decreaseApproved) {
      throw new Error(`Approve the quantity decrease for ${update.internalId} before exporting.`)
    }
    const duplicate = unique.get(update.internalId)
    if (duplicate && duplicate.quantity !== update.quantity) {
      throw new Error(`Two selected rows disagree about ${update.internalId}. Correct one or deselect it.`)
    }
    unique.set(update.internalId, update)
  }
  const result = new Map(baseline)
  for (const update of unique.values()) {
    result.set(update.internalId, {
      quantity: update.quantity,
      collected: (baseline.get(update.internalId)?.collected ?? false) || update.quantity > 0,
    })
  }
  return result
}
