import { Minus, Plus } from 'lucide-react'
import { useId, useState } from 'react'
import { ScanMatchCard } from '@/components/scanner/ScanPresentation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { allCards, getCardById, getCardByInternalId } from '@/lib/CardsDB'
import { getLocalizedImagePath } from '@/lib/imageLocales'
import { getCardNameByLang } from '@/lib/utils'
import type { ExtractedCard } from '@/services/scanner/CardDetectionService'
import { resolveDefaultQuantity } from './defaultQuantities'
import { parseQuantity } from './snapshot'
import type { ReviewDecision, ReviewGroup, Snapshot } from './types'

export function ReviewRow({
  group,
  decision,
  baseline,
  onChange,
  match,
  language = 'en-US',
}: {
  group: ReviewGroup
  decision: ReviewDecision
  baseline: Snapshot
  onChange: (decision: ReviewDecision) => void
  match?: ExtractedCard
  language?: string
}) {
  const card = decision.internalId === null ? undefined : getCardByInternalId(decision.internalId)
  const [idText, setIdText] = useState(card?.card_id ?? '')
  const quantityId = useId()
  const cardInputId = useId()
  const previous = card ? baseline.get(card.internal_id) : undefined
  let quantity: number | null = null
  try {
    quantity = parseQuantity(decision.quantity)
  } catch {
    /* Unknown stays unknown. */
  }
  const decreases = previous !== undefined && quantity !== null && quantity < previous.quantity
  const canSelect = !!card && quantity !== null
  const name = card ? getCardNameByLang(card, language) : 'Unresolved card'
  const observation = group.evidence.find((item) => item.quantity.kind === 'exact' && item.quantity.value === quantity) ?? group.evidence[0]
  const similarity =
    card?.internal_id === match?.matchedCard.card.internal_id
      ? match?.matchedCard.similarity
      : group.candidates.find((item) => item.internalId === card?.internal_id)?.similarity
  const reference = card
    ? card.internal_id === match?.matchedCard.card.internal_id
      ? match.resolvedImageUrl
      : `${import.meta.env.BASE_URL}${getLocalizedImagePath(card, language).slice(1)}`
    : undefined
  const updateQuantity = (value: string) => {
    let valid = false
    try {
      parseQuantity(value)
      valid = true
    } catch {
      /* Invalid input is not an update. */
    }
    onChange({ ...decision, quantity: value, quantitySource: 'manual', selected: !!card && valid, decreaseApproved: false })
  }
  const chooseCard = (internalId: number) => {
    setIdText(getCardByInternalId(internalId)?.card_id ?? '')
    onChange(resolveDefaultQuantity({ ...decision, internalId, selected: false, decreaseApproved: false }, baseline))
  }
  return (
    <ScanMatchCard
      selected={decision.selected}
      tone={decreases ? 'decrease' : !canSelect ? 'unresolved' : 'increase'}
      title={
        <span className="flex flex-1 min-w-0 rounded pl-1">
          <span className="mr-auto break-words">{name}</span>
          {quantity !== null && (
            <span className="text-neutral-400 ml-1 mr-2 whitespace-nowrap">
              {previous ? `×${previous.quantity} → ` : ''}×{quantity}
            </span>
          )}
        </span>
      }
      controls={
        <>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            aria-label={`Decrease owned quantity for ${name}`}
            disabled={quantity === null || quantity === 0}
            onClick={() => quantity !== null && updateQuantity(String(quantity - 1))}
          >
            <Minus className="h-4 w-4" />
          </Button>
          <label className="sr-only" htmlFor={quantityId}>
            Owned quantity for {name}
          </label>
          <Input
            id={quantityId}
            type="text"
            inputMode="numeric"
            className="h-8 w-16 px-1 text-center font-semibold"
            placeholder="?"
            value={decision.quantity}
            onChange={(event) => updateQuantity(event.target.value)}
          />
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            aria-label={`Increase owned quantity for ${name}`}
            disabled={quantity === null || quantity >= Number.MAX_SAFE_INTEGER}
            onClick={() => quantity !== null && updateQuantity(String(quantity + 1))}
          >
            <Plus className="h-4 w-4" />
          </Button>
          <span className="ml-1 text-xs text-neutral-400">
            {decision.quantitySource === 'default' ? (previous && previous.quantity > 0 ? 'Existing total' : 'Default: 1') : 'Owned total'}
          </span>
        </>
      }
      extractedImage={observation?.cardImage || match?.imageUrl}
      referenceImage={reference}
      extractedLabel="Extracted Card"
      referenceLabel={similarity === undefined ? 'Catalogue reference' : `${Math.round(similarity * 100)}% match`}
      toggleLabel={`${decision.selected ? 'Exclude' : 'Include'} ${name}`}
      toggleDisabled={!canSelect}
      onToggle={() => onChange({ ...decision, selected: !decision.selected })}
    >
      {decision.quantitySource === 'default' && (
        <p className="mt-2 text-xs text-neutral-400">
          {previous && previous.quantity > 0 ? 'No readable count. Keeping your existing quantity.' : 'No readable count. Defaulted to 1; adjust if needed.'}
        </p>
      )}
      {!canSelect && (
        <p className="mt-2 text-xs text-amber-300">
          {card ? 'Resolve the quantity below, or leave this card excluded.' : 'Choose the correct card below to include it.'}
        </p>
      )}
      {group.quantities.length > 1 && <p className="mt-2 text-xs text-amber-300">Conflicting readings: {group.quantities.join(', ')}. Check the quantity.</p>}
      {group.hasLowerBound && <p className="mt-2 text-xs text-amber-300">A capped count was seen. Enter a verified exact total.</p>}
      {decreases && (
        <label className="mt-2 flex items-start gap-2 text-xs text-amber-300">
          <input
            type="checkbox"
            className="mt-0.5 accent-neutral-300"
            checked={decision.decreaseApproved}
            onChange={(event) => onChange({ ...decision, selected: event.target.checked || decision.selected, decreaseApproved: event.target.checked })}
          />
          I verified this decrease from {previous.quantity} to {decision.quantity}.
        </label>
      )}
      <details className="mt-3 text-xs text-neutral-400" open={group.internalId === null ? true : undefined}>
        <summary className="cursor-pointer py-1 focus-visible:outline-2">Change card / view evidence</summary>
        <div className="flex flex-col gap-2 mt-2">
          <label htmlFor={cardInputId}>
            Card ID
            <Input
              id={cardInputId}
              list="video-import-card-options"
              value={idText}
              placeholder="For example: B3-1"
              onChange={(event) => {
                const value = event.target.value
                setIdText(value)
                onChange(
                  resolveDefaultQuantity(
                    { ...decision, internalId: getCardById(value.trim())?.internal_id ?? null, selected: false, decreaseApproved: false },
                    baseline,
                  ),
                )
              }}
            />
          </label>
          <div className="flex flex-col gap-1">
            {group.candidates.map((candidate) => {
              const alternate = getCardByInternalId(candidate.internalId)
              return alternate ? (
                <Button
                  key={candidate.internalId}
                  variant="outline"
                  size="sm"
                  className="h-auto min-h-8 whitespace-normal justify-start text-left"
                  onClick={() => chooseCard(candidate.internalId)}
                >
                  {alternate.card_id} · {getCardNameByLang(alternate, language)}
                </Button>
              ) : null
            })}
          </div>
          <p>
            {group.firstSeen.toFixed(1)}–{group.lastSeen.toFixed(1)}s · {group.sightings} sightings, not copies.
          </p>
          <div className="flex gap-2 overflow-x-auto">
            {group.evidence.map((item) => (
              <figure key={item.key} className="min-w-20">
                <div className="flex h-10 items-center justify-center">
                  {item.badgeImage && (
                    <img
                      className="max-h-10 max-w-24 object-contain"
                      src={item.badgeImage}
                      alt={`Quantity at ${item.timestamp.toFixed(1)} seconds`}
                      loading="lazy"
                    />
                  )}
                </div>
                <figcaption>
                  {item.timestamp.toFixed(1)}s:{' '}
                  {item.quantity.kind === 'unknown' ? 'unreadable' : `${item.quantity.value}${item.quantity.kind === 'at-least' ? '+' : ''}`}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </details>
    </ScanMatchCard>
  )
}

export function CardOptions() {
  return (
    <datalist id="video-import-card-options">
      {allCards.map((card) => (
        <option key={card.card_id} value={card.card_id}>
          {card.name} · {card.rarity}
        </option>
      ))}
    </datalist>
  )
}
