import { useId } from 'react'
import type { VideoScanProgress } from './scanFrames'

export function VideoScanControls({
  file,
  onFileChange,
  onScan,
  busy,
  onCancel,
  progress,
}: {
  file: File | null
  onFileChange: (file: File | null) => void
  onScan: () => void
  busy: boolean
  onCancel: () => void
  progress: VideoScanProgress | null
}) {
  const inputId = useId()
  return (
    <div className="flex flex-col w-full gap-3 p-3" aria-busy={busy}>
      <label htmlFor={inputId}>Video recording</label>
      <input
        id={inputId}
        type="file"
        accept="video/*,.mp4,.mov,.m4v,.webm"
        disabled={busy}
        onChange={(event) => {
          const selected = event.currentTarget.files?.[0] ?? null
          if (selected) {
            onFileChange(selected)
          }
          event.currentTarget.value = ''
        }}
      />
      {file && <p className="text-sm break-all">{file.name}</p>}
      <div className="flex gap-2">
        <button type="button" className="primary rounded-md border px-4 py-2 disabled:opacity-50" disabled={!file || busy} onClick={onScan}>
          {busy ? 'Scanning…' : 'Scan'}
        </button>
        {busy && (
          <button type="button" className="rounded-md border px-4 py-2" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {busy && (
        <div role="status" aria-live="polite">
          <p>{progress ? `Scanning frame ${progress.sampled} of ${progress.total}` : 'Preparing scanner…'}</p>
          <progress className="w-full" aria-label="Video scan progress" max={1} value={progress?.fraction} />
        </div>
      )}
    </div>
  )
}
