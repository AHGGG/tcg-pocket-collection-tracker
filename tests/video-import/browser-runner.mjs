import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Node 22+ and an installed Chromium-family browser; no extra npm dependencies.
if (Number(process.versions.node.split('.')[0]) < 22) {
  throw new Error('The browser checks require Node 22 or later.')
}
const candidates = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).flatMap((directory) => [
    path.join(directory, 'Google/Chrome/Application/chrome.exe'),
    path.join(directory, 'Microsoft/Edge/Application/msedge.exe'),
  ]),
]
const executable = candidates.find((candidate) => candidate && existsSync(candidate))
if (!executable) {
  throw new Error('No browser found. Set CHROME_PATH to an installed Chrome, Edge or Chromium executable.')
}
const port = 4179
const origin = `http://127.0.0.1:${port}`
const output = path.resolve('tests/video-import/results')
const profile = await mkdtemp(path.join(tmpdir(), 'pocket-video-tests-'))
let server
let chrome
let socket
let logs = ''
const diagnostics = []
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const appendLog = (data) => { logs = (logs + String(data)).slice(-250_000) }
async function until(work, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const result = await work()
      if (result) {
        return result
      }
    } catch (error) {
      lastError = error
    }
    await pause(150)
  }
  throw new Error(`Timed out: ${label}. ${lastError ?? ''}\n${logs}\n${diagnostics.join('\n')}`)
}
function launch(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
  child.stdout?.on('data', appendLog)
  child.stderr?.on('data', appendLog)
  child.on('error', (error) => appendLog(error.message))
  return child
}
function terminate(child) {
  if (!child?.pid || child.exitCode !== null) {
    return
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}
try {
  await mkdir(output, { recursive: true })
  server = launch(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', [
    '--filter', 'frontend', 'exec', 'vite', '--config', 'vite.video-import.config.ts',
    '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], { shell: process.platform === 'win32', env: { ...process.env, VIDEO_IMPORT_TEST: '1' } })
  await until(async () => {
    if (server.exitCode !== null) {
      throw new Error(`Vite exited with ${server.exitCode}`)
    }
    return (await fetch(`${origin}/tests/video-import.html`)).ok
  }, 'start Vite')
  const chromeArgs = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-default-apps',
    '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ]
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    chromeArgs.unshift('--no-sandbox')
  }
  chrome = launch(executable, chromeArgs)
  const debuggingPort = await until(async () => {
    const [value] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')
    return /^\d+$/.test(value) && value
  }, 'start test browser')
  const targets = await (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)).json()
  const target = targets.find((entry) => entry.type === 'page')
  assert.ok(target?.webSocketDebuggerUrl, 'Browser did not expose a test page')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DevTools connection timed out')), 10_000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('DevTools connection failed')) }, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  const requests = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id && pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id)
      clearTimeout(timer)
      pending.delete(message.id)
      if (message.error) {
        reject(new Error(JSON.stringify(message.error)))
      } else {
        resolve(message.result)
      }
    }
    if (message.method === 'Runtime.exceptionThrown') {
      diagnostics.push(JSON.stringify(message.params.exceptionDetails))
    }
    if (message.method === 'Network.requestWillBeSent') {
      requests.push(message.params.request.url)
    }
  })
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 15_000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails))
    }
    return result.result?.value
  }
  await command('Page.enable')
  await command('Runtime.enable')
  await command('Network.enable')
  await command('Page.navigate', { url: `${origin}/tests/video-import.html` })
  const results = await until(async () => {
    const value = await evaluate('window.videoImportTestResults')
    return value?.done && value
  }, 'browser assertions', 120_000)
  assert.equal(results.failed, 0, results.messages.join('\n'))
  await command('Page.navigate', { url: `${origin}/video-import.html` })
  await until(async () => (await evaluate('document.querySelector("h1")?.textContent')) === 'Recording → collection', 'React importer smoke test')
  const pageText = await evaluate('document.body.textContent')
  assert.ok(pageText.includes('Choose your files'), 'Importer did not render the first step')
  const screenshot = await command('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(output, 'importer.png'), Buffer.from(screenshot.data, 'base64'))
  assert.equal(diagnostics.length, 0, diagnostics.join('\n'))
  const externalRequests = requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== origin)
  assert.deepEqual(externalRequests, [], 'Test pages made external network requests')
  const report = { ...results, reactSmoke: 'passed', externalRequests, diagnostics }
  await writeFile(path.join(output, 'browser.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
} finally {
  socket?.close()
  terminate(chrome)
  terminate(server)
  await writeFile(path.join(output, 'runner.log'), logs).catch(() => {})
  await pause(300)
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {})
}
