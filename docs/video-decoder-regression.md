# Video seek timeout regression

The video scanner still uses **choose video → Scan**. No codec conversion, calibration, or additional controls were added.

## Cause and fix

The previous decoder required both the media event and `requestVideoFrameCallback` before resolving a seek.
The latter signals presentation to the compositor, not completion of decoding, and can be absent even when a seek has completed.
The error incorrectly blamed the codec/length and said it was waiting for `seeked` even when that event had already arrived.

The decoder now checks decoded media state (`readyState`, `seeking`, and the requested position), using events plus polling.
Presentation callbacks are registered before starting the operation. When a callback is missing, two rendering turns or a bounded timer allow rendering to settle.
That fallback never accepts a frame while the decoder is still seeking or lacks current data.
Genuine decoder errors and stalls still fail; stall messages include the timestamp and decoder state.
Disposal aborts pending waits, and overlapping frame reads are rejected rather than racing.

API reference: https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback

## Regression coverage

- Completed seeks with missing media/display notifications.
- Display notifications before decoding completes, plus genuine stalled/error states.
- Native H.264 decoding with dropped video callbacks, missing API support, and suspended animation callbacks.
- First/last frames, repeated positions, sub-frame seeks, and backward seeks.
- Cancellation, retry, disposal, and concurrent-read guards.

The browser tests check actual red/blue pixels, not just resolved promises.
A user-provided 74-second H.264 recording was also tested locally at all 149 half-second sample positions.
With both display and animation callbacks suppressed, all 149 decoded thumbnail hashes matched normal decoding.
The private recording and its frames were not added to the repository; CI uses synthetic media only.
These checks validate decoding, not the accuracy of card/quantity recognition.
