# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**Pd-studios** (`git@github.com:Rckdrigo/Pd-studios.git`) — a collection of Pure Data (Pd) patches for live audio performance, synthesis experiments, MIDI/OSC bridging, and OpenGL visuals. There is no build system or test suite: `.pd` files are plain-text patch definitions loaded and run in the Pd GUI. "Running" a patch means opening it in Pd; editing means either dragging objects in the GUI or hand-editing the `.pd` text.

## Running Patches

Pd is installed as **Pd 0.55.2** (`/Applications/Pd-0.55.2.app`) and aliased in the shell:

```bash
pd patch.pd            # open a patch (starts DSP-capable GUI)
pd -nogui -batch x.pd  # headless run
pdsend <port>          # send messages to a running patch's netreceive
pdreceive <port>       # receive messages a patch sends via netsend
```

To find/load the bundled externals, add the relevant `externals/*` folders to Pd's search path (Preferences → Paths) or launch with `-path`, e.g. `pd -path externals/Gem visuals-studio.pd`.

## The .pd File Format (for hand-editing)

Every patch is a sequence of `;`-terminated records:
- `#N canvas <x> <y> <w> <h> <fontsize>;` — opens a canvas (window or subpatch).
- `#X obj <x> <y> <objname> <args...>;` — an object box. GUI objects (`hsl`, `vsl`, `tgl`, `bng`, `scope`, `floatatom`) carry a long fixed argument list for size/range/colors.
- `#X msg`, `#X text`, `#X floatatom` — message boxes, comments, number boxes.
- `#X connect <src-obj-idx> <src-outlet> <dst-obj-idx> <dst-inlet>;` — a patch cord. **Object indices are the 0-based order in which `#X obj`/`#X msg`/etc. records appear in the file.** Inserting or reordering an object shifts every later index, so any hand-edit that adds/removes an object must renumber all affected `#X connect` lines. Prefer editing in the Pd GUI when connections are involved.
- `#X coords ...` at the end of an abstraction defines its graph-on-parent appearance (visible when the abstraction is instantiated inside another patch).

## Conventions in this repo

- **`tools/`** holds reusable **abstractions** (`PI.pd`, `circunference.pd`, `max-value.pd`, `min-value.pd`, `step.pd`) — small patches meant to be dropped into others as `[abstraction-name]` object boxes rather than run standalone. Add new shared building blocks here.
- **Audio files are gitignored** (`*.mp3`, `*.wav`, `*.ogg`) — sampler patches reference audio that lives outside version control; don't assume a referenced sample is present.
- `Untitled-*.pd`, `test*.pd`, `estudio-*.pd`, `studio-*.pd`, `workshop.pd` are experimental scratch patches. The named patches below are the deliberate ones.

## Machine-specific I/O (patches assume this hardware routing)

Several patches address **specific channels of a multichannel audio interface** by number — they will be silent or misrouted on a stereo-only setup. When editing these, preserve the channel numbers unless the hardware changed.

- **`blackhole-map.pd`** — an abstraction that maps hardware `adc~` inputs to named outlets: ch 10 = Mic L, 13/14 = MK L/R, 11/12 = SC L/R, 15/16 = Music L/R, 20/21 extra. Used as the input router for performance patches.
- **`minilab.pd` / `minilab-enter.pd` / `ml-*.pd`** — Arturia **MiniLab** MIDI-controller patches; read `adc~ 13/14`, output on `dac~ 5/6`.
- **`midi-osc-bridge.pd`** — converts MIDI CC (`ctlin`) to OSC and sends via `netsend -u -b` to `localhost:6010` (SuperCollider/Tidal-style receiver). CC value is scaled `/127`.
- **`vinyl-rec.pd` / `rec-file.pd`** — `vinyl-rec` auto-splits a turntable (BlackHole 16ch inputs 15/16) into `~/Music/Recordings/vinyl/` by silence. `rec-file` is the shared writer: it takes 1 to start a new file at the first free number, 0 to stop, and `folder PATH` to switch folders (vinyl-rec's ALBUM button uses this for `~/Music/Recordings/vinyl/<album>/`). `ddj200-decks` uses it for `~/Music/Recordings/set/` via `master-rec` (the REC button on the web page).
- **DDJ beat sync follows the real beats:** on each load `ddj-web/server.mjs` runs `ddj-web/beats.mjs` in a worker (beat tracking, about 2–3 s per song). It sends `[ddj-deck]` `dN-beats FILE`, a 100 Hz float WAV of the beat count every 10 ms, and the page gets `dN-beatgrid`. Sync's beat position comes from that table, and falls back to the straight `[ddj-bpm]` grid until it arrives. Beat loops still use the straight grid.
- **DDJ queue and MIX (all in `ddj-web/server.mjs`):** loading into a playing deck queues the song for that deck (first in, first out). That includes the controller: SHIFT+SYNC on a playing deck makes `[ddj-browser]` send `dN-queue PATH` on `ddj-ui`. Pd loops a track at its end, so the server pauses the deck in its last 0.15 s and loads the next queued song. MIX turns on sync for the other deck, starts it, and sweeps `master-crossfader` across over 16 beats. It then pauses the faded-out deck, which loads that deck's next queued song. AUTO starts MIX 16 beats before the playing song ends. Moving the crossfader by hand cancels a sweep.
- **vinyl-rec take rules:** a take starts only after 0.4 s above the threshold (needle drops and clicks can't start one or reset the silence countdown). The pre-roll and the stop are both delayed 600 ms, so the first beat and the whole fade plus gap are kept. A new album switches AUTO on.
- **`vinyl-web/`** — web page for `vinyl-rec` (`node vinyl-web/server.mjs`, http://localhost:9013). The server starts Pd on BlackHole 16ch (looked up by name) and talks to vinyl-rec over TCP 9012. In: `vinyl-arm/auto/side/thr/gap/min/redo/split/folder`. Out: `[vinyl-tap KEY]` values. `vinyl-rec.pd` is generated by wiring objects by name. When hand-editing it, renumber `#X connect` lines carefully (the logic subpatch has ~180 objects).
- **`.claude/skills/vinyl-catalog/`** — after a record is recorded: identify the vinyl release (MusicBrainz/Discogs), map the WAVs to its tracklist (`dips.py` finds the cut points in one-file sides), write tagged `A1 - Title.flac` (trimmed, declicked, rumble/hiss reduced, −16 LUFS, via `cut.py`) + `cover.jpg` + `album.json` + `notes.md`, originals kept in `raw/`. Library layout: `~/Music/Recordings/vinyl/<Artist>/<Album>/`; the web page's New album asks for both and `POST /album` takes `{artist, album}`.
- **`performance-1.pd`, `visuals-studio.pd`** — larger performance/visual sets; `visuals-studio.pd` uses the **Gem** external for OpenGL rendering.

## Bundled externals (`externals/`)

Not authored here — vendored binaries/help, kept out of the normal edit surface:
- **Gem** — OpenGL graphics rendering (`gemwin`, geometry, shaders); required by the visuals patches. Ships macOS `.dylib`/`.d_fat` binaries and an `examples/` tree.
- **PureDirt-master** — Dirt-style sample playback objects.
- **comport** — serial port I/O.
- **freeverb~** — reverb.

The former `externals/purest_json` (REST/JSON/OAuth objects) has been removed from the working tree.
