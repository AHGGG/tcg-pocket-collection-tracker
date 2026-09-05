import type { CatalogCard, LayoutProfile, ReviewDecision, ReviewGroup, ScanStats, Snapshot } from './types'

export async function catalogueFingerprint(cards: readonly CatalogCard[]): Promise<string> {
  const data = cards.map((card) => `${card.card_id}:${card.internal_id}:${card.rarity}`).sort().join('\n')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export function makeReport(options: {
  catalogueHash: string
  cards: readonly CatalogCard[]
  recording: { name: string; size: number; duration: number; recordedAt: string }
  baselineName: string | null
  profile: LayoutProfile
  stats: ScanStats
  groups: readonly ReviewGroup[]
  decisions: ReadonlyMap<string, ReviewDecision>
  snapshot: Snapshot
  includeImages: boolean
}) {
  const { groups, decisions, snapshot, includeImages, cards, ...metadata } = options
  const aliases = new Map<number, string[]>()
  for (const card of cards) {
    const ids = aliases.get(card.internal_id) ?? []
    ids.push(card.card_id)
    aliases.set(card.internal_id, ids)
  }
  const observedIds = new Set(groups.flatMap((group) => (group.internalId === null ? [] : [group.internalId])))
  const confirmedIds = new Set([...decisions.values()].filter((item) => item.selected && item.internalId !== null).map((item) => item.internalId))
  return {
    schemaVersion: 1,
    kind: options.baselineName ? 'merged-collection-snapshot' : 'partial-collection-snapshot',
    exportedAt: new Date().toISOString(),
    ...metadata,
    completeCollectionVerified: false,
    entries: [...snapshot].map(([internalId, entry]) => ({
      internalId,
      cardIds: aliases.get(internalId) ?? [],
      ...entry,
      provenance: confirmedIds.has(internalId) ? 'confirmed-in-this-import' : 'carried-forward-from-baseline',
      observed: observedIds.has(internalId) || confirmedIds.has(internalId),
    })),
    review: groups.map((group) => ({
      ...group,
      decision: decisions.get(group.key) ?? null,
      evidence: group.evidence.map(({ cardImage, badgeImage, ...observation }) => ({
        ...observation,
        ...(includeImages ? { cardImage, badgeImage } : {}),
      })),
    })),
  }
}

export function downloadText(filename: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Delay revocation so the browser's download handoff can finish.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
