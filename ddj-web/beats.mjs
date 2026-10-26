// Beat tracking for one song, run in a worker by server.mjs. Records drift (live bands, turntable speed),
// so instead of a straight grid this follows each beat: onset strength -> tempo -> dynamic programming
// (Ellis 2007) -> beats smoothed over their neighbours. Posts { beats, table }: beat times in seconds and
// the beat count at every 10 ms (the table Pd reads to know where each deck is in the beat).
import { workerData, parentPort } from 'node:worker_threads'
import { execFile } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { promisify } from 'node:util'

const SR = 11025, HOP = 64, N = 512, FPS = SR / HOP   // onset frames: 5.8 ms

// mono float samples at 11025 Hz (afconvert reads WAV and AIFF)
async function decode(path, tmp) {
  await promisify(execFile)('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEF32@11025', '-c', '1', path, tmp])
  const buf = await readFile(tmp)
  await rm(tmp, { force: true })
  for (let i = 12; i < buf.length - 8;) {
    const id = buf.toString('ascii', i, i + 4), size = buf.readUInt32LE(i + 4)
    if (id === 'data') return new Float32Array(buf.buffer.slice(buf.byteOffset + i + 8, buf.byteOffset + i + 8 + (size & ~3)))
    i += 8 + size + (size & 1)
  }
  throw new Error('no audio data')
}

function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const p = i + k, q = p + len / 2, tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr
        re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t
      }
    }
  }
}

// spectral flux on log magnitudes, DC removed, unit variance
function onsets(x) {
  const frames = Math.max(Math.floor((x.length - N) / HOP), 0), out = new Float64Array(frames)
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N))
  let prev = new Float64Array(N / 2)
  for (let f = 0; f < frames; f++) {
    const re = new Float64Array(N), im = new Float64Array(N)
    for (let i = 0; i < N; i++) re[i] = x[f * HOP + i] * win[i]
    fft(re, im)
    const mag = new Float64Array(N / 2)
    let flux = 0
    for (let k = 1; k < N / 2; k++) { mag[k] = Math.log1p(100 * Math.hypot(re[k], im[k])); flux += Math.max(mag[k] - prev[k], 0) }
    out[f] = flux
    prev = mag
  }
  // subtract a 1 s moving average so loud passages don't win, then normalise
  const w = Math.round(FPS), o = new Float64Array(frames)
  let sum = 0
  for (let f = 0; f < frames; f++) {
    sum += out[f] - (f >= w ? out[f - w] : 0)
    o[f] = Math.max(out[f] - sum / Math.min(f + 1, w), 0)
  }
  const sd = Math.sqrt(o.reduce((s, v) => s + v * v, 0) / Math.max(frames, 1)) || 1
  return o.map((v) => v / sd)
}

// tempo: autocorrelation summed over 4 beat multiples, 75-175 bpm, weighted toward 120 like [ddj-bpm]
function tempo(o) {
  const acf = (lag) => { let s = 0; for (let i = 0; i + lag < o.length; i++) s += o[i] * o[i + lag]; return s }
  const cache = new Map(), A = (p) => { const l = Math.floor(p), f = p - l; for (const k of [l, l + 1]) if (!cache.has(k)) cache.set(k, acf(k)); return cache.get(l) * (1 - f) + cache.get(l + 1) * f }
  let best = 120, top = -Infinity
  for (let bpm = 75; bpm <= 175; bpm += 0.05) {
    const p = 60 * FPS / bpm, w = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2)
    const s = w * (A(p) + A(2 * p) + A(3 * p) + A(4 * p))
    if (s > top) { top = s; best = bpm }
  }
  return best
}

// dynamic programming: each beat = its onset + the best earlier beat about one period back
function track(o, bpm) {
  const p = 60 * FPS / bpm, n = o.length, score = new Float64Array(n), from = new Int32Array(n).fill(-1)
  for (let t = 0; t < n; t++) {
    let best = 0, arg = -1
    for (let s = t - Math.round(2 * p); s <= t - Math.round(p / 2); s++) {
      if (s < 0) continue
      const v = score[s] - 100 * Math.log((t - s) / p) ** 2
      if (arg < 0 || v > best) { best = v; arg = s }
    }
    score[t] = o[t] + (arg >= 0 ? Math.max(best, 0) : 0)
    if (arg >= 0 && best > 0) from[t] = arg
  }
  let t = n - 1
  for (let s = Math.max(n - Math.round(p), 0); s < n; s++) if (score[s] > score[t]) t = s
  const frames = []
  for (; t >= 0; t = from[t]) frames.push(t)
  return frames.reverse()
}

// sub-frame peak, then each beat moved onto the line through its 9 neighbours: follows drift, drops jitter
function refine(o, frames) {
  const t = frames.map((f) => {
    const a = o[f - 1] ?? 0, b = o[f], c = o[f + 1] ?? 0, d = a - 2 * b + c
    return (f + (d < 0 ? Math.max(Math.min(0.5 * (a - c) / d, 0.5), -0.5) : 0) + N / 2 / HOP) / FPS
  })
  return t.map((_, i) => {
    const lo = Math.max(i - 4, 0), hi = Math.min(i + 4, t.length - 1)
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0
    for (let j = lo; j <= hi; j++) { n++; sx += j; sy += t[j]; sxx += j * j; sxy += j * t[j] }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1)
    return (sy - slope * sx) / n + slope * i
  })
}

// beat count every 10 ms, counted so it is 0 or more at the start (extends the first and last beat periods)
function countTable(beats, seconds) {
  const first = Math.ceil(beats[0] / (beats[1] - beats[0])), table = new Float32Array(Math.ceil(seconds * 100) + 1)
  for (let k = 0, i = 0; k < table.length; k++) {
    const t = k / 100
    while (i < beats.length - 2 && beats[i + 1] <= t) i++
    table[k] = first + i + (t - beats[i]) / (beats[i + 1] - beats[i])
  }
  return { first, table }
}

const { path, tmp } = workerData
const x = await decode(path, tmp)
const o = onsets(x)
const beats = refine(o, track(o, tempo(o)))
if (beats.length < 8) throw new Error('no steady beat found')
const { first, table } = countTable(beats, x.length / SR)
parentPort.postMessage({ first, beats: beats.map((b) => +b.toFixed(4)), table }, [table.buffer])
