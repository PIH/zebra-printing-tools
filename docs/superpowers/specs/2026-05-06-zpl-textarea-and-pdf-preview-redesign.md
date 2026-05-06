# ZPL textarea & PDF-preview redesign

**Date:** 2026-05-06
**Status:** Approved (brainstorm 2026-05-06)
**Affects:** `browser-print.html`, `browser-print-shim.py`, `README.md`, new
`install-zpl2pdf.sh` and `bin/` directory

## 1. Goal

Simplify `browser-print.html` from a four-pathway form-driven demo to a
ZPL-centric tool with a live PDF preview. The page becomes useful for two
deployable purposes: (a) printing labels, and (b) previewing ZPL labels
without wasting media while iterating on formatting.

The header / body / barcode form inputs go away, the ZPL becomes a freely
editable textarea, and the PDF the page used to construct in the browser is
now produced by rendering the ZPL itself — eliminating the `pdf-lib.min.js`
and `JsBarcode` dependencies and incidentally giving us a useful ZPL → PDF
tool.

## 2. Non-goals

- Replacing the shim's existing PDF → ZPL pipeline (Ghostscript +
  Floyd-Steinberg + `^GFA`). It works; touching it is unrelated.
- Self-hosted Labelary or any HTTP-side renderer.
- Online services (Labelary's hosted API, etc.) — patient data on labels
  rules out third-party network calls.
- Auto-regeneration of the PDF on every keystroke.
- Multi-page ZPL preview (`zpl2pdf` renders page 1 only).
- Side-by-side "ZPL output vs PDF round-trip" comparison UI.
- Replacing the shim's PDF → ZPL pipeline with `zebrafy` (a separate
  refactor; out of scope here).

## 3. Components surveyed

**`zpl2pdf`** (<https://github.com/brunoleocam/zpl2pdf>) — selected.
C# / .NET 9 self-contained, MIT licensed, cross-platform binaries
(Linux x64 + arm64, Windows x64, macOS Intel + Apple Silicon). Uses
`BinaryKits.Zpl` so it actually renders native ZPL primitives (`^A0N` text,
`^BC` barcodes, `^FO`/`^FD`, `^GB`, `^GF`), not just `^GF` bitmaps.
CLI supports `-i <file>` input, `--stdout` output, `-d <dpi>` density (in
dots-per-inch, default 203). Current release at time of writing: v3.1.1
(2026-03-23).

**`zebrafy`** (<https://github.com/miikanissi/zebrafy>) — rejected for the
ZPL → PDF direction. Its `ZebrafyZPL` class only decodes embedded `^GF` /
`^GFA` graphic-field bitmaps; it does not render native primitives. Our
default ZPL is all primitives (zero `^GF` fields), so feeding it to
`zebrafy` produces an empty PDF. (`zebrafy`'s PDF → ZPL direction could
substitute for the shim's existing Ghostscript pipeline, but that's a
separate refactor — out of scope here.)

**Labelary HTTP API** — rejected. Excellent renderer, but requires sending
ZPL (containing patient data, in the OpenMRS use case) to a third-party
server. Even with a local self-hosted Labelary container, the licensing
posture and Docker dependency are heavier than `zpl2pdf`.

**In-browser ZPL renderer** — none exists at production quality.

## 4. Architecture

### 4.1 Data flow

```
                 ┌──────────────────────────┐
   user types →  │   ZPL textarea           │
                 │   (sticky on edit)       │
                 └──┬────────────────┬──────┘
        ┌───────────┘                └───────────────┐
   [Print]                                       [Generate PDF]
   device.send(zpl)                              POST /zpl-to-pdf  ──► shim
                                                  ↓                    │
                                                  ↓               zpl2pdf -i tmp.zpl
                                                  ↓               --stdout -d <dpi>
                                                 PDF blob ◄────────────┘
                                                  ↓
                                  ┌───────────────┴───────────┐
                            [Print this PDF]            [Download]
                            convertAndSendFile             save
                            (existing helper PDF→ZPL)

   Skip-preview shortcut:
        [file picker] → convertAndSendFile (same helper conversion)
```

### 4.2 Page layout

```
Title / blurb (rewritten)
─────────────────────────
Printer
  Dropdown ▾  ↻ Refresh   Status: ● Ready
  Info card (model · firmware · Link-OS · DPI · conn · UID)
─────────────────────────
ZPL
  Help text: "This is the ZPL that will be sent to the printer.
  Edit ^PW (print width) and ^LL (label length) to match your loaded
  media if they differ from the detected defaults."
  <textarea> (monospace, ~14 rows, pre-filled with default ZPL)
  [ Print ]   [ Generate PDF ]   ↺ Reset to default
─────────────────────────
Generated PDF
  (always visible)
  <iframe srcdoc=blob:…/>          when conversion succeeded
  "PDF preview unavailable …"      when shim/zpl2pdf not present
  "ZPL changed — click Generate"   when textarea edited since last gen
  "<conversion error>"             when zpl2pdf returned non-zero
  [ Print this PDF ]   ⬇ Download   (disabled when no current PDF)
─────────────────────────
Print uploaded PDF
  Help text: "If you already have a PDF, skip the preview and print
  it directly via the helper conversion."
  [ Choose file… ]   [ Print ]
─────────────────────────
Diagnostics  (unchanged)
```

### 4.3 Removals

- Header / Body / Barcode text inputs.
- Density / width / height / unit-toggle inputs (Q3 with help text guides
  users to `^PW`/`^LL` instead).
- `pdf-lib.min.js` (vendored, ~525 KB).
- `JsBarcode` 3.11.5 CDN dependency.
- `buildPdf()` function and its calibration plumbing.
- `userOverrodeUnit` flag, `valueToDots` / `dotsToValue` /
  `applyUnitToInputs` / `switchUnit` / `formatDisplayValue` etc. — all the
  user-input-driven unit machinery. (Internal dpi/dpm tracking on the
  printer-info card stays for read-only display.)

### 4.4 Additions

- `bin/<platform>/zpl2pdf[.exe]` — installed by `install-zpl2pdf.sh`
  (not committed; `.gitignored`).
- `install-zpl2pdf.sh` (and `.ps1` for Windows) — downloads the platform
  binary from a pinned `zpl2pdf` GitHub release into `bin/`.
- New shim endpoint `POST /zpl-to-pdf`.
- New page section "Generated PDF" (always visible).

## 5. Shim changes

### 5.1 New endpoint `POST /zpl-to-pdf`

- **Request:** `Content-Type: text/plain` body containing raw ZPL.
  Optional query string `?dpi=<int>` (defaults to 203 if unset, matching
  zpl2pdf's own default; the page passes the selected printer's detected
  dpi from `lastDetected.dpi`).
- **Response (success):** `200 OK`, `Content-Type: application/pdf`, body
  is the rendered PDF bytes.
- **Response (binary missing):** `503 Service Unavailable`,
  `Content-Type: text/plain`, body is "zpl2pdf not installed; run
  ./install-zpl2pdf.sh".
- **Response (conversion failed):** `4xx` with `Content-Type: text/plain`,
  body is `zpl2pdf`'s stderr (truncated to 2 KB) so the page can show it
  inline.
- **Implementation:** write ZPL to a `NamedTemporaryFile`, shell out to
  `bin/<platform>/zpl2pdf -i <tmp> --stdout -d <dpi>`, capture stdout
  (PDF bytes) and stderr (errors), return. Temp file cleanup is
  automatic. CORS allowlist same as the rest of the shim (`*`).
- **Why temp file rather than `-z` argv:** ZPL with `^GFA` blocks at
  600 dpi can be hundreds of KB; Windows argv length is capped at 32 K
  and we want to keep behaviour identical across platforms.

### 5.2 `/config` extension

- When `bin/<detected-platform>/zpl2pdf` exists and is executable, the
  shim's `/config` response advertises both directions:
  `supportedConversions: {"pdf": ["zpl"], "zpl": ["pdf"]}`. When the
  binary is missing, only the existing `{"pdf": ["zpl"]}` is advertised.
- The page reads this once at startup via
  `BrowserPrint.getApplicationConfiguration` and uses it to decide
  whether to enable the auto-fire flow (and the "Generate PDF" button
  semantics) or replace the iframe area with the unavailability message.
- This is also the signal that distinguishes our shim from Zebra's
  official Browser Print helper (Windows / macOS users running the
  official helper won't see `zpl: ["pdf"]`).

### 5.3 Startup hint

On startup the shim checks `bin/<platform>/zpl2pdf`. If absent, it logs
one line: `zpl2pdf not found in bin/<platform>/ — run
./install-zpl2pdf.sh to enable PDF preview`. Doesn't fail the launch
(printing still works without it).

## 6. `zpl2pdf` bundling

- **Strategy:** install on first setup, do not vendor binaries.
- `install-zpl2pdf.sh` (POSIX) / `install-zpl2pdf.ps1` (Windows):
  - Detects platform (uname / arch).
  - Downloads the platform-appropriate asset from a pinned `zpl2pdf`
    GitHub release (e.g. v3.1.1).
  - Verifies via SHA256 (hash strings recorded in the script alongside
    the URL).
  - Extracts to `bin/<platform>/zpl2pdf[.exe]`, chmod +x as needed.
  - Idempotent (re-running detects existing binary, prints version).
- `.gitignore` covers `bin/*/zpl2pdf*` so an accidental commit can't
  bloat the repo.
- README §5b grows a sub-subsection documenting this one-time step.
- **Alternative considered, rejected:** Git LFS. Adds clone-time
  dependency on LFS being installed; users hit confusing failures on
  fresh clones without LFS. The install script is friendlier and pinned
  to a release version.

## 7. Page state lifecycle

### 7.1 Default ZPL content (hard-coded)

```
^XA
^CI28
^PW{widthDots}
^LL{heightDots}
^LH0,0
^FO50,50^A0N,58,58^FDOpenMRS Test Label^FS
^FO50,130^A0N,46,46^FDID: A456123^FS
^BY6,2,200
^FO50,310^BCN,200,Y,N,N^FDA456123^FS
^XZ
```

Same content the page emits today — only `widthDots` and `heightDots`
vary, populated from detection. The `buildDirectZpl(...)` function
becomes `defaultZpl({widthDots, heightDots})` (drops title/body/value
parameters since those are now literals).

### 7.2 State variables

**Retained:**
- `currentDevice` — selected printer
- `lastDetected` — `{ dpi, dpm, widthDots, heightDots, model, firmware,
  linkOs, connection, uid }`
- `lastPdfBytes` — `Uint8Array` of last successful conversion (used for
  Print-this-PDF + Download)

**Removed:**
- `userOverrodeUnit` and the entire unit-toggle machinery.

**New:**
- `pdfPreviewSupported` — boolean from `/config` advertising
  `zpl: ["pdf"]`.
- `zplDirty` — true when the textarea has been edited since the last
  successful Generate. While true, the iframe is hidden / replaced and
  Print-this-PDF + Download are disabled.
- `defaultZplSnapshot` — string: the most recent default written into
  the textarea. Used to decide whether the textarea is "untouched"
  (matches snapshot exactly → safe to overwrite on printer change) or
  "edited" (sticky → leave alone).

### 7.3 Lifecycle transitions

```
page load
  ├─ fetch /config → set pdfPreviewSupported
  └─ enumerate printers → user picks one (or auto-default)
       │
       ▼
  detect printer (dpi, dimensions, model, firmware)
  ├─ generate default ZPL from {widthDots, heightDots}
  ├─ write into textarea, defaultZplSnapshot = ZPL
  └─ if pdfPreviewSupported:
       auto-fire Generate (same code path as the manual [Generate PDF]
       button, including ?dpi=<detected> query param)
         ├─ on success: render iframe, save lastPdfBytes, zplDirty=false
         └─ on failure: show stderr in PDF section
     else:
       show "PDF preview unavailable" message in iframe area

textarea input event
  ├─ zplDirty = true
  ├─ clear iframe + lastPdfBytes
  └─ show "ZPL changed — click Generate PDF" indicator

[Print] click
  └─ device.send(textarea.value) + post-print status read
     (works regardless of zplDirty; raw ZPL print is independent of PDF)

[Generate PDF] click
  └─ POST /zpl-to-pdf with textarea.value + ?dpi=<detected>
       ├─ on success: render iframe, save lastPdfBytes, zplDirty=false
       └─ on failure: show stderr inline; iframe blank

[Print this PDF] click  (only enabled when lastPdfBytes is set)
  └─ device.convertAndSendFile(new Blob([lastPdfBytes]), …, {featureKey})
     + post-print status read

[↺ Reset to default] click
  ├─ rebuild default ZPL from current detection
  ├─ write to textarea, update defaultZplSnapshot
  ├─ zplDirty = false
  └─ auto-fire Generate (same as printer-select)

printer dropdown change to a *different* printer
  ├─ detect new printer → update info card
  └─ if textarea.value === defaultZplSnapshot:  (untouched)
        regenerate default, write to textarea, auto-Generate
     else:  (sticky)
        leave textarea alone
        do NOT auto-regenerate the PDF (existing PDF is still valid for
          the existing ZPL; let the user decide)
        show small note: "Printer changed — current ZPL has user edits.
          Click Reset to default to use new dimensions."

printer dropdown change to the *same* printer (re-select)
  └─ wipe & regenerate default unconditionally
     (matches existing "reselect to detect afresh" model)

upload-PDF [Print] click  (skip-preview pathway)
  └─ device.convertAndSendFile(file, …, {featureKey})
     + post-print status read
```

## 8. Error handling

| Failure | User sees |
|---|---|
| Shim not running | Existing "no printers / helper unreachable" path — unchanged. |
| Shim running, `zpl2pdf` not installed | `/config` advertises only `{"pdf": ["zpl"]}`. PDF section: "PDF preview unavailable. Run `./install-zpl2pdf.sh`. (See README §5b.)" Pathways 1 + 3 still work. |
| `zpl2pdf` exists but fails to execute (perms, wrong arch) | First `/zpl-to-pdf` returns 503 with stderr; iframe area shows stderr verbatim. Auto-fire suppressed for the rest of the session. |
| Conversion fails (bad ZPL syntax) | 4xx with stderr; iframe area shows the parse error inline. Print-this-PDF + Download disabled. The "Print" button (raw ZPL) is still available — printers are sometimes more forgiving than the parser. |
| Conversion succeeds but produces empty PDF | Chrome's PDF viewer renders blank. We don't try to detect this; user sees the blank and edits. |
| `convertAndSendFile` rejects with "license/key" | Existing pathway-2 hint: message about feature-key. Only relevant on Windows/macOS users running Zebra's official helper; the shim's `/convert` ignores the key. |
| Page over HTTPS, helper on 9101 with self-signed cert | Existing one-time visit-and-accept flow — unchanged. |

## 9. Edge cases

- **`^GFA` in user-pasted ZPL.** A round-trip — pathway 2 of today
  produces ZPL with embedded `^GFA`, the user could in theory paste
  *that* into the textarea and try to render it back to PDF.
  `BinaryKits.Zpl` supports `^GF`, so this should work but quality may
  be poor (1-bit bitmap upscaled). Not a goal of this work; not worth
  optimising for.
- **DPI precision.** `zpl2pdf -d` takes integer DPI. Common values
  (`203`, `300`, `600`) pass through exactly. For printers that report
  `densityDpm` only (e.g. `12 dots/mm` exact), the page derives DPI via
  the existing standard table (`6 ↔ 152`, `8 ↔ 203`, `12 ↔ 300`,
  `24 ↔ 600`); non-standard densities round to nearest integer DPI via
  `× 25.4`. Loss ≤4% in extreme cases — acceptable for preview.
- **Large ZPL payloads.** `^GFA` blocks at 600 dpi can be hundreds of
  KB; the temp-file approach handles this (CLI argv length limits would
  not).
- **Concurrent `/zpl-to-pdf` calls.** Two rapid Generate clicks launch
  two subprocesses. Acceptable; second response wins. Could be debounced
  later if it matters.
- **Temp file cleanup.** `tempfile.NamedTemporaryFile(delete=True)`
  handles cleanup on process exit even if the request handler crashes
  mid-flight.
- **Feature-key ownership.** The page keeps the existing
  `DEFAULT_FEATURE_KEY` constant for the upload-PDF and Print-this-PDF
  paths — relevant when running against Zebra's official helper on
  Windows/macOS, ignored by the shim's `/convert`.

## 10. README updates

- Rewrite §1 (intro): two-operation model (print ZPL, preview PDF).
- Rewrite §4 (pathways): collapse pathways 1 + 3 into "Print ZPL"; rename
  pathway 2 to "ZPL → PDF preview → print"; rename pathway 4 to
  "Skip-preview PDF print".
- Add a §5b sub-subsection: "PDF preview support — install zpl2pdf",
  documenting the `install-zpl2pdf.sh` step.
- Drop §5a/§7 references to `pdf-lib.min.js`, `JsBarcode`, "form-based
  PDF construction", and the unit-toggle behaviour (§8b "Display
  units").
- Update §11 (file inventory): `pdf-lib.min.js` removed, `bin/` added,
  `install-zpl2pdf.sh` added, `print.min.js` cleanup (still unused, but
  the section can now point out only one stale dependency rather than
  two).
- Add a new §12 decision-log entry describing this redesign and citing
  `zpl2pdf` + the alternatives surveyed (Labelary, zebrafy).

## 11. Open questions

None remaining — all six clarifying questions from the brainstorm are
resolved.

## 12. Implementation sketch (handed off to writing-plans)

In rough order:

1. Add `install-zpl2pdf.sh` + `.ps1` + `.gitignore` entry. Smoke-test on
   Linux x64.
2. Add `POST /zpl-to-pdf` and `/config` extension to
   `browser-print-shim.py`. Test with `curl`.
3. Strip `browser-print.html` of the form inputs, `buildPdf`,
   `pdf-lib.min.js` script tag, `JsBarcode` script tag, unit-toggle JS.
4. Add the new ZPL textarea + Generate PDF + iframe section + state
   machine.
5. Re-frame upload-PDF section as the skip-preview shortcut.
6. Update README per §10 above.
7. Smoke test on the GX430t (Linux dev box).

Detailed plan to be produced by `superpowers:writing-plans`.
