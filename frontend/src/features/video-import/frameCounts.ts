/** One sighting per card per sampled frame. Diagnostic counts are NEVER owned quantities. */
export class FrameCounts<T> {
  private seen = new Set<number>()
  private cards = new Map<number, { sample: T; count: number; score: number }>()

  constructor(private identify: (match: T) => { id: number; score: number }) {}

  add(frame: number, matches: readonly T[]): void {
    if (!Number.isSafeInteger(frame) || frame < 0) {
      throw new Error('Invalid sampled frame index.')
    }
    if (this.seen.has(frame)) {
      return
    }
    const unique = new Map<number, { sample: T; score: number }>()
    for (const sample of matches) {
      const { id, score } = this.identify(sample)
      if (!Number.isSafeInteger(id) || !Number.isFinite(score)) {
        throw new Error('Invalid card match.')
      }
      const previous = unique.get(id)
      if (!previous || score > previous.score) {
        unique.set(id, { sample, score })
      }
    }
    this.seen.add(frame)
    for (const [id, match] of unique) {
      const previous = this.cards.get(id)
      const best = previous && previous.score > match.score ? previous : match
      this.cards.set(id, { sample: best.sample, score: best.score, count: (previous?.count ?? 0) + 1 })
    }
  }

  values(): { sample: T; count: number }[] {
    return [...this.cards.values()].map(({ sample, count }) => ({ sample, count }))
  }
}
