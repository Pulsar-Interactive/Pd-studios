# DJ Sync Analyzer

Pure Data patch for real-time audio analysis with OSC output to TouchDesigner.

## Features

- **BPM Detection** — onset-based beat detection with rolling average
- **Frequency Bands** — Low (<150Hz), Mid (800Hz), High (>3kHz)
- **Peak Meter** — overall audio level 0-1
- **Beat Trigger** — pulse on each detected beat

## OSC Output

| Address | Arguments | Description |
|---------|-----------|-------------|
| `/dj/sync` | `bpm low mid high peak beat` | All values in one message |

- **Port:** 7400 (UDP)
- **Host:** localhost
- **Update Rate:** 50ms (20 Hz)

## Usage

1. Open `dj-sync-main.pd` in Pure Data
2. Toggle DSP on (top-right)
3. Adjust threshold if needed (default 0.15)
4. Start TouchDesigner — OSC receiver on port 7400

## Values

| Value | Range | Description |
|-------|-------|-------------|
| bpm | 40-200 | Beats per minute |
| low | 0-1 | Low frequency level |
| mid | 0-1 | Mid frequency level |
| high | 0-1 | High frequency level |
| peak | 0-1 | Overall peak level |
| beat | 0/1 | Beat trigger pulse |

## Calibration

Adjust the threshold (0-1) to tune beat detection sensitivity:
- Lower = more sensitive (may double-trigger)
- Higher = less sensitive (may miss beats)

## Requirements

- Pure Data (Pd-vanilla or Pd-extended)
- Audio input device configured
