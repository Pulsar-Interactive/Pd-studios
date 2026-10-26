// Web UI for vinyl-rec.pd. No dependencies: `node vinyl-web/server.mjs`, then open http://localhost:9013
// Starts Pd without a window, reading BlackHole 16ch (--gui keeps the window, --no-pd connects to a Pd you started yourself).
// Talks to vinyl-rec's web link over TCP (FUDI) on port 9012, and to the page over SSE + POST.
// The FUDI / SSE / host checks are the same as ddj-web/server.mjs.
import http from 'node:http'
import net from 'node:net'
import { spawn, execFile } from 'node:child_process'
import { readFile, readdir, stat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const PD_PORT = +process.env.PD_PORT || 9012
const WEB_PORT = +process.env.WEB_PORT || 9013
const PD_BIN = process.env.PD_BIN || '/usr/local/bin/pd'
const INPUT = process.env.VINYL_INPUT || 'BlackHole 16ch'
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const page = join(repo, 'vinyl-web', 'index.html')
const vinylRoot = join(homedir(), 'Music', 'Recordings', 'vinyl')

// Pd numbers devices by position, which changes when devices come and go: look the input up by name each start
const inputIndex = () => new Promise((resolve) => {
  execFile(PD_BIN, ['-nogui', '-noaudio', '-listdev', '-send', 'pd quit'], { timeout: 8000 }, (err, out, errOut) => {
    const text = `${out}\n${errOut}`
    const list = text.split('audio input devices:')[1]?.split('audio output devices:')[0] ?? ''
    const hit = list.split('\n').map((l) => l.match(/^(\d+)\. .*?: (.*)$/)).find((m) => m?.[2].trim() === INPUT)
    resolve(hit ? hit[1] : null)
  })
})

let pdProc = null
if (!process.argv.includes('--no-pd')) {
  const dev = await inputIndex()
  if (dev === null) console.log(`${INPUT} not found, Pd uses its default input`)
  const args = ['-nomidi', '-inchannels', '16', '-outchannels', '0', '-send', 'pd dsp 1']
  if (dev !== null) args.push('-audioindev', dev)
  if (!process.argv.includes('--gui')) args.push('-nogui')
  pdProc = spawn(PD_BIN, [...args, 'vinyl-rec.pd'], { cwd: repo, stdio: ['ignore', 'inherit', 'inherit'] })
  pdProc.on('exit', (code) => { console.log(`Pd exited (${code})`); pdProc = null })
}
const quit = () => { pdProc?.kill(); process.exit() }
process.on('SIGINT', quit)
process.on('SIGTERM', quit)

// state: everything vinyl-rec reports, as key -> values (e.g. 'status' -> ['ARMED'])
let pd = null
let state = {}
let seen = {}
const clients = new Set()
const event = (msg) => `data: ${JSON.stringify(msg)}\n\n`
const broadcast = (msg) => { for (const c of clients) c.write(event(msg)) }
const num = (a) => (a !== '' && !isNaN(a) ? +a : a)

function setKey(key, values) {
  const json = JSON.stringify(values)
  if (seen[key] === json) return
  seen[key] = json
  state[key] = values
  broadcast({ k: key, v: values })
}

// FUDI: messages end with an unescaped ';', atoms split on unescaped whitespace, '\' escapes the next char
let buf = ''
function takeMessages() {
  const out = []
  let atoms = [], cur = '', esc = false, start = 0
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (esc) { cur += c; esc = false }
    else if (c === '\\') esc = true
    else if (c === ';') { if (cur) atoms.push(cur); out.push(atoms); atoms = []; cur = ''; start = i + 1 }
    else if (/\s/.test(c)) { if (cur) atoms.push(cur); cur = '' }
    else cur += c
  }
  buf = buf.slice(start)
  return out
}
const escape = (s) => s.replace(/[\\;,$\s]/g, (m) => '\\' + m)
const toPd = (msg) => pd?.write(msg + ';\n')

function connectPd() {
  const s = net.connect(PD_PORT, '127.0.0.1')
  s.setEncoding('utf8')
  s.on('connect', () => {
    pd = s
    console.log('Pd connected')
    setKey('pd', [1])
    toPd('vinyl-hello')
  })
  s.on('data', (d) => { buf += d; takeMessages().forEach(([key, ...v]) => key && setKey(key, v.map(num))) })
  s.on('error', () => {})
  s.on('close', () => {
    if (pd === s) {
      pd = null
      state = {}; seen = {}
      setKey('pd', [0])
      console.log('Pd disconnected, retrying')
    }
    buf = ''
    setTimeout(connectPd, 300)
  })
}
connectPd()

// the page may only send what the Pd panel could do
const allowed = [/^vinyl-(arm [01]|auto [01]|side [0-3]|thr \d+(\.\d+)?|gap \d+(\.\d+)?|min \d+(\.\d+)?|redo|split)$/]

async function readBody(req) {
  let body = ''
  for await (const c of req) body += c
  return body
}

// artist and album become ~/Music/Recordings/vinyl/<artist>/<album>; each part is one plain folder name
function folderName(name) {
  name = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!name || name.length > 120 || /[/:]/.test(name) || name.startsWith('.')) throw new Error('bad name')
  return name
}
const albumPath = ({ artist, album }) => join(vinylRoot, folderName(artist), folderName(album))

// track list of the current album folder; duration from the WAV header (byte rate), size minus the 44-byte header
async function tracks() {
  const folder = String(state.folder?.[0] ?? vinylRoot)
  if (folder !== vinylRoot && !folder.startsWith(vinylRoot + sep)) return []
  const names = (await readdir(folder).catch(() => [])).filter((n) => /\.wav$/i.test(n)).sort()
  return Promise.all(names.map(async (name) => {
    const path = join(folder, name)
    const { size } = await stat(path)
    const f = await open(path)
    const head = Buffer.alloc(44)
    await f.read(head, 0, 44, 0).finally(() => f.close())
    const byteRate = head.readUInt32LE(28)
    return { name, size, seconds: byteRate ? Math.max(0, size - 44) / byteRate : 0 }
  }))
}

// only this Mac or a device on the Wi-Fi using its address: refuse other websites (cross-site requests, DNS rebinding)
const hostOk = (host = '') => /^(localhost|127\.0\.0\.1|\[::1\]|\d+\.\d+\.\d+\.\d+|[\w-]+\.local)(:\d+)?$/.test(host)
const originOk = (req) => {
  const o = req.headers.origin
  if (!o) return true
  try { return new URL(o).host === req.headers.host } catch { return false }  // e.g. "Origin: null" from a sandboxed page
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const json = (code, data) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data))
  if (!hostOk(req.headers.host) || (req.method === 'POST' && !originOk(req))) return res.writeHead(403).end()
  try {
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write(event({ state: { ...state, pd: [pd ? 1 : 0] } }))
      clients.add(res)
      req.on('close', () => clients.delete(res))
    } else if (req.method === 'POST' && url.pathname === '/cmd') {
      const body = (await readBody(req)).trim()
      const ok = pd && allowed.some((re) => re.test(body))
      if (ok) toPd(body)
      res.writeHead(ok ? 204 : 400).end()
    } else if (req.method === 'POST' && url.pathname === '/album') {
      if (!pd) return json(400, { error: 'Pd not connected' })
      let path
      try { path = albumPath(JSON.parse(await readBody(req))) } catch { return json(400, { error: 'Fill in artist and album, without / or : (and not starting with a dot)' }) }
      toPd(`vinyl-folder ${escape(path)}`)
      json(200, { ok: true })
    } else if (url.pathname === '/logo.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' }).end(await readFile(join(repo, 'vinyl-web', 'logo.svg')))
    } else if (url.pathname === '/tracks') {
      json(200, await tracks())
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(page))
    }
  } catch (err) {
    json(404, { error: 'not found' })
  }
}).listen(WEB_PORT, () => console.log(`Vinyl page on http://localhost:${WEB_PORT}`))
