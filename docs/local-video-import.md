# Automatic local video scanning

## Use it

On the tracker’s **Scan** page, choose a collection video and press **Scan**.
Card positions and visible owned-quantity tabs are detected automatically.
There is no required calibration, layout file, quantity-teaching example, expansion selection, or baseline CSV.
The existing image selector still works as before.

The standalone page has the same two-step flow:

```sh
git switch feat/local-video-import
git pull --ff-only
pnpm install --frozen-lockfile
pnpm dev:video-import
```

Open `/video-import.html` at the local address printed by Vite. Node.js 22+ is required.
After recognition, review the results and press **Update selected cards** in the tracker, or **Export CSV** in the standalone page.
Clear matches are selected automatically; a missing quantity uses default 1, or keeps the current tracker quantity when higher. The upload panel, neutral theme, buttons, spinner, alerts, and responsive result cards now match the original image scanner.
Captured and reference cards are visible side by side, with match scores, plus/minus owned-total controls, and click-to-include/exclude.
Only alternate matches and extra evidence are collapsed. No global confirmation checkbox or setup wizard is required.

The standalone entry imports the same `index.css` and Tailwind pipeline as the main application, not a separate importer theme.
Image scanning and video scanning share `ScanPresentation.tsx`; their different increment/owned-total semantics remain in their respective callers.
Use **Scan more** to return to the upload panel. Successful tracker writes show the confirmation state; failures keep your results available for retry.

## Counts are owned totals, not video-frame counts

Twenty frames showing a card with an owned badge of 3 produce **3**, not 20 or 60.
Video updates replace the totals of selected observed cards; they do not increment your collection.
Repeating the same verified scan does not add copies. Unseen cards remain unchanged.
Image scanning retains its original increment behavior.

The tracker provides its current collection automatically. Decreases remain excluded until selected and explicitly approved in that result’s details.
Missing or unreadable quantities now default to **1 per matched ownership ID**, mirroring the image scanner’s easy starting point—not one per frame.
The UI explicitly labels this as a default, not an exact measurement. Existing tracker quantities of one or more are kept, including when the collection refreshes during review.
Readable quantities still use the read total. Capped (`99+`) and conflicting counts remain excluded until corrected; ambiguous identities are not auto-selected.
Changing a default with the quantity controls makes it a manual total, with the normal decrease safeguard.
Unresolved rows are excluded by default and can be corrected in their details or left out.
The application does not change your collection until you press **Update selected cards**; unsuccessful writes do not display success.

Standalone CSV is a **partial ownership snapshot** of selected observed cards, in the existing tracker format (`NumberOwned`, `Collected`, stable ID and InternalId).
It is not a full backup. Do not use a destination’s “clear collection” option when importing it.
CSV retains the tracker’s required columns and adds `QuantitySource` (`read`, `default-1`, `existing`, or `manual`). The original importer accepts extra columns.
JSON includes the same provenance and lists unresolved detections. Neither format claims that a default is the exact number of copies.
**Standalone caution:** without your baseline, the exporter can only use 1 for a badge-less card. Importing that CSV through another tool can overwrite a higher existing count. Use the integrated Scan page to preserve current tracker quantities automatically.

## Processing and limits

- Full-frame card detection reuses the existing TensorFlow model and reference hashes.
- A small local digit reader locates the slate quantity tab near the bottom-left of each detected card.
  It uses card-relative geometry rather than device-specific coordinates. No uploaded examples are needed.
- Samples are decoded sequentially at 0.5-second intervals. Observations are reconciled by canonical card ID.
  Frame sightings are diagnostics only and never become copy counts.
- Native browser decoding: prefer a clear H.264 MP4. Files must be non-empty, at most 2 GB, at most 30 minutes, and no side above 4096 pixels.
- Keep the collection grid and quantity tabs visible. Blur, overlays, tiny thumbnails, unusual layouts or unsupported video codecs may reduce recognition.
- Cancel aborts processing and releases the video before retrying. No partial result is applied.
- Video and crops remain in browser memory. Static recognition assets are loaded from the same server; there is no video upload, Nintendo login or ADB.
  The standalone entry does not bootstrap tracker accounts or analytics. The main tracker uses its normal collection API only when you apply results.

## Verification

```sh
pnpm test:video-import
pnpm --filter frontend exec tsc -b
pnpm --filter frontend exec vite build
pnpm build:video-import
pnpm test:video-import:browser
pnpm lint
```

The browser suite uses synthetic digits and an actual H.264 video, tests the two-step React UI, downloads, cancellation/retry, and bundled-model inference on blank frames.
Deterministic identity matches test pipeline/UI behavior, not real-card recognition accuracy.
Presentation checks compare image/video styles at desktop, tablet and mobile widths and capture screenshots of standalone and embedded results.
Their card artwork is synthetic test data; private recordings are not used in CI.
The automatic badge locator is heuristic; synthetic tests are not a claim that every Pocket layout or real recording has been validated.

## End-to-end acceptance

1. On the normal Scan page, choose a short recording and press Scan without opening any setup controls.
2. Check known card identities and visible owned totals, including a multi-digit total and a card held still for several seconds.
3. Verify unresolved/decreasing rows remain excluded, while clear results can be applied or exported directly.
4. Cancel and retry the same video; repeat an applied scan and verify totals do not increase.
5. Scan an image as before and verify the original image increment/review workflow still works.

Do not open a PR until real-recording validation is complete.

## Compact-view regression checks

The original image scanner sets `increment: 1` for each extracted card and adds it to the stored quantity.
Video collection scanning deliberately differs: missing counts start at 1 **once per unique ownership ID**, not +1 per frame or scan.

Regression coverage includes badge-less exports with no typing, repeat scans, existing counts of 0/7/12, manual overrides, live collection refresh, conflicts, caps, and CSV provenance.
Private recordings are used only locally and are never committed or uploaded to CI.
