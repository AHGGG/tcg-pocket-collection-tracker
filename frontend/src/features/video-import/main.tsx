import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from 'react-error-boundary'
import VideoImportPage from './VideoImportPage'
import './video-import.css'

const root = document.getElementById('root')
if (!root) {
  throw new Error('Missing video importer root element.')
}
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary fallbackRender={({ error }) => (
      <main className="video-import"><h1>The local importer stopped</h1><p>No collection changes were applied.</p><pre>{error instanceof Error ? error.message : 'Unexpected error'}</pre><a href="./video-import.html">Reload importer</a></main>
    )}>
      <VideoImportPage />
    </ErrorBoundary>
  </StrictMode>,
)
