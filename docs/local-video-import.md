# Local screen-recording importer

Status: experimental implementation for end-to-end verification. No account API, ADB, emulator, cloud recognition or new runtime dependency. Do not merge upstream until a real Pocket recording has been checked.

## Start it

From a normal checkout of this fork, with Node 22+ and pnpm:

```sh
git fetch origin
git switch --track origin/feat/local-video-import
pnpm install --frozen-lockfile
pnpm dev:video-import
```

When the branch already exists locally, use `git switch feat/local-video-import` instead. Open the printed local address with `/video-import.html`, normally `http://127.0.0.1:5173/video-import.html`.

The dedicated Vite configuration does not use the main application's certificate-generation plugin, account bootstrap, analytics or backend environment variables. It reuses the repository's static catalogue, English image hashes, images and TensorFlow model. Keep `frontend/assets` and `frontend/public` from the full checkout; copying only the new source files is insufficient.

The normal frontend build also includes `video-import.html` as a second entry. A standalone build is available:

```sh
pnpm build:video-import
```

That command builds the standalone entry only, into `frontend/dist/video-import`. Run the type and quality checks below before distributing it. No deployment or pull request is performed by these commands.

## First recording

Start with one expansion and a short recording, not your entire collection. Use the ordinary phone screen recorder. Show owned quantities in the collection grid, use portrait orientation and one fixed grid zoom, and pause briefly between overlapping scrolls. A pack-opening animation is not a collection snapshot.

Initially validate with English cards. Recognition currently loads English references only. Other languages, changing layouts, rapidly moving screens, overlays and heavily compressed recordings are not validated.

Keep the original CSV as your rollback copy. Transfer the recording to the desktop and select it directly on the importer page; do not upload it to a hosting service.

## Workflow

1. **Choose files.** Select the recording and optionally the previous tracker CSV. Without a baseline, the export contains confirmed entries only. It does not fill unobserved cards with zeroes.
2. **Calibrate.** Capture a clear preview frame. Draw the scrolling collection area, one complete card inside it, and that card's numeric quantity area. Include margins and enough width for multi-digit counts and a trailing `+`. Exclude the multiplication sign, decorative icons and adjacent cards. The grid must include the quantity indicators while excluding fixed navigation bars. Numeric coordinate controls provide a keyboard alternative.
3. **Check the quantity crop.** Choose dark or light text explicitly when automatic polarity is ambiguous. The optional known-quantity field teaches the visible digits from this frame; it does not teach every digit. Use “Test quantity crop,” compare with the picture, and save the layout for this phone/zoom.
4. **Scan.** Select the expansion actually shown, or all expansions. The default sampling interval is 0.5 seconds; 0.25 examines more frames. No collection data changes during scanning. Cancel discards the current scan.
5. **Review.** All rows start unselected. Inspect the card and quantity crops against the reference. Select verified entries, correct identities by catalogue ID, and enter exact quantities for uncertain readings. Conflicting readings, unknowns, lower bounds and decreases need attention. A decrease has its own approval checkbox. “Select consistent suggestions” is a review shortcut, not an accuracy guarantee; it excludes unknowns, lower bounds and decreases and preserves manual edits.
6. **Export.** Confirm review and the recording date. With a baseline, also confirm that it is not newer than the recording. Export CSV and optionally the JSON audit. Nothing is written to your tracker account. Import the reviewed CSV into the tracker's existing file importer as a separate action.

Saved layouts describe rectangles, aspect ratio and text polarity only. They contain no card inventory or game credentials. Reuse requires the same layout/zoom and a visible example card at the saved position in the preview. Recalibrate when that is not true. The optional digit teaching example is not stored in the layout.

## What each export means

| Export | Contents |
| --- | --- |
| Merged CSV | The supplied baseline, with only selected confirmed quantities replaced. Unseen or unresolved baseline entries are carried forward, not refreshed. |
| Partial CSV | Without a baseline, only confirmed selected entries. Never a claim of full collection coverage. |
| Selected changes only | Selected ownership entries only. Prefer this when the tracker may contain newer, unrelated changes. Import it as updates, not as a full-replacement inventory. |
| JSON audit | Catalogue fingerprint, stable card IDs, recording metadata, calibration, observed/confirmed/carried-forward provenance, decisions, uncertainty and sampling statistics. Evidence crops are omitted unless explicitly requested. |

The CSV header matches the existing tracker:

```csv
Id,CardName,InternalId,NumberOwned,Expansion,Pack,Rarity,Collected
```

There is one row per canonical `internal_id`. Linked display-card aliases are not added together. Equal alias rows in a baseline are deduplicated; conflicting alias counts or flags stop the import. An outdated internal ID is remapped through a known stable `Id`, with an explicit warning; unknown stable IDs stop the import rather than disappearing.

`Collected` is independent of the current number owned. Reducing a count to zero preserves a historical true flag. Blank, negative, fractional, unsafe or non-exact numeric values are rejected. A visible `99+` is a lower bound, not exactly 99.

The JSON is an audit/export format, not yet a resumable session import. Closing the page discards the in-memory review. Save reviewed exports before leaving.

## Correctness and privacy boundaries

```text
Video frames → observations → review decisions → pure snapshot merge → file download
                                     │
                                     └── no account mutation
```

- Twenty sightings of a card with quantity 3 still mean 3, not 60. Reimporting a reviewed snapshot is idempotent.
- Cards are matched by catalogue ownership identity, not Pokémon name. Different artwork can remain different ownership entries.
- Quantity conflicts are not resolved by summing, taking the largest value, or majority-voting neighboring copies of the same frame.
- Unknown quantities never become zero or one. Digits touching the crop edge are rejected as potentially clipped.
- Unseen entries remain unchanged. A possible scroll gap is a warning; even a gap-free recording is not proof of completeness.
- Export validates all selected updates before constructing a new map. Conflicting manual mappings and unapproved decreases block export atomically.
- No recording, crops, CSV, detected IDs or quantities are sent over the network. The standalone page uses static same-origin asset requests and local blob URLs. The Vite development client also uses its usual local development connection. Installed browser extensions and the surrounding operating system are outside this guarantee.
- No Nintendo token, unofficial Pocket endpoint, backend migration, account setting or production deployment is involved.

The existing screenshot scanner keeps its additive behavior. The shared service only gains a canvas-frame entry and an optional model URL/request configuration. The video importer never calls `useUpdateCards`, `useCollection` or any account service.

## Recognition implementation

`frontend/src/features/video-import/` contains the complete feature:

| Module | Responsibility |
| --- | --- |
| `video.ts` | Native video decoding/seeking, bounded frame handling, decode timeouts, abort and resource cleanup. |
| `geometry.ts`, `Calibration.tsx` | User-calibrated grid/card/count rectangles with bounds and aspect checks. |
| `pipeline.ts` | Frame selection, shared TensorFlow detector, reference-hash candidates, card/count evidence and progress. |
| `pixels.ts`, `quantity.ts` | Count-region thresholding, connected components and digit-template matching; optional local supervised digit examples. |
| `reconcile.ts` | Bounded repeated-observation storage and conflict detection. |
| `snapshot.ts`, `csv.ts` | Pure merge rules, strict CSV parsing and compatible exports. |
| `ReviewRow.tsx`, `VideoImportPage.tsx` | Review, corrections, decrease approvals and export controls. |
| `report.ts` | Catalogue fingerprint, provenance audit and file download. |

The detector is reused, not retrained. Card identity currently requires a pHash similarity of at least 0.86 and a gap of at least 0.025 over the next distinct candidate. These are uncalibrated heuristics, **not probabilities**. The count reader uses generic browser-rendered font templates plus any supplied local teaching example. It is not a verified model of Pocket's font and does not use cloud OCR. Results stay review-required.

Frame sampling skips nearly unchanged frames and frames substantially blurrier than the calibration view. These filters can miss content; pause with overlap and inspect the sampling summary. Inference and matching are sequential; no Web Worker optimization or automatic background synchronization is claimed.

Limits: 2 GB per recording, at most 30 minutes, at most 4096 pixels per side, 20 MB baseline CSV, 50,000 CSV rows, 5,000 review groups and approximately 60 MB encoded evidence. Hitting a limit fails clearly instead of silently exporting a truncated snapshot. Codec support depends on the browser; an `.mp4` extension alone does not establish compatibility.

## Automated checks

```sh
pnpm test:video-import
pnpm test:video-import:browser
pnpm --filter frontend exec tsc -b
pnpm lint
pnpm build
```

The browser runner requires Node 22+ and an installed Chrome, Edge or Chromium. Set `CHROME_PATH` when it cannot locate the executable. It starts a loopback-only Vite server on port 4179 and an isolated temporary browser profile; it does not use your normal browser account. Results and a smoke-test screenshot go to ignored `tests/video-import/results/`.

To run browser assertions manually, start `pnpm dev:video-import` and open `/tests/video-import.html`. The checked-in video fixture is a generated two-color H.264 clip with no audio, game imagery or private data. Its dimensions are 64 × 96 and duration two seconds.

Initial local validation during implementation:

- **62 core tests passed:** snapshot replacement, repeated sightings/imports, conflicts, missing values, decreases, historical flags, CSV round-trips/escaping, aliases/remapping, geometry, bounded evidence, provenance and isolation.
- **38 Chromium browser checks passed:** generic light/dark/multi-digit template recognition, lower bounds, blank/clipped counts, supervised examples, crop bounds, actual native H.264 seeking, repeated timestamps, disposal, cancellation and corrupt media.
- These browser checks used the real new processing modules in an in-memory harness. They do **not** establish real-card detector accuracy or full recording end-to-end correctness.
- The initial authoring environment could not install the complete repository's dependencies. Full-app type checking, Vite/Biome validation and the checked-in Vite-based browser runner are separate CI/local gates, not implied by the 62/38 counts above. Check the branch's latest CI before treating those gates as passed.

The feature workflow performs unit tests, full type checking, builds, browser checks and quality checks without deploying anything. Diagnostic logs, browser results and a formatting patch are retained when available. It never pushes fixes or creates a pull request.

## End-to-end acceptance checklist

Use a short real recording before scaling up:

- [ ] The standalone page opens without login or backend configuration.
- [ ] A known card and its numeric region can be calibrated; a saved layout can be reloaded.
- [ ] The shared detector recognizes actual collection-grid cards, including ordinary and alternative artwork.
- [ ] Counts 1, 2 and at least one multi-digit value match the game. Unknowns remain empty; clipped digits are not guessed.
- [ ] Scrolling backward or leaving the screen stationary does not add copies.
- [ ] All changes remain proposals until explicitly selected and exported.
- [ ] A partial recording preserves a baseline card that never appears.
- [ ] A quantity decrease is blocked until individually approved.
- [ ] Reimporting the resulting CSV does not increase quantities again.
- [ ] A canceled scan or corrupt video cannot create a partial export accidentally.
- [ ] The selected-changes CSV is accepted by the tracker's existing importer with correct quantities and historical flags.
- [ ] Network inspection shows no recording/crop/CSV payload leaving the page.
- [ ] Sampling gaps and review workload are acceptable on the actual phone's recording format.

Record failures with browser/version, video dimensions, grid zoom, game language, timestamps, expected/observed IDs and quantities, and console errors. A minimal cropped example is preferable to publishing your entire collection. Never commit a personal CSV, recording or account credential to this public fork.

## Before proposing an upstream PR

Run all gates above, validate real recordings separately from the synthetic fixtures, and measure false accepted card-and-count pairs as well as unknown/missed entries. Resolve any actual layout or font failures before reducing the amount of mandatory review. Review the existing GPL-3.0 license and separate model/image asset terms; this feature adds no third-party font or model files.
