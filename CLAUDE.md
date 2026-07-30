# OpenAir Timesheet Importer — Chrome Extension Build Spec

## Goal
Build a Manifest V3 Chrome extension (unlisted on Chrome Web Store) that lets a
non-technical user drag their weekly Excel timesheet onto the OpenAir
timesheet page and have it fill in hours + notes automatically, with a
confirmation step before anything is written to the page.

User's required workflow (do not add steps beyond this):
1. Open the OpenAir weekly timesheet page (already logged in).
2. Drag their `.xlsx` file onto a panel injected into the page (or click the
   panel to open a file picker — support both).
3. Review a preview table showing what will be entered.
4. Click "Confirm" → data is written into the OpenAir form. Click "Cancel" →
   nothing happens, user fixes their Excel file and retries.

No console, no bookmarklet, no copy-pasting scripts. This replaces an existing
manual workflow where the user runs a hand-built JS snippet in DevTools.

## Already scaffolded (in this folder, use as-is)
- `manifest.json` — MV3 manifest, content script injected on
  `https://*.openair.com/*`. **The host_permissions match pattern is a
  placeholder — confirm the company's actual OpenAir URL (e.g.
  `https://na1.openair.com/*` or a custom subdomain) and update it.**
- `lib/xlsx.full.min.js` — SheetJS bundle, already vendored locally (required
  since MV3 disallows remotely-hosted/CDN-loaded code execution). Load this
  before `content.js` in the manifest (already wired).
- `icons/icon16.png`, `icon48.png`, `icon128.png` — placeholder icons, replace
  with real branding if desired before publishing.

## Still to build
- `content.js` — all logic described below.
- `content.css` — styling for the injected drop-zone panel and confirmation
  modal.

## Input: Excel file format
Columns are day-pairs: `Sunday time`, `Sunday notes`, `Monday time`,
`Monday notes`, ... through Saturday (header text may vary slightly in
casing/spacing — match flexibly, e.g. `/sun(day)?\s*time/i`). The first two
columns are `Client` and `Task`, entered as free text by the user (not
dropdowns — that's only true in the Excel sheet). Each row in Excel = one
client/task combination for that person's week.

Parse with SheetJS (`XLSX.read` on FileReader result, `XLSX.utils.sheet_to_json`
with `header: 1` to get raw rows so the header row can be matched flexibly
rather than assuming exact column names).

## Output target: OpenAir DOM
OpenAir's timesheet grid uses input IDs of the form:
- Hours input: `ts_c{col}_r{row}`
- Notes trigger (clickable cell that opens a dialog): `ts_notes_c{col}_r{row}`
- Notes textarea (inside the dialog that opens): `tm_notes`
- Notes dialog OK button: `.dialogOkButton`

`col` = day of week, 1 (Sunday) through 7 (Saturday). **Confirm this mapping
against the live page** — verify column 1 actually corresponds to the Sunday
input before shipping, since this was inferred from a working script rather
than direct inspection.

`row` = an OpenAir-internal row index. **It is not known in advance** — it has
to be resolved by matching the Excel row's `Client` + `Task` text against
whatever client/task labels appear in the actual OpenAir page for that user's
timesheet, since OpenAir uses dropdowns for Client/Task and row order is not
guaranteed to be stable or known ahead of time.

### Row resolution algorithm
1. Enumerate candidate rows by finding all elements matching
   `id^="ts_c1_r"` (col 1 is guaranteed present for every active row) and
   extracting the row number from each ID.
2. For each candidate row, find the nearest ancestor `<tr>` (or row container)
   and extract its visible text content (this will include the
   selected/displayed Client and Task dropdown values as rendered text).
3. Normalize text (lowercase, strip whitespace/punctuation) on both the
   OpenAir row text and the Excel `Client`/`Task` strings.
4. Score each candidate row against the Excel row using a simple string
   similarity measure (e.g. token overlap / Dice coefficient — no external
   library needed, write a small pure-JS function).
5. Decision logic:
   - One row scores clearly highest (e.g. score ≥ 0.8 and at least 0.2 above
     the next-best) → auto-match, no user input needed.
   - Multiple rows score closely (within ~0.15 of each other) → surface a
     disambiguation prompt: show the Excel row's Client/Task text and render
     a button per candidate OpenAir row (showing that row's actual label),
     plus a "Skip this row" button. Wait for the user's click before
     continuing to the next Excel row.
   - No row scores above a low threshold (e.g. < 0.3) → flag as unmatched in
     the preview table, do not silently guess.
6. Cache resolved matches for the session so the same Client/Task pairing
   isn't asked about twice if it repeats across multiple weeks of testing.

This matching step must run and fully resolve (including any user
disambiguation clicks) *before* the confirmation modal is shown, so the
preview table reflects final resolved rows.

## Confirmation modal (critical — do not skip or auto-fire)
After parsing + row resolution, render a modal (plain JS/DOM, no external UI
framework) showing a table with one row per parsed entry:
`Day | Client | Task | Hours | Notes (truncated) | Resolved OpenAir row`

Include "Confirm" and "Cancel" buttons. Only call the fill routine after
explicit Confirm. Any entry that failed to resolve a row should be visually
flagged (e.g. red background) and excluded from what gets written, with a
note telling the user to fix it in Excel and re-drag.

## Fill routine (adapt from existing working script, reuse the pattern below)
```js
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fillTimesheet(entries) {
  for (const entry of entries) {
    const inputId = `ts_c${entry.col}_r${entry.row}`;
    const notesId = `ts_notes_c${entry.col}_r${entry.row}`;
    const input = document.getElementById(inputId);
    if (!input || input.disabled) continue;

    input.value = entry.hours;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    if (entry.notes) {
      await delay(200);
      document.getElementById(notesId).click();
      await delay(350);
      const textarea = document.getElementById('tm_notes');
      if (textarea) {
        textarea.value = entry.notes;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await delay(200);
      document.querySelector('.dialogOkButton').click();
      await delay(200);
    }
  }
}
```
After completion, show a simple success toast/banner in the injected panel
(not just a console.log — the user can't see DevTools).

## Drop-zone UI
Inject a small fixed-position panel (e.g. bottom-right corner) on page load,
only when the timesheet grid is detected on the page (don't inject on other
OpenAir pages). Panel should:
- Accept native drag-and-drop (`dragover`, `drop` events) of a single `.xlsx`
  file.
- Also be clickable to open a standard file `<input type="file" accept=".xlsx">`
  picker, for users who find drag-and-drop unreliable.
- Reject non-`.xlsx` files with a clear inline message, not a silent failure.

## Error handling requirements
- If the Excel file can't be parsed (wrong format, missing expected headers),
  show a specific error in the panel — don't fail silently or only log to
  console, since the user has no visibility into DevTools.
- If OpenAir's expected DOM elements (`ts_c1_r*` etc.) aren't found at all on
  the page, show an error like "Timesheet grid not detected — make sure
  you're on the weekly timesheet entry page."
- Wrap the fill routine in try/catch per entry so one failure doesn't abort
  the whole batch; report which entries succeeded/failed in a final summary.

## Open items requiring confirmation against the real OpenAir page before shipping
1. Exact OpenAir host/URL pattern for `host_permissions` and `matches`.
2. Confirm `col` 1–7 really maps Sunday–Saturday in the live DOM (not just
   inferred from the existing script).
3. Confirm the actual HTML structure around `ts_c{col}_r{row}` inputs (is the
   nearest row container really a `<tr>`? Inspect via browser DevTools on a
   real timesheet page) so the row-text-extraction step in matching works.
4. Decide Chrome Web Store listing details (name, screenshots, privacy
   statement — required even for unlisted apps since the extension reads a
   local file and writes to a third-party site's DOM).

## Out of scope
- No OpenAir native import (confirmed not available for this org).
- No external server/backend — everything runs client-side in the extension.
- No `localStorage`/remote storage of timesheet data — process in-memory per
  session only, given this includes potentially sensitive work notes.

---

## SESSION STATE — last updated 2026-07-01 (session 6)

> Session 6 was a LIVE debugging session driven through Claude-in-Chrome against the
> real logged-in timesheet. Several long-standing theories were confirmed/disproven.

### Confirmed facts about the live OpenAir page (SuiteProjects Pro)

- The page has **jQuery 3.5.1** in the MAIN world and a global `OA` object, plus globals
  `change_options` (fn, 2 args), `project_tasks` (fn), `Selectize`, `grid_submit_popup`.
- Client:Engagement select `ts_c1_r{n}` options are `"customerId:projectId"` (e.g. `1585:3779`),
  label `"Client : Engagement"`. Task select `ts_c2_r{n}` options are `"taskId"` value,
  label `"NN: Task Name"`. Both carry `shadowid`/`shadowname` + `select-oa timesheetControlPopup`.
- **DISPROVEN: the isTrusted / jQuery-only theory.** Setting `ts_c1_r{n}.value` and dispatching a
  plain synthetic `change` (isTrusted=false) DOES make OpenAir load that row's task options and
  spawn the next empty row. No user gesture, no jQuery needed. Synthetic events are enough.
- **How rows really work:** committing a Client:Engagement on the single empty-row control
  (`select.timesheetEmptyRowControl`) makes OpenAir (a) load that row's tasks and (b) auto-spawn
  the NEXT empty row. So to build N rows you just commit the empty-row control N times. The old
  "select firstReal → reset to blank → click Add-duplicate-row N-1×" dance was fighting this and
  never loaded tasks. Row numbers came back sequential (r1,r2,r3) but code no longer assumes that.
- Hours inputs `ts_c3..c9_r{n}` are NOT disabled before a task is chosen. Task select + hours both
  accept synthetic value+change and stick. Notes flow (`ts_notes_*` → dialog → `tm_notes` →
  `.dialogOkButton`) works and does not navigate.
- Committing rows does NOT persist unless Save is clicked — a plain reload discards everything.
- **"Leave site? Changes may not be saved" prompt** = the page's `window.onbeforeunload`. The
  content script runs in the ISOLATED world, so its `window.onbeforeunload = null` could never
  clear the PAGE's handler → prompt kept firing on Restart/Save/cross-month navigation.

### Session 6 changes

- **`exposeAndFillClientEngagement(ceValues)` REWRITTEN** — commit-based: for each value, find the
  current `timesheetEmptyRowControl`, set value + dispatch input/change, wait until a new empty row
  spawns, record the REAL row number. Returns an array (parallel to ceValues) of real row numbers
  (null for blank). Verified live: 3 values → rows r1/r2/r3 with 9/9/7 task options loaded.
- **Callers updated to use the returned row numbers** instead of assuming `idx+1`:
  Phase-1 `#oai-p1-ok` handler, and the cross-month block (also remaps `entry.row` + a new
  `taskMapNext` keyed by the new month's rows). Cross-month path is UNVERIFIED (no cross-month sheet
  was available to test).
- **Leave-site fix:** new MAIN-world content script `page-helper.js` (manifest: second
  content_scripts entry with `"world": "MAIN"`, `run_at: document_start`) listens on the shared
  `document` for `oai-clear-beforeunload` and nulls the page's `window.onbeforeunload`. content.js
  has a `clearBeforeUnload()` helper (dispatches that event) called before every intentional
  navigation: `clickSave`, `clickNextMonthLink`, and the Restart reload.
- Task auto-match (added session 5) is unchanged and now actually has options to match against once
  rows are built correctly.

### ⚠️ Tooling hazard discovered this session

The **Edit/Write tools TRUNCATE files** in this environment (not just content.js — it silently cut
`manifest.json` mid-word and lopped the tail off `CLAUDE.md`). Use bash/python heredocs for ALL file
writes here, then validate (`node --check`, `python3 -c "import json; json.load(...)"`). manifest.json
and this file were rebuilt via bash after the Edit tool corrupted them.

### Still to verify (next live session)

- Reload the extension and run a real .xlsx end-to-end: confirm rows build, tasks auto-match into the
  Phase-2 modal, hours+notes fill, and NO "Leave site?" prompt on Restart/Save.
- Cross-month fill path (needs a timesheet that spans two months).
- Whether the user's build has `DEV_MODE=true` (save skipped) — flip to false to actually save.

## SESSION STATE — session 5 (task auto-matching + fill diagnostics)

- Added `resolveTaskForRow(taskText, taskOpts)` near `scoreMatch` — scores the Excel task string
  against live task option labels (strips the "NN: " ID prefix first), reuses `scoreMatch` + 0.4
  threshold, returns best value or null.
- `buildPhase2Grid`: when task options are already present, auto-selects the best match and seeds
  `taskMap` (falls back to "— leave blank for import —").
- `showTaskSelection`: builds a `rowTaskText` (rowNum→Excel task) map; `pollTaskOptions` auto-selects
  the best match the moment options load.
- `handleFile`: captures `fillTasksAndHours` results; if any entries fail, the completion modal lists
  them (Day + reason) instead of a blanket success.

## SESSION STATE — session 4 (reference)

### Folder structure
```
openair-timesheet-google-extension/
  features/appearance/{appearance.js, appearance.css}   ← ACTIVE (loaded by popup.html)
  popup/{popup.html, popup.css, popup.js, features/(STUBS)}
  content.js, content.css, manifest.json, page-helper.js (session 6)
  lib/xlsx.full.min.js, template.xlsx, assets/ (9 cat emotes)
```

### OpenAir DOM mapping (confirmed)
- `ts_c1_r{row}` = Client:Engagement select (col 1); blank row also has class `timesheetEmptyRowControl`
- `ts_c2_r{row}` = Task select (col 2)
- `ts_c3_r{row}`..`ts_c9_r{row}` = hours Sun–Sat  (DOW_TO_COL = [3,4,5,6,7,8,9])
- `ts_notes_c{col}_r{row}` = notes trigger; dialog textarea `tm_notes`; OK button `.dialogOkButton`
- Client matching: Dice bigram on client name only, threshold 0.4

### Two-phase modal flow
1. Phase 1 "Step 1: Review Data" — user reviews Client:Engagement dropdown per row.
2. "Step 2: Tasks" → `exposeAndFillClientEngagement` builds the rows (see session 6 rewrite).
3. Phase 2 "Step 2: Input Tasks" — review task + hours, "Fill Timesheet" writes; Restart reloads.

### Key functions in content.js
- `exposeAndFillClientEngagement(ceValues)` — builds rows, returns real row numbers (session 6).
- `fillTimesheet(entries)` / `fillTasksAndHours(entries, taskMap)` — write hours+notes / tasks+hours.
- `resolveRows`, `scoreMatch`, `resolveTaskForRow`, `buildPhase1Grid`, `buildPhase2Grid`, `showConfirmation`, `showTaskSelection`.
- `clearBeforeUnload()` (session 6) — dispatches the main-world onbeforeunload-clear event.

### Other known items
- `DEV_MODE = true` at top of content.js skips both `clickSave()` calls — set false before shipping.
- `fillClientEngagements` (old) still defined but NOT called — safe to remove.
- GIF loading modal exists (`showGifLoadingModal`) but is not wired in.

### Security constraints (must never be violated)
- No `localStorage` / `sessionStorage` — timesheet data is sensitive.
- No external server/backend. No remotely-hosted JS (MV3; SheetJS vendored at `lib/xlsx.full.min.js`).

## SESSION STATE — session 7 (isolate single-month fill)

- **Cross-month nav DISABLED** behind `var CROSS_MONTH_ENABLED = false;` (under DEV_MODE). In
  handleFile, right after `detectCrossMonth()`, `crossMonth` is forced to `{isCross:false}` when the
  flag is off — this suppresses BOTH the cross-month warning banner and the `clickNextMonthLink()`
  navigation. That navigation was firing the page's onbeforeunload ("Leave site?") on Fill and, on a
  2-month sheet, running before/around the fill. Re-enable by flipping the flag once single-month is solid.
- With cross-month off AND DEV_MODE=true, the Fill path performs NO navigation, so no "Leave site?"
  prompt should appear on Fill regardless of whether page-helper.js is active.
- **Added "↻ Refresh tasks" button** to the Phase 2 modal (`#oai-p2-refresh`). Calls new
  `refreshTaskOptions()` which, per task <select>, re-reads `enumerateTaskOptions(rowNum)` from the
  live DOM (ts_c2_r{rowNum} = that row's C:E-specific tasks), rebuilds options, keeps a still-valid
  prior pick else re-runs `resolveTaskForRow` auto-match, and updates taskMap. Manual re-pull for when
  OpenAir loads tasks after the modal opened or a row came up empty.
- Delays trimmed 100ms across setup/fill (commit poll 200→100, trailing 300→200, waitForTaskOptions
  200→100, notes 200→100/350→250, task-set 300→200).
- REMINDER: after reloading the extension, the OpenAir PAGE must be refreshed for page-helper.js
  (MAIN world, document_start) to inject — reloading the extension alone does not re-inject into
  already-open tabs.

## SESSION STATE — session 8 (ROOT CAUSE: blank tasks + fill not firing)

- **Confirmed the real bug (live test):** the entry key uses a `'\x00'` separator
  (`clientEngagement + '\x00' + task`). Phase 1 wrote that key into a `data-key` HTML
  attribute and read it back to map rows. HTML parsing replaces NULL (U+0000) with U+FFFD
  (65533), so `dataset.key` NEVER equaled the in-memory key → every entry's `row` resolved
  to `null`. Consequences: `fillTimesheet` skipped all rows ("Fill didn't fire") AND
  `buildPhase2Grid` emitted `data-row=""` so the task poll skipped every select (all
  dropdowns stuck on "— leave blank for import —"). Verified live: `'a\x00b'` written to a
  data attr reads back with charCode 65533 at the separator.
- **Fix:** Phase 1 `#oai-p1-ok` now maps entirely IN MEMORY. It builds `orderedKeys` from
  `entries` (unique CE+Task in grid order — the client <select>s render one-per-key in that
  same order, so index i aligns with `ceArr[i]`), then assigns `e.row`, `e.matchedValue`,
  `e.matchedLabel` directly. No `data-key` round-trip. `finalEntries` now just clones
  `resolved` (which already carries row/matchedValue/matchedLabel); the old `p1.matchMap`
  lookup is gone. `matchMap` is still created/returned but unused by the main path.
- **Fill Timesheet** consequently targets existing rows by id (`ts_c2_r{n}`, `ts_c{col}_r{n}`,
  `ts_notes_c{col}_r{n}`) and never creates rows. "↻ Refresh tasks" re-reads each row's
  live options via `enumerateTaskOptions(rowNum)` (now that rowNum is correct).
- **Cross-month:** DETECTION restored so the warning banner shows again for 2-month sheets;
  only the auto-navigation stays gated behind `CROSS_MONTH_ENABLED=false`. Banner text is now
  conditional (single-month-fill wording while nav is disabled). Removed the earlier
  `crossMonth={isCross:false}` override that had wrongly hidden the banner.
- **Button positioning:** `.oai-conf-actions` is `justify-content: space-between`; with the
  banner gone the lone button group slid left. Restored banner + added `margin-left:auto` to
  `.oai-conf-buttons` so Back / Step 2 stay right-aligned with or without a banner.
- STILL NEEDS a live end-to-end run (reload extension + refresh page + drop file).

## SESSION STATE — session 9 (themes + save removal + audit cleanup)

- **Save-on-behalf REMOVED entirely** at the user's request. Deleted `clickSave()`, both save
  blocks in `handleFile`, and the now-unused `DEV_MODE` flag. The tool fills task + hours + notes
  and the user clicks OpenAir's Save themselves. (`clickNextMonthLink`/`waitForTimesheetGrid` remain
  for the still-gated cross-month feature; `CROSS_MONTH_ENABLED=false`.)
- **Color themes reworked.** COLOR_OPTIONS (appearance.js) and THEME_ACCENTS (content.js) are now:
  slate "Netsuite Slate (default)" #44536B, santorini "Santorini Blue" #00308F,
  positano "Positano Pink" #FC8EAC, amalfi "Amalfi Coral" #F89880, provence "Provence Purple" #7C3AED.
  Keys MUST stay in sync between the two files.
- **Accent is now a CSS variable.** content.css hard-coded slate (#44536B/#303d50) was replaced with
  `var(--oai-accent[-dark]/-soft, …)`. `buildThemeCSS` emits `:root{--oai-accent…}` so the chosen
  colour flows to the panel header (accent in all modes now), dropzone, spinner, buttons, etc.
- **Radio dot** follows the accent in ALL modes (light/dark/cool) — the dark/cool white-dot override
  was removed.
- **Dead code removed:** `fillClientEngagements`, `showGifLoadingModal` (rollGif/OAI_GIFS kept for the
  surprise button).
- **Popup:** "Report a bug" hidden (HTML-commented, restore later); "Email the developer" copies
  q.hoang@connorgp.com to clipboard (+`clipboardWrite` perm); "Leave a review" awaiting CWS URL;
  "Download example" (example.xlsx) added above "Download template".
- **Audit — still open (user decision):** permissions could narrow `tabs`→`activeTab` and drop
  `clipboardWrite` (user unsure, left as-is); Google Fonts intentionally kept loading REMOTELY.
- No remote code, no localStorage, no external data calls; esc() applied to user data in innerHTML.

## SESSION STATE — session 10 (gif registry + theme finalisation)

### Color themes (final)
COLOR_OPTIONS (appearance.js) and THEME_ACCENTS (content.js) — keys MUST stay in sync:
- `slate`  "Netsuite Slate (default)" #44536B / #303d50
- `nam`    "Nam Blue"    #0166B1 / #014E86
- `sias`   "Sias Violet" #833AB4 / #6B2E93   (dropdown order: after Nam, before Wilson)
- `wilson` "Wilson Orange" #F77737 / #DD5E1E
- `coe`    "COE Green"   #075E54 / #054A42
Accent flows via CSS var `--oai-accent[-dark]/-soft` (content.css) + `:root{…}` emitted by
buildThemeCSS. Panel header is accent in ALL modes; radio dot follows accent in ALL modes.
Note: white text sits on the accent (header/primary buttons) — fine for these five.

### Gif registry ("surprise" button)
- **`gifs.js`** is a NEW content script (manifest isolated entry, loaded BEFORE content.js):
  `js: ["lib/xlsx.full.min.js", "gifs.js", "content.js"]`. It sets `window.OAI_GIFS`, a list of
  `{ url, alt, chance? }` loaded from the emoji.gg CDN (remote images — not remote code, MV3-ok).
- **Probabilities:** pinned entries use their `chance`; unpinned split the leftover evenly and the
  total is normalised to 100% at roll time in `rollGif()`. Adding more gifs later "just works".
  Currently pinned: sneakycat 5, Scubbacat 1, shocked 1, Doggorun 2; the other 5 share ~18.2% each.
- `content.js` has an inline `OAI_GIFS_FALLBACK` (same list) used ONLY if `window.OAI_GIFS` is
  missing, so the button never dead-ends. gifs.js is the editable source of truth.
- Surprise handler: hides the button on click, swaps the completion-modal body to the gif + its
  effective % ("this gif had a N% chance…"), image via the direct CDN URL.
- REMINDER: adding gifs.js to the manifest requires a full EXTENSION RELOAD (not just page refresh)
  before it injects.

### Verified live this session (via Claude-in-Chrome)
- OpenAir page CSP does NOT block `chrome-extension:` images, `data:` images, or emoji.gg CDN images
  (tested with securitypolicyviolation listener — no violations). So gif rendering is not a CSP issue.
- The earlier broken-gif was the assets/chrome-extension path on a stale content script; remote CDN
  URLs avoid `chrome.runtime.getURL` entirely and render regardless of extension-context state.

### Cross-month status (unchanged, still gated)
`CROSS_MONTH_ENABLED = false`. Detection still shows the warning banner ("Only the current month
will be filled, switch to the other month and run again"); the auto-navigation
(`clickNextMonthLink`/`waitForTimesheetGrid`) is suppressed. Those helpers remain in code for when
the feature is re-enabled. OPEN PRODUCT QUESTION (see session 10 chat): auto Save+navigate+refill
both months vs. just instruct the user to switch months and re-run.

## SESSION STATE — session 11 (Chrome Web Store prep + surprise feature removed)

Focus: getting the extension through Chrome Web Store review (it was rejected once for generic
"Program Policies" — most likely single-purpose + remote content from the surprise gifs).

### Permissions trimmed (manifest.json)
- `permissions` is now `["activeTab", "storage"]` — DROPPED `clipboardWrite`, and narrowed `tabs`→`activeTab`.
  - The "Email the developer" copy button now has a `document.execCommand('copy')` fallback so it works
    without `clipboardWrite` (see popup.js).
  - `activeTab` covers the popup's OpenAir-detection URL read + messaging (both happen after the user
    opens the popup); theme also propagates via `chrome.storage.onChanged`, so nothing relies on `tabs`.
- `web_accessible_resources` resources = `["template.xlsx", "example.xlsx"]` (dropped `assets/*`).

### Remote resources removed (was the "remote code" flag)
- Google Fonts load REMOVED: the `<link>`s in popup/popup.html and the `@import` in content.css are gone.
  UI now uses the system-font fallback stack. (Couldn't bundle Inter — can't fetch font binaries here.)

### Surprise / GIF feature FULLY REMOVED
Removed everywhere for the store build (single-purpose + remote-content risk):
- content.js: `rollGif`, `computeGifWeights`, `OAI_GIFS_FALLBACK`, the surprise button + click handler +
  emote preload in `showCompletionModal`, and all `_hideSurprise` / `oai_hide_surprise` plumbing.
- `gifs.js`: emptied to a one-line comment (mount blocks deletion) and DE-REGISTERED from the manifest
  content_scripts (js is now `["lib/xlsx.full.min.js", "content.js"]`).
- popup: the whole **Preferences** section + `#oai-surprise-pref` toggle removed (html + js).
- CSS: gif styles removed from content.css; `.oai-pref-row`/`.oai-switch` removed from popup.css.
- Completion modal is now just: "Complete" header, checkmark, "thank you for using the extension",
  the Audit Log (only on failures), and a **Close** button.
- **Full rebuild recipe saved at `docs/SURPRISE_FEATURE_REBUILD.md`** (registry format, the 16-emote
  list + chances + the reward, the random-weights-to-100% logic, the spinner→reveal handler, popup
  toggle, CSS, manifest wiring, and CSP/stale-context gotchas). Restore from there if wanted (unlisted
  build only, ideally with gifs bundled locally).

### Color themes (final, session-10/11)
COLOR_OPTIONS (appearance.js) + THEME_ACCENTS (content.js), keys MUST stay in sync:
- `slate` "Netsuite Slate (default)" #44536B / #303d50
- `nam`   "Nam Blue"    #1B3D82 / #143061
- `becky` "Becky Maroon" #550000 / #3D0000
- `jenna` "Jenna Purple" #6C3BAA / #572E89
- `omkar` "Omkar Gold"  #DAA520 / #B8860B
- `alec`  "Alec Green"  #40826D / #336654
Accent flows via `--oai-accent[-dark]/-soft`. NEW: `--oai-on-accent` (readableOn() in content.js)
auto-picks dark vs white text on the header/primary buttons so light accents (Omkar Gold) stay legible.

### Branding assets
- Icons (icons/icon16|48|128.png) regenerated: dropzone motif (slate header, white body, dashed box,
  upload arrow) with a slate frame so it reads on white. Generated via Pillow (supersample→LANCZOS).
- Store screenshots in `docs/store/` = 1280x800, 24-bit RGB (NO alpha), composited on a light bg with a
  soft shadow. The two modal shots (02-review-data, 03-review-tasks) have the Client:Engagement + Task
  columns lightly Gaussian-blurred to hide real client names. `docs/screenshots/` holds the raw originals.
- manifest `description`: "Drag-and-drop your weekly Excel timesheet directly into Netsuite's SuiteProjects Pro (OpenAir)."
- Download filenames: template → "Timesheet template v1.2.xlsx", example → "7.2026 Example.xlsx". The
  bottom-right PANEL download fetches the file as a blob first (page context ignores the `download`
  filename for cross-origin chrome-extension: URLs, so blob keeps the tracking name).

### README
Rewrote/aligned; removed all surprise references. Screenshots referenced from `docs/screenshots/`.

### ⚠️ Mount blocks file DELETION (rm "Operation not permitted"); in-place overwrite works.
Before zipping for the store, the user must delete by hand: `gifs.js`, the `assets/` folder,
`icons/_preview256.png`, and (optionally) the now-unused `docs/**/05-surprise.png`.

### CWS submission facts
- Private/Unlisted STILL require full review — visibility ≠ skipping review.
- Commented-out code is still scanned/visible — remove, don't comment.
- Privacy-tab justifications drafted in chat: single purpose, activeTab, storage, host permission
  (remote-code no longer applies now that fonts + gifs are gone).


## SESSION STATE — session 12 (surprise RESTORED, prefs, matching, no-consolidation, UI polish)

Big session. The user pulled the APPROVED .crx (id `ageeabfdmemlbmgdgeffgknffiapenbl`) and found it still
contained the surprise/gif feature that session 11 had removed — so we RESTORED the feature and then
made many product/UX changes. All edits validated with `node --check`. Files were edited via
bash/python (Edit/Write still truncate here). NOTE: the bash MOUNT can serve a STALE copy of files the
USER edited outside the session (hit this with gifs.js) — always confirm host state via the file tools.

### Surprise / GIF feature RESTORED (reverses session 11)
- `gifs.js` re-populated (`window.OAI_GIFS`), loaded in manifest content_scripts:
  `["lib/xlsx.full.min.js", "gifs.js", "content.js"]`; `web_accessible_resources` re-added `assets/*`.
- content.js surprise button + `rollGif`/`computeGifWeights`/`OAI_GIFS_FALLBACK` restored; popup has a
  "Surprise" preference toggle (`oai_hide_surprise`, default ON=show).
- Manifest kept the session-11 policy hardening: permissions `["activeTab","storage"]`, NO remote fonts,
  and we did NOT add the store-injected `update_url` (must never be in an uploaded manifest).
- **gifs.js `chance`**: `computeGifWeights` uses each entry's pinned `chance`; unpinned entries get a
  RANDOM share of the leftover budget; `rollGif` normalises to 100% at roll time (so displayed % =
  chance/total*100). User rebalanced values so ALL entries are pinned and sum to exactly 100.

### Preferences widget (popup) — 3 toggles, order + wording final
```
Preferences
  Fill Time/Notes Only        [oai_fill_time_notes_only, default OFF]
      Auto-match Client & Task  [oai_auto_default, default ON]   <- indented sub-option (.oai-pref-row--sub)
  Surprise                    [oai_hide_surprise, default ON=show]
```
- "Auto-match" is nested under "Fill Time/Notes Only". When the parent is ON it is DISABLED + shown OFF
  (greyed via `.oai-pref-row--disabled`); popup.js remembers the real choice (`storedAutoDefault`) and
  restores it when the parent goes OFF (programmatic `.checked` does not fire change -> storage intact).
- content.js reads both prefs on load + `chrome.storage.onChanged`: `_autoDefault`, `_fillTimeNotesOnly`.

### Auto-match ("Auto default") gating + threshold fix
- When `_autoDefault` is false: `resolveRows` returns null match, `resolveTaskForRow` returns null, and
  the Phase-1 "Refresh engagement" leaves blank -> everything shows "- leave blank for import -".
- **Single shared threshold `MATCH_MIN = 0.85`** (top of content.js) for BOTH Client:Engagement AND Task
  (both score Excel text vs the LIVE dropdown options via the same `scoreMatch`). Fixes the reported
  "nearest alphabetical" false match: shared-prefix engagements (e.g. many "Connor Group : X") used to
  score ~0.5 via Dice and latch onto the alphabetically-first sibling at the old 0.4 bar. Now only
  name-present matches (exact/prefix/all-words/substring, all >=0.85) auto-fill; else blank. Verified
  with a Node harness against real data.

### Blank Client:Engagement AND blank Task now STAY BLANK (removed Open Code Pending defaults)
- `commitPhase1` no longer substitutes "Connor Group : Open Code Pending" for a blank C:E; blank is
  committed as blank. Row creation still works via `exposeAndFillClientEngagement`'s blank path (commit
  a throwaway engagement — now PREFERS "Open Code Pending", else first option — then reset that row's
  C:E to blank).
- `fillTasksAndHours` no longer defaults an unmatched task to the row's Open Code Pending task; blank
  task stays blank. `findOpenCodePendingTask` is now UNUSED dead code (left in place).
- ⚠️ UNVERIFIED live: whether OpenAir keeps the row + hour inputs AFTER C:E is reset to blank. If hours
  don't stick on blank rows, reorder to fill hours BEFORE resetting C:E to blank. Also OpenAir may not
  let a row save with no engagement (user's side).

### NO CONSOLIDATION — grid mirrors the Excel table 1:1 (important fix)
- Root cause of "4 Cerebras rows became 3 / wrong hours": `groupKey` was `client + task`, so two Excel
  rows with the SAME Client+Task merged and their day values overwrote each other. `groupKey` is now
  UNIQUE per Excel row: `client + '\x00' + task + '\x00#' + r`. Every Excel data row = one grid row =
  one OpenAir row; no merging anywhere (Step 1, Step 2, time+notes). Verified on the user's 7-12-2026
  sheet (7 rows incl. two identical "Cerebras / NS Admin", correct per-row days).

### "Fill Time & Notes Only" mode (submitDirect's sibling)
- `buildTimeNotesGrid` + `showTimeNotesOnly`: read-only review modal (Client:Engagement + Task shown as
  text from Excel — Task rendered as an INERT `<select class="oai-conf-sel oai-conf-sel--readonly">` so
  the row height matches the Step 1/2 grids by construction; styled borderless/transparent/no-arrow/
  pointer-events:none to read as plain text, with a `.oai-conf-sel.oai-conf-sel--readonly !important`
  rule so the dark/cool theme can't turn it back into a bordered field).
- On Fill: handleFile builds one BLANK-C:E row per Excel grouping via `exposeAndFillClientEngagement`,
  then `fillTimesheet` writes ONLY hours + notes; reuses `showCompletionModal`. Info icon REMOVED from
  this modal; cross-month warning renders at footer level (inside `.oai-conf-actions`).
- Step 2 Client:Engagement cell now reflects the STEP-1 choice: matched label, or a muted italic
  "- leave blank for import -" (`.oai-conf-ce-blank`) when left blank — NEVER the raw Excel client text.
- Blank-C:E rows are excluded from `waitForTaskOptions` and never show the task loading spinner (no
  tasks to load) -> the modal opens fast for blank/all-blank sheets.

### Submit button (Phase 1) HIDDEN for now
- The "Submit >" button + its `commitPhase1(submitDirect)` path are intact but hidden via
  `#oai-submit { display: none; }` in content.css. Delete that line to bring it back.

### Popup modernisation + footer + Appearance widget
- Footer: removed the whole Community section + "Email the developer" (and its popup.js clipboard
  handler). "leave a review" (lowercase) moved to footer LEFT, linked to the CWS listing
  `https://chromewebstore.google.com/detail/openair-timesheet-importe/ageeabfdmemlbmgdgeffgknffiapenbl`
  (ID is permanent; slug may change but redirects). Dev label + GitHub grouped on the right.
- Header brand mark (accent-tinted rounded square), cards `border-radius:14px` + soft shadow,
  antialiasing, smoother toggle easing. Resources buttons Title Case ("Download Example/Template").
- Appearance widget (features/appearance/): field label renamed "Color theme" -> "Color Theme"; Slate
  label dropped its "(default)"; the COLOR picker is now clickable COLOR-CIRCLE SWATCHES (not a
  dropdown; active swatch gets an accent ring); the MODE picker is HORIZONTAL real radio buttons
  (Light/Dark/Cool, no "(default)" text). Radio dot is absolute-centred. Dark/Cool: selected radio uses
  white outline+dot and the ON preference toggle track gets a white outline (so a dark accent like Nam
  Blue stays visible). Fast custom swatch tooltip (~50ms) replaces the slow native `title`.

### Tooltip fixes (content.js)
- Notes tooltip shows when hovering the ✓/✗ note icon too (`.oai-conf-ind { pointer-events:none }`).
- Reliability: `attachTooltip` clears the shared `_tooltipTimer` on mouseenter and skips empty text.
- **z-index/reopen fix**: the singleton tooltip is `document.body.appendChild(tip)`-ed on every show so
  it sits ABOVE the current modal overlay (overlay + tooltip share max z-index; on modal REOPEN the
  fresh overlay was landing after the tooltip and covering it — this broke the header "(i)" info-icon
  and grid tooltips on the 2nd+ open).
- Step-instruction text: ", leave as blank" -> ", select - leave blank for import -".

### Still open / to verify live (next session)
- Blank-C:E row fill (does OpenAir keep the row after the C:E reset-to-blank? see above).
- Cross-month path still gated (`CROSS_MONTH_ENABLED = false`).
- Dead code: `findOpenCodePendingTask` (unused now), `fillClientEngagements` (still unused).
- Re-zip for CWS: surprise/gifs are BACK, so the store listing/justifications differ from session 11
  (remote gif images from emoji.gg CDN again — not remote code, but note it for review).

## SESSION STATE — session 13 (cross-month false positive fix)

- **BUG (reported live):** on 2026-07-27 a user viewing the **Jul 19–25** timesheet (single month)
  got the modal warning "this timesheet spans two months (jul 26 - aug 1)…". Root cause: `detectCrossMonth`
  path #1 (page innerText regex requiring literal `MM/DD/YYYY to MM/DD/YYYY`) did NOT match the live
  SuiteProjects Pro header, path #2 (sheet tab name M-D-YYYY) didn't match either, so it fell to path #3
  = **today's Sun–Sat week**. Today (Jul 27) sits in Jul 26–Aug 1, which straddles a month boundary →
  bogus cross-month warning. The today fallback was masquerading as the displayed period.
- **FIX:** `detectCrossMonth` REWRITTEN to reflect the timesheet actually OPEN on the page, never today.
  Four sources, most-authoritative first:
  - `_readGridWeekDates()` (PRIMARY) — finds a day-hours input (`[id^="ts_c3_r"]` Sun / `[id^="ts_c9_r"]`
    Sat), `.closest('table')` to the grid, parses dates from header cells (`thead th/td, th`) via
    `_extractDates`, returns earliest→latest (≤8-day span guard).
  - `_readHeaderWeek()` — broadened page-text regex: numeric `M/D/YYYY` ranges, month-name ranges
    ("Jul 19, 2026 - Jul 25, 2026", 2nd side may omit month), day-first, "Week of 07/19/2026", en/em/
    ellipsis dashes + to/through/thru.
  - `_parseSheetNameDate(sheetName)` — the old path-2 logic extracted.
  - **LAST RESORT = today → returns `{isCross:false}`.** A cross-month warning is NEVER raised from
    today's calendar week alone (that was the exact false positive).
  - New helpers (all inside the IIFE, no globals): `_MONTHS_ABBR`, `_mkDate`, `_sundayToSaturday`,
    `_parseSheetNameDate`, `_extractDates`, `_weekFromDates`, `_readGridWeekDates`, `_readHeaderWeek`.
  - Return shape unchanged (`{isCross:true,from,to}` / `{isCross:false}`); `formatCrossMonthDates` and
    all three callers untouched. CROSS_MONTH_ENABLED gating untouched.
- **Validated:** `node --check content.js` passes; Node harness confirmed Jul 19–25 → not cross,
  nothing-detectable → not cross, genuine Aug 30–Sep 5 (month-name/numeric/"Week of"/sheet-name) → cross.
- **⚠️ UNVERIFIED live:** assumes the grid `<table>` renders per-day dates as text in its `<th>`/`<thead>`
  header cells (e.g. "Sun 7/19"). If SuiteProjects Pro shows only bare day numbers or dates outside `<th>`,
  `_readGridWeekDates` returns null and `_readHeaderWeek` takes over — degrades gracefully. Confirm the grid
  header date format against a real timesheet page next live session.
- Edits done via python/bash heredoc (Edit/Write still truncate here).
