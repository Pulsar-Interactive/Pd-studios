# Write one recorded song as a trimmed, cleaned, 24-bit FLAC. The source WAV is only read, never changed.
#
#   python3 -I cut.py raw/A-01.wav "A1 - Title.flac"            -> start and end found by dips.py --trim
#   python3 -I cut.py raw/vinyl-001.wav "B2 - Title.flac" 340.7 662.8   -> a song cut out of a whole side
#
# cleanup: highpass 25 Hz (motor rumble and warp wobble), adeclick (crackle and pops), afftdn 10 dB (gentle hiss
# reduction; more sounds underwater), 10 ms fade-in and 0.5 s fade-out (the cuts can't click),
# then loudnorm to -16 LUFS in linear mode: one gain for the whole song, its dynamics untouched.
import json, os, re, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # -I leaves the script's folder off the path
from dips import curve, trim

CLEAN = 'highpass=f=25,adeclick,afftdn=nr=10:tn=1'
src, out = sys.argv[1], sys.argv[2]
given = [float(a) for a in sys.argv[3:5]]
start, end = given if len(given) == 2 else given + list(trim(curve(src)))[len(given):]
rate = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', src],
                      capture_output=True, text=True, check=True).stdout.split()[0]
chain = f'{CLEAN},afade=t=in:d=0.01,afade=t=out:st={end - start - 0.5:.3f}:d=0.5'
cut = ['ffmpeg', '-hide_banner', '-nostats', '-ss', f'{start:.3f}', '-to', f'{end:.3f}', '-i', src]

# pass 1 measures the cleaned song, pass 2 applies the gain that lands it on -16 LUFS without passing -1.5 dBTP
log = subprocess.run(cut + ['-af', f'{chain},loudnorm=I=-16:TP=-1.5:print_format=json', '-f', 'null', '-'],
                     capture_output=True, text=True, check=True).stderr
m = json.loads(re.search(r'\{[^{}]*"input_i"[^{}]*\}', log).group(0))
norm = (f"loudnorm=I=-16:TP=-1.5:linear=true:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
        f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}")
subprocess.run(cut + ['-loglevel', 'error', '-af', f'{chain},{norm}', '-ar', rate,
                      '-c:a', 'flac', '-compression_level', '8', '-sample_fmt', 's32', '-y', out], check=True)
print(f'{out}: {start:.2f} -> {end:.2f} s, {m["input_i"]} LUFS -> -16 LUFS')
