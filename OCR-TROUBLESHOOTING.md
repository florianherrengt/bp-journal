# Fix an OCR miss

Save the failing JPEG in `examples/` at the root of the repo. Create the folder if needed. Git ignores this folder, so the original stays local.

Copy this prompt into your coding agent and fill in the file name, the values on the monitor, and what the app did.

```text
BP Journal misread examples/<filename>.jpeg.
The monitor shows <systolic>/<diastolic> with pulse <pulse>.
The app returned <wrong values or exact error>.
Follow OCR-TROUBLESHOOTING.md to reproduce the issue, add a regression
test, and prepare the fix for a pull request.
```

## Steps for the agent

1. Run the photo through the real recognizer in [`src/api/ocr.ts`](src/api/ocr.ts). Compare its result with the values reported from the monitor. If the original reads correctly, reproduce the app upload and check the JPEG it sends to the server.
2. Create a shareable copy in [`tests/fixtures/photos`](tests/fixtures/photos) that still reproduces the failure. Keep the full frame, apply the camera orientation, and remove camera metadata. The browser limits the longest side to 1,600 pixels and requests JPEG quality `0.85`. Check that the visible contents are safe to share publicly before adding the copy to Git.
3. Add the file name and the expected `sys`, `dia`, and `pul` values to the photo cases in [`src/api/ocr.test.ts`](src/api/ocr.test.ts). Run the case before editing OCR and confirm it fails for the reported reason. If the expected values are unclear, ask for them.

   ```sh
   npm test -- src/api/ocr.test.ts -t '<filename>.jpeg'
   ```

4. Find where recognition goes wrong and make the smallest fix. Rerun the focused test, then run `npm run check` to verify all previous photos and the rest of the suite.
5. Review the diff. The PR should include the fix, test, and shareable fixture. Describe what the monitor showed, what OCR returned before the fix, and which checks passed.
