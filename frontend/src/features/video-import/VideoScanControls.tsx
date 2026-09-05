import { type ReactNode, useId, useRef } from 'react'
import { Spinner } from '@/components/Spinner'
import { ScanUploadPanel } from '@/components/scanner/ScanPresentation'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { VideoScanProgress } from './scanFrames'

export function VideoScanControls({
  file,
  onFileChange,
  onScan,
  busy,
  onCancel,
  progress,
  imageAction,
}: {
  file: File | null
  onFileChange: (file: File | null) => void
  onScan: () => void
  busy: boolean
  onCancel: () => void
  progress: VideoScanProgress | null
  imageAction?: ReactNode
}) {
  const inputId = useId()
  const input = useRef<HTMLInputElement>(null)
  if (busy) {
    return (
      <Alert role="status" aria-live="polite">
        <AlertDescription className="flex flex-col gap-3">
          <div className="flex items-center space-x-2">
            <Spinner size="inline" />
            <p>{progress ? `Scanning frame ${progress.sampled} of ${progress.total}` : 'Preparing scanner…'}</p>
          </div>
          <progress className="w-full h-2 accent-neutral-300" aria-label="Video scan progress" max={1} value={progress?.fraction} />
          <Button variant="outline" className="self-center" onClick={onCancel}>
            Cancel
          </Button>
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <ScanUploadPanel>
      <AlertDescription>
        <p className="text-neutral-400 mb-4 text-center">
          {imageAction
            ? 'Select images or a collection video to scan your Pokémon TCG Pocket cards.'
            : 'Choose a video, then press Scan to find your cards and owned quantities.'}
        </p>
      </AlertDescription>
      <input
        id={inputId}
        ref={input}
        type="file"
        aria-label="Video recording"
        accept="video/*,.mp4,.mov,.m4v,.webm"
        className="hidden"
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0]
          if (selected) {
            onFileChange(selected)
          }
          event.currentTarget.value = ''
        }}
      />
      <div className="flex flex-wrap items-center justify-center gap-2">
        {imageAction}
        <Button variant="outline" onClick={() => input.current?.click()}>
          {file ? 'Change video' : 'Select video'}
        </Button>
        <Button onClick={onScan} disabled={!file}>
          Scan
        </Button>
      </div>
      {file && <p className="mt-3 max-w-full break-all text-center text-sm text-neutral-400">{file.name}</p>}
      <p className="mt-4 text-center text-xs text-neutral-500">Video is processed locally. Nothing is uploaded.</p>
    </ScanUploadPanel>
  )
}
