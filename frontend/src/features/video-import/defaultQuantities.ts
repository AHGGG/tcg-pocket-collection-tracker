import { initialDecisions } from './reconcile'
import type { ReviewDecision, ReviewGroup, Snapshot } from './types'

/** Resolve against the latest collection so an inferred 1 never reduces a known total. */
export function resolveDefaultQuantity(decision: ReviewDecision, baseline: Snapshot): ReviewDecision {
  if (decision.quantitySource !== 'default' || decision.internalId === null) {
    return decision
  }
  return { ...decision, quantity: String(Math.max(1, baseline.get(decision.internalId)?.quantity ?? 0)) }
}

/** Compact views hide count badges. Default each matched ownership ID once, never each frame. */
export function initialVideoDecisions(groups: readonly ReviewGroup[], baseline: Snapshot): Map<string, ReviewDecision> {
  const decisions = initialDecisions(groups)
  for (const group of groups) {
    let decision = decisions.get(group.key) as ReviewDecision
    if (group.internalId !== null && group.quantities.length === 0 && !group.hasLowerBound) {
      decision = resolveDefaultQuantity({ ...decision, quantity: '1', quantitySource: 'default' }, baseline)
    } else if (group.suggestedQuantity !== null) {
      decision.quantitySource = 'read'
    }
    const previous = decision.internalId === null ? undefined : baseline.get(decision.internalId)
    decision.selected = decision.internalId !== null && decision.quantity !== '' && (!previous || Number(decision.quantity) >= previous.quantity)
    decisions.set(group.key, decision)
  }
  return decisions
}

export function quantityProvenance(decision: ReviewDecision, baseline: Snapshot): string {
  if (decision.quantitySource === 'default') {
    return decision.internalId !== null && (baseline.get(decision.internalId)?.quantity ?? 0) >= 1 ? 'existing' : 'default-1'
  }
  return decision.quantitySource ?? 'manual'
}
