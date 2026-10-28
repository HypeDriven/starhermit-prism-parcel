# Prism Parcel — Game Specification

**Genre:** spatial block puzzle · **Players:** 1 (asynchronous high-score board) ·
**Runs on:** the StarHermit engine 1.22.0 (`engine.minor=20`), natively in the StarHermit client and in
browsers through the engine's web runtime (`index.html` is the engine's loader) ·
**Locales:** en-US, en-GB, es-419, es-ES, de-DE, fr-FR, fr-CA, pt-BR, it-IT.

Players place three-piece offers on a ten-by-ten board; completed rows and columns clear together. The
setting is a luminous tabletop of frosted blocks floating in a softly lit dome.

## 1. Rules (src/rules.js, unchanged from the browser build, shared with server.js)

- The board is 10 × 10. Three pieces are offered at a time (27 shapes in three tiers, six hues); when all
  three are placed a new offer is drawn from the round's seeded stream (mulberry32). Easy draws tier 0,
  Medium tiers 0–1, Hard all tiers.
- A placement is legal when every cell is on the board and empty. Illegal attempts are counted
  (`invalid`, a tie-breaker) and logged in the replay.
- Full rows and columns clear together. Score per placement: 1 per placed cell + 10 per cleared cell +
  25·k(k−1)/2 for k ≥ 2 simultaneous lines + 15·(streak − 1) for consecutive clearing placements.
- The round ends when no offered piece fits, a Journey goal is met (score, lines or placements), or a
  Journey move limit is reached. Undo is single-step and only in Practice and Learn. The hint is the first
  legal placement in scan order (the same legality API as play).
- State is serializable with an FNV-1a hash; replays (seed, options, commands) re-run to the same hash.

## 2. Modes and content (src/content.js)

- **Learn to Play:** five lessons on a fixed seed with small pieces (place a parcel; clear a line; clear
  together; combos; watch the board). Each needs a placement (lesson 2 a clearing one); the round then
  continues freely. Settings › Replay tutorial restarts it.
- **Journey:** 40 authored stages (Easy → Medium → Hard, score or line goals, some with move limits; every
  eighth a mastery gate). Stages unlock in order; winning earns 1–3 stars by the goal's own metric (×1.2,
  ×1.5 of the target). The setup grid shows stars, locks, and the picked stage's difficulty and goal.
- **Daily Challenge:** one seed and medium ruleset per UTC day (par shown), a score chase until no piece
  fits. The date comes from the platform's clock (`serverNow`), else the device's UTC date. The day's
  best is kept in the save.
- **Practice:** Easy / Medium / Hard on a random seed, undo, never ranked.
- **Play** resumes the round left unfinished on this device (Daily rounds are never kept), else opens the
  Journey setup.
- Achievements (First Light, Line Weaver, Streak of Prisms, Summit Courier, Keeper of Parcels) unlock once
  at the end of a round; mastery ranks follow total stars.

## 3. Screens

- **Title:** the gradient "Prism Parcel" wordmark over soft prism glows, the tagline, Play, Daily
  Challenge, Journey, Practice, Learn to Play, Help & Rules, Settings, Invite a friend (signed in) and
  Sign in with StarHermit (guests), then the Journey/stars/rank line, the profile and cloud-sync line and
  the UTC day.
- **Setup panel** (Journey / Daily / Practice) with Start and Back; the Daily shows date, seed, ruleset,
  par, ranking, today's best, expected duration and a live countdown to the next day.
- **Game screen:** the 3D table fills the playfield; the score HUD (score, objective, combo) at the top,
  Hint / Undo / Pause at the top right (top left with Left-handed controls), the offer tray at the bottom
  (each piece's shape as a grid thumbnail and its name; placed slots dim), the lesson card under the HUD
  (in the top-left corner on short landscape screens). From 1024 logical px the rails sit either side:
  Objective and Progress (goal, moves, lines) on the left; mode with turn and seed, the Daily board (top
  eight when signed in, else today's local best) and the controls on the right. Narrower, ☰ opens both
  rails as side panels under the HUD. At ≤ 640 px the HUD shows the score only.
- **Results:** heading and reason, the score breakdown (piece cells, cleared cells, simultaneous bonus,
  combo bonus, total, lines, pieces, invalid actions, time), unlocked achievements, the Daily comparison,
  the leaderboard line, Retry / Next (won Journey stages) / Home.
- **Pause** (Resume, Settings, Help, Leave Round), **Settings** and **Help** (rules, controls with the
  player's current key bindings, the piece list) open as dialogs; Escape closes them.

## 4. Controls

| Action | Keys | Gamepad |
| --- | --- | --- |
| Move the cursor | Arrows | D-pad / left stick |
| Select piece 1–3 | 1 2 3 (numpad too) | — |
| Next piece | N | X (West) |
| Place at the cursor | Enter / Space | A (South) |
| Clear selection | C | B (East) |
| Hint / Undo | H / U | Y (North) / left shoulder |
| Pause / close | Escape | Start |

Pointer and touch: tap a tray piece (or a piece in the 3D offer row) then a board cell, tap a cell with no
selection to place the first offered piece, or drag a 3D offer piece onto the board (the ghost previews the
footprint: the hue when legal, red when not). A hover previews with a mouse. Players rebind keys and pads in
the runtime's Options (Settings › Key bindings). Every board cell is a named target ("Row 3 column 7,
empty"), the screen-reader board and what play scripts click.

## 5. Look and sound

- **Scene** (native/render.ts, from the old three.js r185 render.js): gradient dome, frosted table slab
  with a breathing glow disc, board plate with an emissive accent rim, 100 sockets, instanced blocks with a
  faint self-glow (a material surface hook), the ghost, the cursor ring, the 3D offer row (the selected
  piece lifted, scaled and glowing), spark bursts and flash bars on clears, drifting prism motes and a
  camera shake. Lights use three's r155+ intensities ÷ π; the room environment is r185's (renderer passed,
  lowered 3.5 m) at environment intensity 0.4; ACES at exposure 0.95. The camera fits the board (and the
  offer row when it shows: hidden in narrow portrait and frames under 520 px tall) into the band between
  the HUD and the tray, through the camera's view offset.
- **Graphics levels** (native/quality.ts): the runtime's tier picks the old preset — Low (Lambert, no
  shadows or post), Balanced (Standard, 1024 shadows, bloom, grade, FXAA, reflections, detail, motes), High
  (clear-coated Physical, 2048 shadows, GTAO, SMAA), Ultra (4096 shadows, full GTAO, MSAA, full-resolution
  bloom/AO); sparks and motes scale with the level. Render scale, adaptive resolution, frame-rate limit and
  the readout are the runtime's.
- **Themes:** Aurora, Ember, Frost, Meadow, Dusk recolour the dome, fog, lights, table, rim and motes; the
  colour-vision-safe palette swaps the six block hues.
- **Sound** (native/audio.ts): the authored one-shots in sfx/ (click, select, invalid, three placement
  variants, single/multi clear, replenish, win, round over, achievement), the lesson chime, a quiet
  ambience pad and an arpeggio music stem rendered once into looping clips on the music bus. Volumes,
  mute and the voice limit are the runtime's Options. Sound captions (an option) announce events.

## 6. Settings and accessibility

The game's own options, kept with the account (`starhermit:storage` settings): Visual theme,
Color-vision-safe palette, Sound captions, Left-handed controls (the HUD buttons move to the top left),
Haptics (vibration on placements and clears), and Replay tutorial. Sound, graphics, language, larger text,
high contrast (the old high-contrast token set) and reduced motion (no sparks, flashes, shake or ambient
motion) are the runtime's Options, opened from Settings. Announcements go to screen readers
(`ui.announce`); every control is focusable and every cell is a named target.

## 7. Platform

- **Save** (`saves`, schema 1): `{ v, progress }` — Journey unlock, stars, best scores, achievements
  (first unlock time), tutorial flag, pieces placed, daily bests. Conflicting device/account saves merge
  (the old mergeProgress: maxima, earliest unlocks, unions). The browser build's cloud slot (`game:<slug>`,
  `{ v, savedAt, settings, progress }`) shows as foreign: its progress merges in, its game options carry
  over, and it is replaced once. Its account settings-KV keys are adopted then removed. Browser
  localStorage progress of guests does not migrate.
- **Round snapshot:** the round in progress is kept on the device (`storage`, key `round`), hash-checked
  on resume.
- **Leaderboard:** signed in, a finished Journey or Daily round posts its total to the `high-score` board
  through score-script.js (a practice session; the script range-checks the score) and shows the rank.
  Results come only from the server script. There is no multiplayer.
- **Lifecycle:** a hidden window pauses the round, keeps its snapshot and flushes the save.

## 8. Code

`src/` — rules.js, content.js, progress.js (save model), strings.js / i18n.js / platform-i18n.js (pure
ES modules shared with node tests and server.js). `native/` — main.ts (flow, input, commands, clock),
screens.ts (starhermit:ui), render.ts (starhermit:scene), platform.ts, audio.ts, quality.ts, style.ts,
i18n.ts, game.ts (typed facade). `tools/ui-style.css` → `assets/ui-style.json` (`npm run css`);
`tools/bake-noise.mjs` bakes the frosted noise maps into `assets/`. `server.js` is a local development
server (static files plus replay-validating daily endpoints) and is not part of the package.

## 9. Checks

- `npm test`: rules, server, save-model and translation-coverage unit tests (node --test), then
  `tests/native.mjs`: the web index is current, `tsc`, `starhermit check` with no warnings, and the play
  scripts in `tests/native/` as render checks (Journey stage 1 to results and stage 2, the lessons,
  Practice with a 3D drag, undo, hint, settings and help on a wide window, the Daily to its results, the
  title's panels and resume, a phone by touch at DPR 3, a phone held sideways).
- `npm run test:browser`: the packaged loader in Chrome on the GPU at desktop, phone (DPR 3) and phone
  landscape, played by keyboard, mouse drag and touch, with no console errors.
- `npm run package` after every change (regenerates `index.html` and `starhermit-files.json`).

## 10. Known limitations

- The old design document's Challenge and Score chase modes were never built; the game has Learn, Journey,
  Daily and Practice.
- Solo scores are the client's total range-checked by score-script.js (no server replay verification).
- The haptic patterns are single pulses (the runtime vibrates for a duration).
