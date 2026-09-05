import type { LayoutProfile, Rect } from './types'

export function validateRect(value: unknown, normalized = false): Rect {
  if (!value || typeof value !== 'object') {
    throw new Error('A rectangle is required.')
  }
  const rect = value as Rect
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw new Error('Rectangle dimensions must be finite and positive.')
  }
  if (normalized && (rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001)) {
    throw new Error('Rectangle must be inside the frame.')
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

export function contains(outer: Rect, inner: Rect, tolerance = 0): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  )
}

export function toPixels(rect: Rect, width: number, height: number): Rect {
  return { x: rect.x * width, y: rect.y * height, width: rect.width * width, height: rect.height * height }
}

export function badgeRect(card: Rect, relative: Rect): Rect {
  return {
    x: card.x + relative.x * card.width,
    y: card.y + relative.y * card.height,
    width: relative.width * card.width,
    height: relative.height * card.height,
  }
}

export function makeProfile(grid: Rect, card: Rect, badge: Rect, frameAspect: number, polarity: LayoutProfile['polarity']): LayoutProfile {
  return validateProfile({
    version: 1,
    frameAspect,
    grid,
    card,
    badge: {
      x: (badge.x - card.x) / card.width,
      y: (badge.y - card.y) / card.height,
      width: badge.width / card.width,
      height: badge.height / card.height,
    },
    polarity,
  })
}

export function validateProfile(value: unknown): LayoutProfile {
  if (!value || typeof value !== 'object') {
    throw new Error('Invalid layout profile.')
  }
  const profile = value as LayoutProfile
  if (profile.version !== 1 || !Number.isFinite(profile.frameAspect) || profile.frameAspect < 0.2 || profile.frameAspect > 5) {
    throw new Error('Unsupported layout version or frame aspect ratio.')
  }
  if (!['dark', 'light', 'auto'].includes(profile.polarity)) {
    throw new Error('Invalid quantity text polarity.')
  }
  const grid = validateRect(profile.grid, true)
  const card = validateRect(profile.card, true)
  const badge = validateRect(profile.badge)
  if (!contains(grid, card) || card.width < 0.02 || card.height < 0.02) {
    throw new Error('Mark a complete card inside the collection area.')
  }
  if (Math.abs(badge.x) > 2 || Math.abs(badge.y) > 2 || badge.width > 2 || badge.height > 1) {
    throw new Error('Mark the quantity indicator belonging to the selected card, not another row.')
  }
  if (!contains(grid, badgeRect(card, badge))) {
    throw new Error('The quantity crop must be inside the collection area, away from fixed navigation bars.')
  }
  return { version: 1, frameAspect: profile.frameAspect, grid, card, badge, polarity: profile.polarity }
}
