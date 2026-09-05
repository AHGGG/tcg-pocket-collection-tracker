// Synthetic UI fixtures only. Not a second application entry or a real collection.
import { Minus, Plus } from 'lucide-react'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ScanMatchCard, scanGridClass, scanPanelClass } from '../src/components/scanner/ScanPresentation'
import { Button } from '../src/components/ui/button'
import { ObservationStore } from '../src/features/video-import/reconcile'
import VideoImportPage from '../src/features/video-import/VideoImportPage'
import { allCards } from '../src/lib/CardsDB'
import type { VideoScanResult } from '../src/services/scanner/VideoScanService'
import '../src/index.css'

const cards = allCards.slice(0, 3).map((card, index) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="336" viewBox="0 0 240 336"><rect x="3" y="3" width="234" height="330" rx="12" fill="${['#a1bdaa', '#a8bbc5', '#c0ad9b'][index]}" stroke="#ddd" stroke-width="6"/><rect x="20" y="45" width="200" height="140" rx="4" fill="#36454f"/><text x="120" y="125" text-anchor="middle" fill="white" font-size="16">UI TEST CARD ${index + 1}</text><text x="20" y="28" font-family="sans-serif" font-size="15">${card.name}</text><path d="M20 215H180 M20 240H220 M20 265H150" stroke="#586568" stroke-width="6"/><text x="20" y="310" font-size="12">Synthetic test artwork</text></svg>`
  const imageUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`
  return { matchedCard: { card, similarity: 0.98 }, imageUrl, resolvedImageUrl: imageUrl, increment: 0 }
})
const observations = new ObservationStore()
for (const [index, match] of cards.entries()) {
  observations.add({
    key: String(index),
    timestamp: index,
    fingerprint: String(index),
    internalId: match.matchedCard.card.internal_id,
    candidates: [{ internalId: match.matchedCard.card.internal_id, similarity: 0.98 }],
    quantity: index === 2 ? { kind: 'unknown', reason: 'Synthetic unreadable tab' } : { kind: 'exact', value: index + 3, score: 0.99 },
    cardImage: match.imageUrl,
    badgeImage: '',
  })
}
const result: VideoScanResult = { cards, groups: observations.values(), sampled: 3, duration: 1.5 }
const scanner = async () => result

function ImagePresentation() {
  const [increments, setIncrements] = useState(cards.map(() => 1))
  return (
    <div className={scanPanelClass}>
      <h2 className="text-center text-xl">Found 3 cards</h2>
      <p className="text-center text-sm text-neutral-400 px-2">
        Select the increment amount for the matched cards. Click the image to quickly exclude or include a card.
      </p>
      <div className={scanGridClass} data-scan-results>
        {cards.map((match, index) => {
          const change = (value: number) => setIncrements((previous) => previous.map((increment, i) => (i === index ? value : increment)))
          return (
            <ScanMatchCard
              key={match.matchedCard.card.internal_id}
              selected={increments[index] !== 0}
              tone={increments[index] < 0 ? 'decrease' : 'increase'}
              title={<span className="flex rounded pl-1">{match.matchedCard.card.name}</span>}
              controls={
                <>
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => change(increments[index] - 1)}>
                    <Minus />
                  </Button>
                  <span className="min-w-8 text-center font-semibold">+{increments[index]}</span>
                  <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => change(increments[index] + 1)}>
                    <Plus />
                  </Button>
                </>
              }
              extractedImage={match.imageUrl}
              referenceImage={match.resolvedImageUrl}
              extractedLabel="Extracted Card"
              referenceLabel="98% match"
              toggleLabel="Toggle image match"
              onToggle={() => change(increments[index] ? 0 : 1)}
            />
          )
        })}
      </div>
      <Button className="mx-auto w-full sm:w-60">Update selected cards</Button>
      <Button variant="outline" className="mx-auto w-full sm:w-60">
        Scan more
      </Button>
    </div>
  )
}
const root = document.getElementById('root')
if (!root) {
  throw new Error('Missing test root')
}
const mode = new URLSearchParams(location.search).get('mode')
createRoot(root).render(
  <main className="p-1 sm:p-2 mt-4">
    {mode === 'image' ? (
      <ImagePresentation />
    ) : mode === 'embedded' ? (
      <div className={scanPanelClass}>
        <VideoImportPage scanner={scanner} embedded onApply={async () => {}} />
      </div>
    ) : (
      <VideoImportPage scanner={scanner} />
    )}
  </main>,
)
