---
name: vinyl-catalog
description: After a record has been digitized with vinyl-rec / vinyl-web, identify the exact vinyl release, map the recorded WAVs in ~/Music/Recordings/vinyl/<Artist>/<Album>/ to its official tracklist (splitting long one-file sides at the gaps between songs, merging false splits), write tagged FLACs with cover art plus album.json, and research the album into notes.md. Use when the user says they finished recording a record, or asks to catalog, map, tag, name or split the songs of a recorded album, or to research a vinyl they recorded.
---

# vinyl-catalog

Turns a folder of raw recordings into named, tagged songs plus research notes. Never destroys a recording.

Result in the album folder:
```
~/Music/Recordings/vinyl/<Artist>/<Album>/
  A1 - Title.flac …   tagged, cover embedded
  cover.jpg
  album.json          release + tracklist + where each song came from
  notes.md            research, every fact sourced
  raw/                the original WAVs, untouched
```

Tools: `ffmpeg`, `ffprobe`, `metaflac` (installed), `dips.py` next to this file, WebSearch / WebFetch.

## 0. Guardrails (check before anything)
- **Not while recording:** run `curl -s -N --max-time 1 localhost:9013/events | head -c 600`. If it shows `"rec":[1]` and its `folder` is this album, stop and tell the user to wait for "Side finished".
- **WAVs are never deleted or overwritten.** They move into `raw/` unchanged. Check `md5 -q` before and after the move.
- **Two confirmations before writing anything:** (1) which release, (2) the mapping table.

## 1. Find the album
- Albums live in `~/Music/Recordings/vinyl/<Artist>/<Album>/`. Older albums may still be flat `Artist - Album` folders.
- Use the folder the user names; otherwise the most recently modified album folder.
- Recordings made with no album set land loose in `~/Music/Recordings/vinyl/` (e.g. `A-01.wav`). Ask the user which album they belong to.
- Look for sibling side folders, e.g. `Album A` and `Album B`, recorded before side support existed. Offer to merge them into one folder. Files from side folders keep their side: `vinyl-001.wav` from `… B` becomes side B.
- Inventory each WAV: `ffprobe -v error -show_entries format=duration -of csv=p=0 "<file>"`.
- Group the files by side: `A-01.wav` is side A track 1. For `vinyl-NNN.wav` the side is unknown, so work it out in step 3.

## 2. Identify the release (ask, don't guess)
- Take artist and album from the two folder levels, or parse "Artist - Album" from an old flat folder. Names are often shortened or in capitals, e.g. "Musas Vol 2", "GINO SOCCIO".
- **MusicBrainz** (send the User-Agent on every call, at most 1 request/s):
  - `curl -s -A "vinyl-catalog/1.0 (rckdrigomed@gmail.com)" 'https://musicbrainz.org/ws/2/release/?query=artist:%22<artist>%22%20AND%20release:%22<album>%22&fmt=json&limit=10'`
  - Don't add `format:Vinyl` to the query. Many records only have CD or digital entries there, and the filter returns nothing.
  - For a candidate's tracklist: `…/ws/2/release/<mbid>?inc=recordings+labels+artist-credits&fmt=json`. Lengths are in ms.
- **Vinyl side split:** if MusicBrainz has no vinyl medium with A/B positions, search Discogs (`discogs <artist> <album> vinyl tracklist`) or retailer listings for which tracks are on side A and which on side B. The LP can drop or reorder tracks compared with the CD; trust the vinyl listing.
- Show the user 2–3 candidates: year, country, label, cat. no., tracks per side, side lengths. Let them pick, and note the Discogs release id if found.

## 3. Map recordings to tracks, side by side
Compare each recorded file against the expected side lengths (sum of track lengths). A file's length tells you what it is: in practice a ~29 min `vinyl-001.wav` matched side B (29:28), not side A (23:10).

- **One file per song, durations within ±10% in order:** map in order.
- **A whole side (or several songs) in one file:**
  - Vinyl rarely has true silence between songs, so `ffmpeg silencedetect` usually finds nothing.
  - Use the loudness dips instead: `python3 -I .claude/skills/vinyl-catalog/dips.py "<file>" <boundary seconds…>`.
  - The boundaries are the cumulative track ends within that file, leaving out the last track's end.
  - It reports the deepest dip near each boundary and corrects for drift, since the turntable speed and a late start shift the real boundaries by seconds.
  - Cuts 30+ dB below the median are clear song gaps. **WEAK** cuts must be flagged for the user to check by ear.
  - Without a tracklist, `dips.py "<file>"` lists the deepest dips.
- **A take that bridges two songs:** a raised silence gap (e.g. 4 s, used to keep a quiet song in one piece) also swallows the short gaps between songs. A take much longer than its song probably starts or ends inside its neighbour. Look for the step in loudness, not just dips: a song change often shows as an 8–10 dB level change, not as silence. If it isn't clear, ask the user to check by ear. Don't play audio while the recorder is running: it can bleed into the recording.
- **More files than songs (false splits):** merge adjacent files whose summed length matches one song. Do it with ffmpeg concat:
  1. Write a `list.txt` with lines `file 'raw/A-03.wav'`.
  2. Run `ffmpeg -f concat -safe 0 -i list.txt …`.
- **Partial side:** if a file is shorter than its side, the recording started late or stopped early. Align from whichever end has a clear dip, and say which songs are incomplete.

Show the mapping table and wait for a yes:

| Pos | Title | Expected | Source | Start → End | Gap depth | Note |
|---|---|---|---|---|---|---|
| B1 | Derecho de nacimiento | 5:48 | vinyl-001.wav | 0:00 → 5:40.7 | 33 dB | |

## 3b. File the album under its official name
Once the release is confirmed, offer to move the folder to `~/Music/Recordings/vinyl/<official artist>/<official title>/`, e.g. `GINO SOCCIO - Face to face` → `Gino Soccio/Face To Face`.
- Only when the recorder isn't recording into it.
- Use `mkdir -p`, then `mv -n`, never overwriting. Check the WAV md5s before and after.
- If the recorder's current `folder` (from `/events`) is this album, point it at the new place so new takes don't recreate the old folder:
  - `curl -s -X POST localhost:9013/album -d '{"artist":"…","album":"…"}'`
  - This resets the recorder to side A, so set the side again on the page if needed.

## 4. Write the songs (after confirmation)
1. `mkdir -p raw`, then `mv` each source WAV into `raw/`. Check that its md5 is unchanged.
2. Fetch the cover:
   - `curl -sL -A "vinyl-catalog/1.0 (rckdrigomed@gmail.com)" -o cover.jpg https://coverartarchive.org/release/<mbid>/front-500`
   - If that 404s, use the Discogs or retailer image, or ask the user for a photo of the sleeve.
3. Cut, trim and clean each song to a 24-bit FLAC:
   - A song that is its own take: `python3 -I .claude/skills/vinyl-catalog/cut.py "raw/<src>.wav" "<pos> - <title>.flac"`.
     It finds the start and end with `dips.py --trim`: it skips the needle drop and hiss before the song, keeps a quiet intro and the whole fade-out, and cuts the hiss tail to 0.5 s after the fade.
   - A song inside a longer file: pass the dips from step 3, `cut.py "raw/<src>.wav" "<out>.flac" <start> <end>`.
     For the last song of a side, the take may end with the needle being lifted (a thump, then digital silence) instead of hiss. `--trim` then measures against the silence and keeps the run-out groove. Instead, take the end from the loudness curve: 0.5 s after the fade meets the run-out hiss.
   - Printed track lengths can be wrong for a pressing. If a song comes out much shorter than listed but ends in a natural fade, compare it with other takes before calling it incomplete. Gino Soccio's B3 is 5:23, not the 6:41 listed on Discogs.
   - Cleanup, in order:
     - highpass 25 Hz removes motor rumble and warp wobble.
     - adeclick removes crackle and pops.
     - afftdn 10 dB is a gentle hiss reduction; stronger sounds underwater.
     - A 10 ms fade-in and a 0.5 s fade-out stop the cuts from clicking.
     - Two-pass loudnorm in linear mode brings the song to −16 LUFS with one gain for the whole song, so the dynamics aren't squashed. A true-peak ceiling of −1.5 dBTP can leave a loud song slightly under −16.
   - It takes about 1.5 min per 7 min song (adeclick is the slow part). Run the songs of an album in parallel with `&` … `wait`.
   - In file names, replace `/ : ? * " < > |` with `-`.
   - To redo a song that is already tagged, cut it to a temporary name. Copy the tags (`metaflac --export-tags-to=- old | metaflac --import-tags-from=- new`, after `--remove-all-tags` on the new file) and the picture. Then swap the files.
4. Tag each file and embed the cover:
   ```
   metaflac --remove-all-tags \
     --set-tag="TITLE=…" --set-tag="ARTIST=…" --set-tag="ALBUMARTIST=…" --set-tag="ALBUM=…" \
     --set-tag="TRACKNUMBER=<n overall>" --set-tag="TRACKTOTAL=<n>" --set-tag="DISCSUBTITLE=Side A" \
     --set-tag="DATE=<year of this pressing>" --set-tag="ORIGINALDATE=<first release year>" \
     --set-tag="LABEL=…" --set-tag="CATALOGNUMBER=…" --set-tag="MUSICBRAINZ_ALBUMID=<mbid>" --set-tag="SOURCE=Vinyl" \
     --import-picture-from=cover.jpg "<file>.flac"
   ```
5. Write `album.json`, which a vinyl-web cover and tracklist view can read later:
   ```json
   { "artist": "", "title": "", "year": 0, "originalYear": 0, "label": "", "catno": "", "country": "", "mbid": "", "discogs": "",
     "cover": "cover.jpg", "recorded": "YYYY-MM-DD",
     "tracks": [{ "position": "B1", "title": "", "file": "B1 - Title.flac", "length": 348.8, "recorded": 340.7,
                  "source": "raw/vinyl-001.wav", "start": 0, "end": 340.7, "gapDb": 33, "note": "",
                  "clean": "highpass 25, adeclick, afftdn 10, loudnorm -16 linear" }] }
   ```

## 5. Research → notes.md
Do 4–6 searches and fetches:
- Wikipedia (also Spanish Wikipedia for Latin American artists)
- MusicBrainz/Discogs credits
- one or two reviews or interviews
- anything specific to this pressing (reissue label, colour, numbered edition)

Write `notes.md`:
```markdown
# <Artist> — <Album> (<year>)
## About
## This pressing
## Credits
## Track notes
## Listening notes
## Sources
```
- **About:** context, where the album sits in the artist's career, what it's known for.
- **This pressing:** label, cat. no., country, year, colour/edition, matrix if known.
- **Credits:** producer, arrangers, musicians, studio.
- **Track notes:** only real facts: singles, covers of other songs, guests, awards.
- **Listening notes:** leave this empty for the user.
- **Sources:** a numbered list of links.

Every factual sentence needs a source reference like [1]. Write "not found" instead of guessing.

## 6. Report back
Keep it short:
- the songs written
- any WEAK cuts to check by ear, with timestamps
- incomplete songs
- where the cover and notes are

Also mention that FLACs don't show in the DDJ deck browser (it plays WAV/AIFF), while the original WAVs stay in `raw/`.
