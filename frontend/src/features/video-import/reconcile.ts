import type { Observation, ReviewDecision, ReviewGroup } from './types'

function quantitySignature(observation: Observation): string {
  const quantity = observation.quantity
  return quantity.kind === 'unknown' ? 'unknown' : `${quantity.kind}:${quantity.value}`
}

/** Bounded evidence, no automatic collection writes and no majority/max-count guessing. */
export class ObservationStore {
  private groups = new Map<string, ReviewGroup>()
  private evidenceBytes = 0

  add(observation: Observation): void {
    const key = observation.internalId === null ? `unknown:${observation.fingerprint}` : `card:${observation.internalId}`
    let group = this.groups.get(key)
    if (!group) {
      if (this.groups.size >= 5000) {
        throw new Error('Too many distinct detections. Use a shorter recording or import one expansion at a time.')
      }
      group = {
        key,
        internalId: observation.internalId,
        candidates: observation.candidates,
        evidence: [],
        sightings: 0,
        firstSeen: observation.timestamp,
        lastSeen: observation.timestamp,
        quantities: [],
        hasUnknown: false,
        hasLowerBound: false,
        suggestedQuantity: null,
      }
      this.groups.set(key, group)
    }
    group.sightings++
    group.lastSeen = observation.timestamp
    const quantity = observation.quantity
    if (quantity.kind === 'exact' && !group.quantities.includes(quantity.value)) {
      group.quantities.push(quantity.value)
    }
    group.hasUnknown ||= quantity.kind === 'unknown'
    group.hasLowerBound ||= quantity.kind === 'at-least'
    group.suggestedQuantity = group.quantities.length === 1 && !group.hasLowerBound ? group.quantities[0] : null

    const signature = quantitySignature(observation)
    const duplicate = group.evidence.some((item) => quantitySignature(item) === signature)
    if (!duplicate) {
      // Keep first and recent conflicting readings. All distinct exact values remain above.
      if (group.evidence.length === 4) {
        const removed = group.evidence.splice(1, 1)[0]
        this.evidenceBytes -= (removed.cardImage.length + removed.badgeImage.length) * 2
      }
      const bytes = (observation.cardImage.length + observation.badgeImage.length) * 2
      if (this.evidenceBytes + bytes > 60_000_000) {
        throw new Error('Evidence memory limit reached. Use shorter recordings; no collection changes have been made.')
      }
      this.evidenceBytes += bytes
      group.evidence.push(observation)
    }
  }

  values(): ReviewGroup[] {
    return [...this.groups.values()]
  }
}

export function initialDecisions(groups: readonly ReviewGroup[]): Map<string, ReviewDecision> {
  return new Map(
    groups.map((group) => [
      group.key,
      {
        selected: false,
        internalId: group.internalId,
        quantity: group.suggestedQuantity === null ? '' : String(group.suggestedQuantity),
        decreaseApproved: false,
      },
    ]),
  )
}
