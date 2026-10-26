# Where to cut a recorded side into songs.
# Vinyl rarely has true silence between songs (surface noise, segues), so instead of looking for silence
# this finds the quietest moment near each expected boundary, using ffmpeg's momentary loudness (100 ms steps).
#
#   python3 -I dips.py SIDE.wav                 -> the 20 deepest dips (use when there is no tracklist yet)
#   python3 -I dips.py SIDE.wav 340 556 662 ... -> for each expected boundary (seconds), the deepest dip within +-20 s
#   python3 -I dips.py --trim SONG.wav          -> 'start end' of the music: skips the needle drop and hiss before it, the hiss tail after the fade
import re, statistics, subprocess, sys, tempfile

WINDOW = 20      # seconds either side of an expected boundary
WEAK = 10        # a dip less than this many dB below the side's median is a guess, not a gap

def curve(path):
    with tempfile.NamedTemporaryFile(suffix='.txt') as out:
        subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-loglevel', 'error', '-i', path,
                        '-af', f'ebur128=metadata=1,ametadata=print:key=lavfi.r128.M:file={out.name}', '-f', 'null', '-'], check=True)
        pts, t = [], None
        for line in open(out.name):
            if (m := re.search(r'pts_time:([\d.]+)', line)): t = float(m.group(1))
            elif (m := re.search(r'r128\.M=(-?[\d.]+)', line)) and t is not None and float(m.group(1)) > -100:
                pts.append((t, float(m.group(1))))
    return pts

def trim(pts):
    # every take ends in the record's own hiss (the silence gap that closed it), so that is the reference.
    # start: where the sound stays 10 dB above that hiss for a whole second (minus 0.3 s of air):
    # a needle drop or click is too short to pass, the hiss before the song is too quiet, a quiet intro still counts.
    # end: 0.5 s after the last moment 6 dB above the hiss, so the whole fade-out stays and only the hiss tail goes
    end = pts[-1][0]
    hiss = statistics.median(v for t, v in pts if t > end - 0.8)
    start = next((max(t - 0.3, 0) for i, (t, v) in enumerate(pts) if all(w > hiss + 10 for _, w in pts[i:i + 10])), 0)
    last = max((t for t, v in pts if v > hiss + 6), default=end)
    return start, min(last + 0.5, end)

def mmss(t): return f'{int(t // 60)}:{t % 60:04.1f}'

if __name__ == '__main__':
    if sys.argv[1] == '--trim':
        print('%.2f %.2f' % trim(curve(sys.argv[2])))
        sys.exit()
    pts = curve(sys.argv[1])
    med = statistics.median(v for _, v in pts)
    print(f'side median {med:.1f} LUFS, {mmss(pts[-1][0])} long')
    targets = [float(a) for a in sys.argv[2:]]
    if not targets:
        dips = [(t, v) for i, (t, v) in enumerate(pts) if v == min(w for _, w in pts[max(0, i - 50):i + 50]) and v < med - WEAK]
        for t, v in sorted(dips, key=lambda d: d[1])[:20]:
            print(f'dip {mmss(t)} ({t:.1f}s) {med - v:.0f} dB below median')
    # turntable speed and a late start make the real boundaries drift from the tracklist, so each clear cut
    # shifts the search for the next one by the same offset
    drift = 0.0
    for b in targets:
        near = [(t, v) for t, v in pts if abs(t - (b + drift)) <= WINDOW]
        t, v = min(near, key=lambda d: d[1]) if near else (b + drift, med)
        weak = med - v < WEAK
        if not weak: drift = t - b
        flag = '  WEAK: no clear gap, check by ear' if weak else ''
        print(f'expected {mmss(b)} -> cut {mmss(t)} ({t:.1f}s), {med - v:.0f} dB below median{flag}')
