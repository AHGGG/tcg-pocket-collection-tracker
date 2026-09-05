import { SquareCheck, SquareX } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '@/lib/utils'

// Shared by image scanning and both video entry points. Keep the original scan layout.
export const scanPanelClass = 'flex flex-col mx-auto max-w-[900px] p-1 sm:p-2 gap-2 rounded-lg border-1 border-neutral-700 border-solid'
export const scanGridClass = 'grid md:grid-cols-3 sm:grid-cols-2 grid-cols-1 gap-2 my-2'
export const scanActionClass = 'mx-auto w-full sm:w-60'

export function ScanUploadPanel({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-center justify-center p-6 border-2 border-dashed rounded-md">{children}</div>
}

function ScanPreview({ src, alt }: { src?: string; alt: string }) {
  const [failedSource, setFailedSource] = useState<string>()
  return src && src !== failedSource ? (
    <img src={src} alt={alt} className="w-full h-auto object-contain" loading="lazy" onError={() => setFailedSource(src)} />
  ) : (
    <div
      className="flex min-h-32 flex-1 items-center justify-center rounded bg-neutral-800 p-2 text-center text-xs text-neutral-400"
      role="img"
      aria-label={alt}
    >
      Preview unavailable
    </div>
  )
}

/** Presentation only: callers retain their own increment vs. ownership-total semantics. */
export function ScanMatchCard({
  title,
  controls,
  selected,
  tone,
  extractedImage,
  referenceImage,
  extractedLabel,
  referenceLabel,
  toggleLabel,
  onToggle,
  toggleDisabled = false,
  children,
}: {
  title: ReactNode
  controls: ReactNode
  selected: boolean
  tone?: 'increase' | 'decrease' | 'unresolved'
  extractedImage?: string
  referenceImage?: string
  extractedLabel: string
  referenceLabel: string
  toggleLabel: string
  onToggle: () => void
  toggleDisabled?: boolean
  children?: ReactNode
}) {
  return (
    <article
      data-scan-card
      className={cn(
        'border-3 rounded-lg p-2 min-w-0',
        selected && 'border-green-400',
        selected && tone === 'decrease' && 'border-red-400',
        !selected && tone === 'unresolved' && 'border-amber-500/60',
      )}
    >
      <h3 className="flex mb-2 items-start min-w-0">
        {selected ? <SquareCheck className="shrink-0" aria-hidden="true" /> : <SquareX className="shrink-0" aria-hidden="true" />}
        {title}
      </h3>
      <div className="flex items-center gap-1 mb-2">{controls}</div>
      <button
        type="button"
        aria-label={toggleLabel}
        aria-pressed={selected}
        disabled={toggleDisabled}
        className={cn(
          'flex w-full cursor-pointer gap-2 transition-all duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-300 disabled:cursor-default',
          !selected && 'grayscale',
        )}
        onClick={onToggle}
      >
        <div className="w-1/2 flex flex-col gap-1 justify-between">
          <ScanPreview src={extractedImage} alt="Detected card" />
          <div className="bg-gray-500 text-white text-xs px-1 py-0.5 text-center">{extractedLabel}</div>
        </div>
        <div className="w-1/2 flex flex-col gap-1 justify-between">
          <ScanPreview src={referenceImage} alt="Best match" />
          <div className="bg-green-600 text-white text-xs px-1 py-0.5 text-center">{referenceLabel}</div>
        </div>
      </button>
      {children}
    </article>
  )
}
