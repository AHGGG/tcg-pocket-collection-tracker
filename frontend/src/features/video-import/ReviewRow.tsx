import { useState } from 'react'
import { allCards, getCardById, getCardByInternalId } from '@/lib/CardsDB'
import type { ReviewDecision, ReviewGroup, Snapshot } from './types'

export function ReviewRow({ group, decision, baseline, onChange }: {
  group: ReviewGroup
  decision: ReviewDecision
  baseline: Snapshot
  onChange: (decision: ReviewDecision) => void
}) {
  const card = decision.internalId === null ? undefined : getCardByInternalId(decision.internalId)
  const [idText, setIdText] = useState(card?.card_id ?? '')
  const previous = decision.internalId === null ? undefined : baseline.get(decision.internalId)
  const decreases = previous !== undefined && /^\d+$/.test(decision.quantity.trim()) && Number(decision.quantity) < previous.quantity
  const chooseCard = (internalId: number) => {
    setIdText(getCardByInternalId(internalId)?.card_id ?? '')
    onChange({ ...decision, internalId, decreaseApproved: false })
  }
  return (
    <article className={`review-row ${decision.selected ? 'selected' : ''}`}>
      <header>
        <label className="check-label">
          <input type="checkbox" checked={decision.selected} onChange={(event) => onChange({ ...decision, selected: event.target.checked })} />
          Include this row
        </label>
        <span className="muted">{group.firstSeen.toFixed(1)}–{group.lastSeen.toFixed(1)}s · {group.sightings} sighting(s), not copies</span>
      </header>
      <h3>{card ? `${card.card_id} · ${card.name}` : 'Unresolved card — choose the correct printing'}</h3>
      <div className="review-fields">
        <label>
          Card ID (or search the catalogue)
          <input
            list="video-import-card-options" value={idText} placeholder="For example: B3-1"
            onChange={(event) => {
              const value = event.target.value
              setIdText(value)
              const match = getCardById(value.trim())
              onChange({ ...decision, internalId: match?.internal_id ?? null, decreaseApproved: false })
            }}
          />
        </label>
        <label>
          Owned quantity — total, not an increment
          <input
            type="text" inputMode="numeric" value={decision.quantity} placeholder="Unknown"
            onChange={(event) => onChange({ ...decision, quantity: event.target.value, decreaseApproved: false })}
          />
        </label>
        <p>Baseline: <strong>{previous?.quantity ?? 'unknown'}</strong></p>
      </div>
      {group.internalId === null && <p className="warning-text">Card matching was ambiguous. Similarity is not a probability.</p>}
      {group.quantities.length > 1 && <p className="warning-text">Conflicting counts: {group.quantities.join(', ')}. Check the source; no count was chosen automatically.</p>}
      {group.hasLowerBound && <p className="warning-text">A capped count such as 99+ was seen. Enter an independently verified exact count or exclude this row.</p>}
      {group.hasUnknown && <p className="muted">At least one quantity observation was unreadable.</p>}
      {decreases && (
        <label className="check-label warning-text">
          <input type="checkbox" checked={decision.decreaseApproved} onChange={(event) => onChange({ ...decision, decreaseApproved: event.target.checked })} />
          I verified this decrease from {previous.quantity} to {decision.quantity}.
        </label>
      )}
      <div className="button-row candidates">
        {group.candidates.map((candidate) => {
          const match = getCardByInternalId(candidate.internalId)
          return match ? (
            <button key={candidate.internalId} type="button" onClick={() => chooseCard(candidate.internalId)}>
              {match.card_id} {match.name} · similarity {candidate.similarity.toFixed(3)}
            </button>
          ) : null
        })}
      </div>
      <div className="evidence-strip">
        {group.evidence.map((observation) => (
          <figure key={observation.key}>
            <img src={observation.cardImage} alt={`Observed card at ${observation.timestamp.toFixed(1)} seconds`} />
            <img className="badge-evidence" src={observation.badgeImage} alt="Original quantity crop" />
            <figcaption>
              {observation.timestamp.toFixed(1)}s: {observation.quantity.kind === 'unknown' ? 'unreadable' : `${observation.quantity.value}${observation.quantity.kind === 'at-least' ? '+' : ''}`}
            </figcaption>
          </figure>
        ))}
        {card && (
          <figure>
            <img src={`${import.meta.env.BASE_URL}images/en-US/${card.card_id}.webp`} alt={`Reference: ${card.name}, ${card.card_id}`} loading="lazy" />
            <figcaption>Catalogue reference</figcaption>
          </figure>
        )}
      </div>
    </article>
  )
}

export function CardOptions() {
  return <datalist id="video-import-card-options">{allCards.map((card) => <option key={card.card_id} value={card.card_id}>{card.name} · {card.rarity}</option>)}</datalist>
}
