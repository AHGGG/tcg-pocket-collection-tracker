import { useEffect, useRef, useState } from 'react'
import type { Rect } from './types'

export type RegionName = 'grid' | 'card' | 'badge'
export type Regions = Record<RegionName, Rect | null>
const labels: Record<RegionName, string> = { grid: 'Collection area', card: 'One complete card', badge: 'That card’s quantity digits' }
const colors: Record<RegionName, string> = { grid: '#65d6ad', card: '#f7cc68', badge: '#83b9ff' }

export function Calibration({ image, width, height, regions, onChange }: {
  image: string
  width: number
  height: number
  regions: Regions
  onChange: (regions: Regions) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const [active, setActive] = useState<RegionName>('grid')
  useEffect(() => {
    let canceled = false
    const img = new Image()
    img.onload = () => {
      const canvas = canvasRef.current
      if (canceled || !canvas) {
        return
      }
      const context = canvas.getContext('2d')
      if (!context) {
        return
      }
      context.drawImage(img, 0, 0, width, height)
      for (const name of ['grid', 'card', 'badge'] as const) {
        const rect = regions[name]
        if (!rect) {
          continue
        }
        context.strokeStyle = colors[name]
        context.lineWidth = Math.max(2, width / 250)
        context.strokeRect(rect.x * width, rect.y * height, rect.width * width, rect.height * height)
      }
    }
    img.src = image
    return () => { canceled = true }
  }, [image, width, height, regions])

  const position = (event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    }
  }
  return (
    <div className="calibration">
      <div className="button-row" aria-label="Region to mark">
        {(['grid', 'card', 'badge'] as const).map((name, index) => (
          <button key={name} type="button" aria-pressed={active === name} onClick={() => setActive(name)}>
            {index + 1}. {labels[name]} {regions[name] ? '✓' : ''}
          </button>
        ))}
      </div>
      <p id="calibration-help">Drag a rectangle for <strong>{labels[active].toLowerCase()}</strong>. For the quantity, leave margins and enough width for multi-digit counts and a trailing +. Exclude ×, icons and neighboring cards.</p>
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        aria-label="Recording frame with calibration rectangles"
        aria-describedby="calibration-help"
        onPointerDown={(event) => {
          if (event.button !== 0) {
            return
          }
          start.current = position(event)
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!start.current) {
            return
          }
          const point = position(event)
          onChange({ ...regions, [active]: {
            x: Math.min(start.current.x, point.x),
            y: Math.min(start.current.y, point.y),
            width: Math.max(0.001, Math.abs(point.x - start.current.x)),
            height: Math.max(0.001, Math.abs(point.y - start.current.y)),
          } })
        }}
        onPointerUp={(event) => {
          start.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
        onPointerCancel={() => { start.current = null }}
        onLostPointerCapture={() => { start.current = null }}
      />
      <details>
        <summary>Adjust {labels[active].toLowerCase()} with the keyboard</summary>
        <div className="coordinates">
          {(['x', 'y', 'width', 'height'] as const).map((coordinate) => (
            <label key={coordinate}>
              {coordinate} (0–1)
              <input
                type="number" min="0" max="1" step="0.001"
                value={regions[active]?.[coordinate] ?? ''}
                onChange={(event) => onChange({ ...regions, [active]: {
                  ...(regions[active] ?? { x: 0, y: 0, width: 0.1, height: 0.1 }),
                  [coordinate]: Number(event.target.value),
                } })}
              />
            </label>
          ))}
        </div>
      </details>
    </div>
  )
}
