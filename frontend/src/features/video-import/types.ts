/** Ownership keys deliberately follow CardsDB, not Pokémon names or artwork IDs. */
export interface CatalogCard {
  internal_id: number
  card_id: string
  name: string
  expansion: string
  pack: string
  rarity: string
}

export interface OwnedEntry {
  quantity: number
  collected: boolean
}

export type Snapshot = ReadonlyMap<number, OwnedEntry>

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** grid/card are normalized to the frame; badge is relative to an individual card. */
export interface LayoutProfile {
  version: 1
  frameAspect: number
  grid: Rect
  card: Rect
  badge: Rect
  polarity: 'dark' | 'light' | 'auto'
}

export type QuantityReading =
  | { kind: 'exact'; value: number; score: number }
  | { kind: 'at-least'; value: number; score: number }
  | { kind: 'unknown'; reason: string }

export interface Candidate {
  internalId: number
  similarity: number
}

export interface Observation {
  key: string
  timestamp: number
  fingerprint: string
  candidates: Candidate[]
  /** Null unless both similarity and distinct-identity margin pass the heuristic. */
  internalId: number | null
  quantity: QuantityReading
  cardImage: string
  badgeImage: string
}

export interface ReviewGroup {
  key: string
  internalId: number | null
  candidates: Candidate[]
  evidence: Observation[]
  sightings: number
  firstSeen: number
  lastSeen: number
  quantities: number[]
  hasUnknown: boolean
  hasLowerBound: boolean
  suggestedQuantity: number | null
}

export interface ReviewDecision {
  selected: boolean
  internalId: number | null
  quantity: string
  decreaseApproved: boolean
}

export interface ConfirmedUpdate {
  internalId: number
  quantity: number
  decreaseApproved: boolean
}

export interface ScanStats {
  sampled: number
  recognized: number
  duplicateFrames: number
  blurryFrames: number
  clippedCards: number
  gapTimestamps: number[]
  elapsedSeconds: number
}
