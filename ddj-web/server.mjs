// Web UI for ddj200-decks.pd. No dependencies: `node ddj-web/server.mjs`, then open http://localhost:9011
// Starts Pd without a window (--gui keeps the window, --no-pd connects to a Pd you started yourself).
// Talks to [ddj-web] over TCP (FUDI) on port 9010, and to the page over SSE + POST.
import http from 'node:http'
import net from 'node:net'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'

const PD_PORT = +process.env.PD_PORT || 9010
const WEB_PORT = +process.env.WEB_PORT || 9011
const PD_BIN = process.env.PD_BIN || '/usr/local/bin/pd'
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const page = join(repo, 'ddj-web', 'index.html')
const folderFile = join(homedir(), '.ddj-web-folder')
// where the recordings land; the folder until you choose another
const defaultFolder = join(homedir(), 'Music', 'Recordings')
const savedFolder = async () => (await readFile(folderFile, 'utf8').catch(() => '')) || defaultFolder
// Pd can't read FLAC: WAV copies of the FLACs, and the song list Pd reads, live here
const cacheDir = join(homedir(), 'Library', 'Caches', 'ddj-web')
const songsFile = join(cacheDir, 'songs.txt')

let pdProc = null
if (!process.argv.includes('--no-pd')) {
  const args = process.argv.includes('--gui') ? ['ddj200-decks.pd'] : ['-nogui', 'ddj200-decks.pd']
  pdProc = spawn(PD_BIN, args, { cwd: repo, stdio: ['ignore', 'inherit', 'inherit'] })
  pdProc.on('exit', (code) => { console.log(`Pd exited (${code})`); pdProc = null })
}
const quit = () => { pdProc?.kill(); process.exit() }
process.on('SIGINT', quit)
process.on('SIGTERM', quit)

// state: everything [ddj-web] reports, as key -> values (e.g. 'd1-pos' -> [0.42]); songs come separately
let pd = null
let songs = []
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

// each load: track the song's real beats in a worker (records drift, a straight grid doesn't follow them),
// then hand [ddj-deck] a table of the beat count every 10 ms (a 100 Hz float WAV it reads with soundfiler)
const beatJob = {}
function trackBeats(d, path) {
  const job = beatJob[d] = Symbol(path)
  setKey(`d${d}-beatgrid`, [])   // the page draws the bpm grid until the beats are in
  const tmp = join(cacheDir, `decode-d${d}.wav`), out = join(cacheDir, `beats-d${d}.wav`)
  const w = new Worker(new URL('./beats.mjs', import.meta.url), { workerData: { path, tmp } })
  w.once('message', async ({ first, beats, table }) => {
    if (beatJob[d] !== job) return   // another song was loaded meanwhile
    const head = Buffer.alloc(44), bytes = table.length * 4
    head.write('RIFF', 0); head.writeUInt32LE(36 + bytes, 4); head.write('WAVEfmt ', 8)
    head.writeUInt32LE(16, 16); head.writeUInt16LE(3, 20); head.writeUInt16LE(1, 22)   // float, mono
    head.writeUInt32LE(100, 24); head.writeUInt32LE(400, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(32, 34)
    head.write('data', 36); head.writeUInt32LE(bytes, 40)
    await mkdir(cacheDir, { recursive: true })
    await writeFile(out, Buffer.concat([head, Buffer.from(table.buffer, table.byteOffset, bytes)]))
    if (beatJob[d] !== job) return
    toPd(`d${d}-beats ${escape(out)}`)
    setKey(`d${d}-beatgrid`, [first, ...beats])
  })
  w.once('error', (err) => console.log(`No beats for ${basename(path)}: ${err.message}`))
}

// queue: songs added to a playing deck wait here, first in first out. Pd loops a track at its end, so
// in its last 0.15 s the deck is paused instead, and the next queued song loads, ready to play
const queue = { 1: [], 2: [] }, ending = {}
const sendQueue = () => broadcast({ queue })
function nearEnd(d) {
  const k = (key) => state[`d${d}-${key}`]?.[0], secs = (state[`d${d}-wave`]?.length ?? 0) / 100
  if (!k('play') || ending[d] || !secs || (1 - (k('pos') ?? 0)) * secs > 0.15 * Math.max(k('rate') ?? 1, 1)) return
  ending[d] = true
  toPd(`d${d}-play 127`)
}
function loadNext(d) {
  while (queue[d].length) {
    const i = songs.indexOf(queue[d].shift())   // a song no longer in the list is skipped
    if (i >= 0) { toPd(`browser-deck ${d}`); toPd(`web-browser load ${d} ${i}`); break }
  }
  sendQueue()
}

// crossfade (MIX): the other deck starts synced on the beat, the crossfader sweeps over to it in 16 beats,
// then the deck faded out pauses (and loads its next queued song). AUTO mixes by itself before a song ends.
// Moving the crossfader by hand during the sweep hands it back to you
const MIX_BEATS = 16
let mix = null, auto = false
const deck = (d, key) => state[`d${d}-${key}`]?.[0]
const loaded = (d) => (deck(d, 'title') ?? '-') !== '-'
const fadeSecs = (d) => (deck(d, 'tbpm') > 0 ? MIX_BEATS * 60 / (deck(d, 'tbpm') * (deck(d, 'rate') ?? 1)) : 8)
function startMix() {
  if (mix || !pd) return false
  const xf = state['master-crossfader']?.[0] ?? 64
  // from: the deck you hear (the crossfader decides when both play)
  const from = deck(1, 'play') && (!deck(2, 'play') || xf < 64) ? 1 : deck(2, 'play') ? 2 : 0, to = 3 - from
  if (!from || !loaded(to)) return false
  if (!deck(to, 'play')) {
    if (!deck(to, 'sync')) toPd(`d${to}-sync 127`)
    toPd(`d${to}-play 127`)
  }
  const target = to === 2 ? 127 : 0, secs = fadeSecs(from), t0 = Date.now()
  mix = { from, sent: xf }
  setKey('mixing', [1, t0 + secs * 1000, secs / MIX_BEATS])   // end time and seconds per beat: the page counts the beats down
  mix.timer = setInterval(() => {
    const now = state['master-crossfader']?.[0] ?? mix.sent
    if (Math.abs(now - mix.sent) > 3) return endMix(false)   // you moved the fader
    const f = Math.min((Date.now() - t0) / 1000 / secs, 1)
    mix.sent = Math.round(xf + (target - xf) * f)
    toPd(`master-crossfader ${mix.sent}`)
    if (f >= 1) endMix(true)
  }, 50)
  return true
}
function endMix(done) {
  clearInterval(mix.timer)
  if (done && deck(mix.from, 'play')) { ending[mix.from] = true; toPd(`d${mix.from}-play 127`) }   // paused: its next queued song loads
  mix = null
  setKey('mixing', [0])
}
function autoMix(d) {
  const left = (1 - (deck(d, 'pos') ?? 0)) * (state[`d${d}-wave`]?.length ?? 0) / 100 / Math.max(deck(d, 'rate') ?? 1, 0.01)
  if (auto && !mix && deck(d, 'play') && !deck(3 - d, 'play') && loaded(3 - d) && left > 0 && left <= fadeSecs(d) + 1) startMix()
}

function handle([key, ...v]) {
  if (/^d[12]-loaded$/.test(key) && String(v[0]).startsWith('/')) { ending[key[1]] = false; trackBeats(key[1], v[0]) }
  if (/^d[12]-queue$/.test(key)) {   // SHIFT+SYNC on a playing deck
    if (songs.includes(v[0])) { queue[key[1]].push(v[0]); sendQueue() }
    return
  }
  if (key === 'clear') songs = []
  else if (key === 'song') songs[+v[0]] = v[1] ?? ''
  else if (key === 'done') broadcast({ songs })
  else if (key) {
    if (key === 'master-rec' && !!+v[0] !== !!state['rec-since']?.[0]) setKey('rec-since', [+v[0] ? Date.now() : 0])   // for the REC timer
    setKey(key, v.map(num))
  }
  if (/^d[12]-pos$/.test(key)) { autoMix(+key[1]); nearEnd(key[1]) }
  if (/^d[12]-state$/.test(key) && !+v[0] && ending[key[1]]) { ending[key[1]] = false; loadNext(key[1]) }
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
  s.on('connect', async () => {
    pd = s
    console.log('Pd connected')
    setKey('pd', [1])
    setKey('automix', [+auto])
    toPd('web-browser hello')
    loadFolder(await savedFolder()).catch((err) => console.log(`Can't load the music folder: ${err.message}`))
  })
  s.on('data', (d) => { buf += d; takeMessages().forEach(handle) })
  s.on('error', () => {})
  s.on('close', () => {
    if (pd === s) {
      pd = null
      if (mix) endMix(false)
      songs = []; state = {}; seen = {}
      broadcast({ songs })
      setKey('pd', [0])
      console.log('Pd disconnected, retrying')
    }
    buf = ''
    setTimeout(connectPd, 300)
  })
}
connectPd()

// the page may only send what the controller could send
const allowed = [
  /^d[12]-(play|cue|sync|eject|hotcue-on|hotcue-off|pad-up|padmode|loopsnap|seek-to|pfl)( -?[\d.]+)?$/,
  /^(master-crossfader|master-trfx|master-headmix|master-rec|lights-mode)( -?[\d.]+)$/,
  /^ddj-calibrate$/,
  /^web-browser (select|load) [12] \d+$/,
]

async function readBody(req) {
  let body = ''
  for await (const c of req) body += c
  return body
}

// the folder browser stays inside your home folder
const home = homedir()
async function inHome(path) {
  const real = await realpath(path)
  if (real !== home && !real.startsWith(home + sep)) throw new Error('outside home')
  return real
}

async function listDirs(path) {
  const entries = await readdir(path, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
  return { path, home, dirs: dirs.sort((a, b) => a.localeCompare(b)), audio: await countAudio(path) }
}

// songs in a folder and up to 3 subfolders down, laid out the way vinyl-catalog files an album:
// the album.json tracklist first, then recordings not in it yet; raw/ holds the originals, so it is skipped
const isAudio = (name) => /\.(wav|aiff?|flac)$/i.test(name)
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true })
async function songsIn(path, depth = 3) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
  const files = entries.filter((e) => e.isFile() && isAudio(e.name)).map((e) => e.name).sort(byName)
  const album = await readFile(join(path, 'album.json'), 'utf8').then(JSON.parse).catch(() => ({}))
  const listed = (album.tracks ?? []).filter((t) => files.includes(t.file))
  // album: from album.json, else the folder name; side: A1 in the tracklist, B-01.wav from vinyl-rec, or a folder named "… A"
  const [, folderName, folderSide] = basename(path).match(/^(.*?)(?: ([A-H]))?$/)
  const title = album.title ? `${album.artist} – ${album.title}` : folderName
  const side = (name) => name.match(/^([A-H])\d*\b/)?.[1] ?? folderSide ?? ''
  const coverName = [album.cover, 'cover.jpg', 'cover.png', 'folder.jpg'].find((f) => f && entries.some((e) => e.isFile() && e.name === f))   // a real file: a symlink could point anywhere
  const cover = coverName ? join(path, coverName) : ''
  const about = { album: title, cover, year: album.year ?? '', label: album.label ?? '' }
  const songs = [
    ...listed.map((t) => ({ path: join(path, t.file), ...about, side: side(t.position ?? '') })),
    ...files.filter((f) => !listed.some((t) => t.file === f)).map((f) => ({ path: join(path, f), ...about, side: side(f) })),
  ]
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'raw').map((e) => e.name).sort(byName)
  if (depth) for (const d of dirs) songs.push(...await songsIn(join(path, d), depth - 1))
  return songs
}
const countAudio = async (path) => (await songsIn(path)).length

// a FLAC plays from a 24-bit WAV copy in the cache, made once (again if the FLAC changes)
const run = promisify(execFile)
async function playable(path) {
  if (!/\.flac$/i.test(path)) return path
  const wav = join(cacheDir, relative(home, path)).replace(/\.flac$/i, '.wav')
  const [src, copy] = await Promise.all([stat(path), stat(wav).catch(() => null)])
  if (!copy || copy.mtimeMs < src.mtimeMs) {
    await mkdir(dirname(wav), { recursive: true })
    const part = wav.replace(/\.wav$/, '.part.wav')  // afconvert swaps any other extension for .wav
    await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI24', path, part])
    await rename(part, wav)
  }
  return wav
}

// hand Pd the song list of a folder (one path per line, read by [ddj-browser])
// one load at a time, so two never decode the same FLAC at once
let folderNow = '', meta = {}, loading = Promise.resolve()  // meta: song path -> { album, side, cover, year, label } for the page
const loadFolder = (folder) => (loading = loading.catch(() => {}).then(() => load(folder)))
async function load(folder) {
  const path = await inHome(folder)
  const list = [], about = {}
  for (const { path: song, ...info } of await songsIn(path)) {
    const p = await playable(song).catch((err) => console.log(`Skipping ${song}: ${err.message}`))
    if (p) { list.push(p); about[p] = info }
  }
  meta = about
  await mkdir(cacheDir, { recursive: true })
  await writeFile(songsFile, list.map((p) => escape(p) + '\n').join(''))
  toPd(`web-browser songs ${escape(songsFile)}`)
  folderNow = path
  broadcast({ folder: path, meta })
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
      res.write(event({ songs, folder: folderNow, meta, queue }) + event({ state: { ...state, pd: [pd ? 1 : 0] } }))
      clients.add(res)
      req.on('close', () => clients.delete(res))
    } else if (req.method === 'POST' && url.pathname === '/cmd') {
      const body = (await readBody(req)).trim()
      const drop = body.match(/^queue-remove ([12]) (\d+)$/)
      if (drop) { queue[drop[1]].splice(+drop[2], 1); sendQueue(); return res.writeHead(204).end() }
      if (body === 'mix') {   // MIX again during the sweep stops it where it is, like moving the fader by hand
        if (mix) { endMix(false); return res.writeHead(204).end() }
        return res.writeHead(startMix() ? 204 : 409).end()
      }
      if (/^mix-auto [01]$/.test(body)) { auto = body.endsWith('1'); setKey('automix', [+auto]); return res.writeHead(204).end() }
      const ok = pd && allowed.some((re) => re.test(body))
      // a song pick names its deck first: each deck has its own cursor in [ddj-browser]
      const pick = body.match(/^web-browser (select|load) ([12]) (\d+)$/)
      if (ok && pick?.[1] === 'load' && state[`d${pick[2]}-state`]?.[0]) {   // the deck is playing: queue the song
        if (songs[pick[3]]) { queue[pick[2]].push(songs[pick[3]]); sendQueue() }
        return res.writeHead(204).end()
      }
      if (ok && pick) toPd(`browser-deck ${pick[2]}`)
      if (ok) toPd(pick?.[1] === 'select' ? `web-browser select ${pick[3]}` : body)
      res.writeHead(ok ? 204 : 400).end()
    } else if (req.method === 'POST' && url.pathname === '/folder') {
      const path = await inHome((await readBody(req)).trim())
      if (!pd) return json(400, { error: 'Pd not connected' })
      await loadFolder(path)
      await writeFile(folderFile, path)
      json(200, { ok: true })
    } else if (url.pathname === '/cover') {
      // only the covers of songs in the list
      const cover = meta[url.searchParams.get('song')]?.cover
      if (!cover) throw new Error('no cover')
      const body = await readFile(cover)   // read first: a missing file must still get its 404
      res.writeHead(200, { 'content-type': cover.endsWith('.png') ? 'image/png' : 'image/jpeg', 'cache-control': 'max-age=3600' }).end(body)
    } else if (url.pathname === '/dirs') {
      const path = url.searchParams.get('path') || await inHome(await savedFolder()).catch(() => home)
      json(200, await listDirs(await inHome(path)))
    } else if (/^\/(favicon\.svg|fonts\/[\w-]+\.woff2)$/.test(url.pathname)) {   // fonts bundled, so the page works offline
      const type = url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'font/woff2'
      const body = await readFile(join(repo, 'ddj-web', url.pathname))   // read first: a missing file must still get its 404
      res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=86400' }).end(body)
    } else {
      const body = await readFile(page)   // read first: a missing file must still get its 404
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body)
    }
  } catch (err) {
    if (res.headersSent) res.destroy()
    else json(404, { error: 'not found' })
  }
}).listen(WEB_PORT, () => console.log(`DJ page on http://localhost:${WEB_PORT}`))
