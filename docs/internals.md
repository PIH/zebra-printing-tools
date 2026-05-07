# Internals — implementation reference

This document covers the technical architecture and implementation details. For setup instructions, see the [README](../README.md). For design history, see [decision-log.md](decision-log.md).

---

## 1. Browser Print architecture

Two separately-downloaded artifacts that are easy to confuse:

| Artefact | What it is | Where it runs |
|---|---|---|
| **Browser Print application** (the *helper*) | Native daemon (~3 MB) | OS background service in your user session |
| **Browser Print SDK** (`BrowserPrint-3.x.x.min.js` + `BrowserPrint-Zebra-1.x.x.min.js`) | JS library | The web page |

The SDK only makes API calls — it cannot print on its own. **You need both.**
We learned this the hard way; the v3.1.250 SDK bundle was added first, but
nothing worked until the helper application was also installed.

### Endpoints (verified by inspecting `BrowserPrint-3.1.250.min.js`)

The helper listens on:
- `http://127.0.0.1:9100/`  — used when the page is served over HTTP
- `https://127.0.0.1:9101/` — used when the page is served over HTTPS

The SDK transparently picks the right one based on the page's protocol.
Mixed-content rules in Chrome force HTTPS pages onto port 9101.

The 9101 endpoint uses a self-signed cert. The first time the page is HTTPS,
you have to visit `https://127.0.0.1:9101/available` once and accept the cert
in that browser profile, then the SDK works transparently.

### HTTP API (what the SDK calls)

| Endpoint | Purpose |
|---|---|
| `GET /available` | Discovered printer list |
| `GET /default`   | System default printer record |
| `POST /write`    | Send raw bytes to a device — `{ device, data }` |
| `POST /read`     | Read response bytes from a device |
| `POST /convert`  | Convert a resource (image / PDF) to printer language |

The first version of our prototype used `fetch()` directly against these.
The current version uses the SDK so we get the HTTP↔HTTPS switch, parsed
status, and `convertAndSendFile` for free.

### SDK shape (transcribed from Zebra's JSDoc when we vendored the SDK; for the canonical reference see Zebra's developer site — [README §7](../README.md#zebras-documentation))

- `BrowserPrint.getApplicationConfiguration(success, error)` — tells you the
  helper's `platform`, `api_level`, and `supportedConversions`.
- `BrowserPrint.getDefaultDevice("printer", success, error)`
- `BrowserPrint.getLocalDevices(success, error, "printer")`
- `device.send(data, success, error)` — raw bytes (ZPL string).
- `device.read(success, error)` — read raw response bytes.
- `device.sendFile(url|blob, success, error)` — send file as-is.
- `device.convertAndSendFile(url|blob, success, error, options)` — auto-convert
  (image / PDF) and send. *PDF requires `options.featureKey`.* Client API
  level 4.
- `Zebra.Printer` wrapper (loaded from `BrowserPrint-Zebra-1.x.x.min.js`):
  - `printer.getStatus(success?, failure?)` → `Zebra.Printer.Status` with
    `isPrinterReady()` and `getMessage()`. Returns a Promise if callbacks are
    omitted.
  - `printer.getConfiguration()` — full printer config.
  - `printer.getConvertedResource(blob, options?)` — *preview* the converted
    ZPL without sending.
  - `printer.printImageAsLabel(...)` — image-as-label helper.
  - `printer.getSGD` / `setSGD` / `setThenGetSGD` — Zebra Set/Get/Do
    parameter access.
  - `printer.isPrinterReady()` — quick boolean check.

The Zebra wrapper's queries are synchronized — calls are queued so a status
read won't race a print job that's still flushing.

---

## 2. ZPL primer

A 3" × 2" label is 900 × 600 dots at 300 dpi (or 609 × 406 at 203 dpi).
The label's physical dimensions are set by the `^PW` (print width) and
`^LL` (label length) directives — both in dots — inside the ZPL itself.
On printer-select, the page pre-fills the textarea with a default
template whose `^PW`/`^LL` specify a 3"×2" demo, sized to the detected
DPI. The textarea is the configuration surface — edit `^PW`/`^LL` for
other media. The sample below is what the textarea contains for a
300-dpi printer right after selection:

**Default ZPL the page pre-fills (3"×2" at 300 dpi):**
```
^XA
^CI28                                          ; UTF-8
^PW900                                         ; print width in dots
^LL600                                         ; label length in dots
^LH0,0                                         ; label home
^FO50,50^A0N,58,58^FDOpenMRS Test Label^FS     ; header text
^FO50,130^A0N,46,46^FDID: A456123^FS           ; body text
^BY6,2,200                                     ; bar module=6 dots, ratio=2:1, height=200
^FO50,310^BCN,200,Y,N,N^FDA456123^FS           ; Code 128, bottom-anchored, with HRI
^XZ
```

**Pathway 2 output** — produced by Zebra's helper or the shim. Single
`^GFA` field with the bitmap, encoded with run-length compression. Header
form:
```
^XA^PW900^LL600^LH0,0^FO0,0^GFA,67800,67800,113,<compressed>^FS^XZ
```
- `^GFA,a,b,c,DATA` — `a`=total bytes, `b`=graphic field byte count,
  `c`=bytes per row, `DATA`=hex (with the `^GF` compression scheme below).
  Bits MSB-first per byte; 1 = black dot.
- Compression scheme used by Zebra's tooling and the shim:
  - `G`–`Y` = repeat next hex digit 1–19 times
  - `g`–`z` = repeat next hex digit 20, 40, 60, …, 400 times
    (`lY4` = 139 fours; both letters stack additively)
  - `,` = fill rest of current row with `0` (white)
  - `!` = fill rest of current row with `F` (black)
  - `:` = repeat the previous row
- For mostly-white label content this typically shrinks 5–10× compared
  with raw hex. The shim's threshold mode for the test PDF: ~6 KB total
  ZPL. Dither mode: ~22 KB.

---

## 3. Querying the printer (status, capability detection, diagnostics)

The page consolidates three kinds of printer query into a single "Printer"
section (status pill + a model/firmware/dpi/connection/UID grid, with a
single Refresh button that re-runs both halves), plus a separate
Diagnostics section for ad-hoc commands. The mechanics differ enough to
be worth describing separately; see §3a/§3b/§3c below.

`Zebra.Printer.getStatus()` issues `~HS` to the device, reads the response,
and parses it into a `Zebra.Printer.Status` object with:

- `isPrinterReady()` → boolean
- `offline` → boolean (set when the response framing fails — see below)
- `getMessage()` → human-readable description (e.g., "Ready to Print",
  "Head Open", "Paper Out")

Plus boolean fields the SDK populates from the `~HS` response (head open,
paper out, paused, ribbon out, receive buffer full, partial format in
progress, head cold/hot, etc.).

The page refreshes status ~350 ms after each print (the SDK's queue
keeps the status query strictly after the in-flight print, so they don't
race).

`device.send` returning success only means *bytes were buffered to the
helper*, not that the label printed. The post-print status read is what
gives you the real "did it actually print" signal.

### 3a. The "Offline" trap

The Zebra SDK reports `offline = true` whenever the trimmed `~HS`
response doesn't *both* start with STX (`0x02`) **and** end with ETX
(`0x03`):

```js
function h(c){ return 2 !== c.charCodeAt(0)
                   || 3 !== c.charCodeAt(c.length - 1) ? false : true; }
// ...
this.offline = !h(a.trim());
```

`~HS` actually returns three STX/ETX-framed records flushed back-to-back
from the printer, and the SDK indexes flag positions across all three
(e.g. char 43 is "head open" in the second record). So the helper has
to capture *all three frames* in one `/read` body — if a `select()`
returns the moment the first byte is available and the helper grabs
just the first frame, the SDK then sees a body that ends on `\n`/`\r`
or mid-stream, fails the framing check, and surfaces a red "Offline"
pill even though the printer is fine.

The shim's `/read` handlers therefore drain *until quiet*: after the
first byte arrives, keep reading until 150 ms of silence (1500 ms
hard cap), so multi-frame `~HS` (and `^HH`) replies land in one body.
See `_drain_until_quiet_fd` / `_drain_until_quiet_sock` in
`browser-print-shim.py` and the comment block in front of them.

The page side adds belt-and-braces: each `getStatus` is raced against a
500 ms per-attempt timeout (4 attempts, 100 ms gap → ~2.3 s worst case)
and silently retries on `offline` / timeout / error before surfacing a
red pill. The first `~HS` against a freshly-opened device is the most
race-prone; transient framing failures don't reach the user.

### 3b. Printer capability detection

When the user selects a printer, the page also fires three queries in
parallel through the SDK queue:

| Query | Sent | Used for |
|---|---|---|
| `getSGD('head.resolution.in_dpi')` | `! U1 getvar "head.resolution.in_dpi"\r\n` | dpi (Link-OS 4+ canonical) |
| `getConfiguration()` | `^XA^HH^XZ` | `printWidth` (dots), `labelLength` (dots), `RESOLUTION` field, firmware |
| `getInfo()`          | `~hi\r\n` | model string (e.g. `"GX430t-300dpi"`) |

…then resolves density by escalating fallbacks. Density is tracked in
both representations — `densityDpi` (dots-per-inch, snapped to standard
Zebra labelled values) and `densityDpm` (dots-per-millimetre, only
populated when the printer reported `N/mm` directly):

1. `head.resolution.in_dpi` SGD value
2. `cfg.settings.RESOLUTION` parsed by `parseDensity` (handles three
   shapes — bare integer `"300"`, leading-integer-is-dpi
   `"203 8/mm FULL"`, and the variant where the leading integer is
   *not* dpi, e.g. `"1280 12/MM FULL"` where the only reliable signal
   is the `12/MM` token). When `N/mm` is found, both `dpi` and `dpm`
   are returned; otherwise just `dpi`.
3. `info.model` regex `/(\d+)\s*dpi/i` — model string `"GX430t-300dpi"`
   yields 300.
4. `device.host_resolution` SGD as a last-resort round-trip.

The GX430t we tested doesn't expose `head.resolution.in_dpi` *or* a
`RESOLUTION` field; detection succeeds on fallback 3 via the model
string. Other firmware (e.g. some ZD/ZT) hits fallback 2 and yields
`densityDpm` exactly. Width and height from `printWidth` / `labelLength`
(dots) are populated in the Printer info card. Manual edits to the
density input are sticky — a re-detection won't stomp on a user
override; reselect the printer in the dropdown to wipe overrides and
detect afresh.

The two parser helpers documented in code:

- `parseDensity(s)` — returns `{ dpi, dpm }` from any printer-reported
  density string. The tests in code cover all three observed shapes.
- `parseSgdValue(raw)` — strips STX/ETX framing and surrounding quotes
  from raw SGD responses.

Detection has a longer per-query timeout (5 s, single attempt) than
status reads. Two reasons:

- `getSGD` uses `sendThenReadAllAvailable` → `readUntilStringReceived`
  with an empty search string, which **always recurses** until `/read`
  returns empty. With the shim's 2 s read timeout that means a single
  SGD call costs ~2.25 s minimum even when the printer answers
  immediately.
- Our requests queue *behind* the SDK's own auto-fired
  `getConfiguration` (kicked off by `Zebra.Printer`'s `configTimeout`)
  plus the parallel `refreshStatus`, adding ~500–800 ms of contention.

Failures are best-effort: the inputs keep their previous values and a
warning lands in the log panel — no red error pill. If every dpi source
fails, the log dumps the available `^HH` keys so the next round of
fallbacks can be added without another debug round-trip.

### 3c. Diagnostics & raw commands

The Diagnostics section near the bottom of the page sends arbitrary
Zebra commands directly to the selected device and shows the raw
response. It exists for two reasons: (1) the same primitives the page
uses for detection (SGD, `^HH`, `~hi`) are useful to inspect on their
own when something isn't working, and (2) the page might as well be a
generally-useful Zebra setup tool, not just a print demo.

**Bypasses the SDK's request queue.** Diagnostics call
`BrowserPrint.Device.send` / `.read` directly rather than going through
`Zebra.Printer`'s queued `Request` machinery. That gives predictable
single-shot behavior and avoids contending with the SDK's internal
auto-fired `getConfiguration` (the `configTimeout` retry cycle) or the
page's own `refreshStatus` / detection calls. Same approach already
used by the print pathways' `device.send(zpl)`.

**Two modes per command.**

| Mode | What happens | Used by |
|---|---|---|
| `read`  | `device.send(bytes)`; then `device.read()` raced against an 8 s timeout. Response is rendered with control characters decoded (`<STX>`, `<ETX>`, `<LF>`, `<CR>`, `<TAB>`, `<0xNN>`) plus a 16-byte/row hex dump. | Query commands: `~hi`, `~HS`, `^HH`, `^HZa`, `! U1 getvar "*"`, custom "Send + Read" |
| `write` | `device.send(bytes)` only. No read attempted. UI confirms the byte count. | Fire-and-forget commands that don't reply: `^WC` (print config label), `~JC` (calibrate), `~JR` (reset), custom "Send (no read)" |

Picking the right mode matters: a `read` against a write-only command
(say `^WC`) waits the full 8 s before timing out; a `write` against a
query (say `~hi`) drops the response on the floor.

**Presets shipped:**

| Button | Bytes sent | Mode | Notes |
|---|---|---|---|
| Host info `~hi`            | `~hi\r\n`               | read  | STX-framed model/firmware string. Source for the model-string dpi fallback (§3b). |
| Host status `~HS`          | `~HS\r\n`               | read  | Three STX/ETX-framed records — see §3a. |
| Host config `^HH`          | `^XA^HH^XZ`             | read  | Multi-line, fixed-width KEY/VALUE block. The SDK parses it into `printWidth`, `labelLength`, `firmwareVersion`, etc. |
| All settings `^HZa`        | `^XA^HZa^XZ`            | read  | Older syntax. Empty on some firmware — useful diagnostic in itself. |
| All SGDs `getvar "*"`      | `! U1 getvar "*"\r\n`   | read  | Can be many KB on Link-OS firmware. The 8 s read timeout is sized for this. |
| Print config label `^WC`   | `^XA^WC^XZ`             | write | Physically prints the config — handy when there's no host network. |
| Calibrate sensor `~JC`     | `~JC`                   | write | Auto-calibrates media sensor. Takes 5–10 s on the device; we don't wait. |
| Reset printer `~JR`        | `~JR`                   | write | Drops the helper's connection to the device. Refresh the printer list afterwards. |

**Custom command** input is a textarea: paste any ZPL block or SGD
command, pick the appropriate Send button. Newlines pass through as-is
(SGD commands typically need a trailing `\r\n`; ZPL blocks `^XA…^XZ`
don't).

**The raw response viewer**'s decoded line replaces all control bytes
with named tokens so framing is visible at a glance — `<STX>` and
`<ETX>` are the framing the SDK is checking for in §3a — and the hex
dump below it is for the cases where a printer returns something
malformed enough that the decoded view isn't enough to debug.

---

## 4. Two-operations implementation gotchas

### zpl2pdf MediaBox bug

zpl2pdf's offline (BinaryKits) renderer produces PDFs with MediaBox in
dots-at-the-DPI rather than points. For a 3"×2" label at 300 dpi the
PDF comes out 1351×901 pts (~18.7" × 12.5") rather than 216×144 pts.
The shim post-processes via Ghostscript `-dPDFFitPage` to rescale to
the correct physical media.

### Content-padding bug

With `-d <dpi>` alone, the MediaBox is ~1.5× larger than the content,
leaving the bottom-right ~33% empty. The shim passes `-w <inches>
-h <inches> -u in` explicitly (parsed from `^PW` and `^LL` in the ZPL)
so zpl2pdf's MediaBox matches its content. Fall-through to auto-detect
when the ZPL has no `^PW`/`^LL`.

### gs rescale

The shim post-processes the zpl2pdf output through `gs -dPDFFitPage`
to rescale to the correct physical media size (parsed from `^PW`/`^LL`
× 72 / dpi). This corrects the MediaBox-in-dots bug and eliminates the
content-padding excess in a single pass.

### Licensing / featureKey

When the page talks to Zebra's *official* helper on Windows / macOS,
`device.convertAndSendFile` for a PDF blob requires a `featureKey` (per
Zebra's own SDK docs) — both the Generated-PDF "Print this PDF" path
(`convertAndSendFileViaSdk`) and the upload-PDF shortcut
(`getConvertedResource`) feed the same value through. The page surfaces
a hint when the error message contains "license" or "key". The bundled
shim's `/convert` endpoint ignores the feature key — it does the
conversion via Ghostscript, no Zebra license required.

**`loadFeatureKey()` at startup**: `fetch('feature-key.txt')` from the
same origin (i.e. `app/feature-key.txt`, gitignored). One-line file
containing the key. If 200 with non-empty body, the value populates
the module-level `featureKey` and both print paths spread it into the
SDK options. If absent / empty / network-failure, `featureKey` stays
empty and both call sites suppress the option entirely (so the SDK
sees no `featureKey` at all rather than an empty string).

The repo deliberately does **not** ship a key. For prototyping, Zebra
publishes a public demo key in plaintext on its own test harness; the
forum thread at <https://developer.zebra.com/forum/25874> points
developers at it, and the value can be extracted by viewing source on
<https://cagdemo.com/BrowserPrint/test/external/zebra_test.html>. We
document the location in README §4a rather than committing a copy.
Two reasons:

1. Avoid any appearance of distributing licensed material from this
   repo, even though the demo key is genuinely public.
2. Force a deliberate per-deployment step. Anyone using Zebra's
   official helper is in a production-shaped scenario where the demo
   key is the wrong long-term answer anyway — they should be getting
   a real key from Zebra.

There is no UI input for the key; it's deployment configuration, not
per-session state. The historical "PDF feature key" textbox + "remember
in localStorage" checkbox was removed in May 2026 — see decision-log
entry 25. The bundled `DEFAULT_FEATURE_KEY` constant was removed
shortly after — see entry 26.

---

## 5. PDF Direct as alternative architecture

Modern Zebra Link-OS printers (the GX430t included, with current
firmware) support **PDF Direct**: send a raw PDF to the printer over
the wire and the firmware rasterizes it on the device. From Browser
Print this is one call:

```js
device.sendFile(pdfBlob, onSuccess, onError);
```

No `getConvertedResource`, no helper-side conversion, no `featureKey`.
The constraint is firmware-side: PDF Direct must be enabled in the
printer's configuration (`! U1 setvar "apl.enable" "pdf"` via Zebra
Setup Utilities, or the printer's web UI). Some older Link-OS firmware
predates PDF Direct and won't accept this; check the printer's
capabilities page before relying on it.

We have *not* exercised this pathway in the page — the GX430t in the
dev environment hasn't had its firmware audited for PDF Direct
support — but it's the cleanest production answer if the deployed
fleet turns out to support it: no licensing entanglement, no
per-machine keys, no helper-side conversion latency. Worth validating
early in any PIH rollout. See §7.

---

## 6. Production integration thoughts (for the OpenMRS module)

The natural integration with `openmrs-module-printer` is to **keep the
existing server-side ZPL generation** (the most valuable part of the
module) and **swap the transport** for printers tagged as
"client-side / Browser Print":

| Today | Production path proposed |
|---|---|
| Server opens raw socket to printer's IP:9100 | Server returns ZPL to the browser |
| Server writes ZPL bytes | Browser calls `device.send(zpl)` via the Browser Print SDK |
| Server closes socket | Browser reads `Zebra.Printer.getStatus()`, reports back |

The wire format is unchanged — same `^XA … ^XZ` blob the module already
generates. Only the last hop (server-to-printer-socket) becomes
(server-to-browser-to-Browser-Print-to-printer).

Worth doing on the OpenMRS side eventually:

- A small `printer-type=BROWSER_PRINT` flag on `Printer`, alongside the
  existing network-socket flag.
- A REST endpoint that returns `{ zpl: "..." }` for the print job, plus
  metadata (label format, printer hint).
- A page-level JS module that lazy-loads the Zebra SDK, listens for print
  events from the OpenMRS UI, calls `device.send`, then POSTs the parsed
  status back as a print receipt.
- Helper installation guidance for the IT team rolling out clients.

---

## 7. Open questions / things we explicitly did not test

- **PDF Direct on the GX430t** — `device.sendFile(pdfBlob)` would let us
  drop the helper conversion (and therefore the `featureKey`) entirely.
  Whether the deployed printer firmware has PDF Direct enabled is
  unknown; should be the first thing checked before scaling up.
- **Helper conversion fidelity vs the shim's conversion** on real labels —
  needs a `featureKey` to drive Zebra's official helper for the side-by-side.
- **203 dpi barcode scannability** from pathway 2 — speculative until tested
  with a hand scanner.
- **Network printers** via Browser Print on Windows — should "just work"
  per Zebra's docs but we haven't actually tried it.
- **HTTPS deployment** with the helper's self-signed cert on port 9101 — the
  flow is documented above but not exercised end-to-end yet.
- **Multi-label batches** — the form pathways print one label per click.
  The OpenMRS use case (specimen sheets, etc.) probably wants concatenated
  `^XA…^XZ` blobs in a single `device.send` — the Custom ZPL pathway
  already handles this if the caller assembles the blob.

---

## 8. Shim internals

### What works in the shim

- Pathway 1 — Direct ZPL: ✅ (just bytes through `/dev/usb/lp0` or a TCP
  socket).
- Pathway 2 — Helper-converted PDF→ZPL: ✅ *if Ghostscript is installed*.
  The shim implements `/convert` itself: Ghostscript renders the PDF at the
  printer's dpi, Floyd-Steinberg dithers the result to 1-bit, and the
  bitmap is emitted as a fully-compressed ZPL `^GFA` field. See "PDF
  conversion" below.
- Status reads (`Zebra.Printer.getStatus` → `~HS` → parsed): ✅. The kernel
  `usblp` device node is bidirectional, so the printer's response is
  readable. Network printers also keep the TCP socket open across
  `/write`+`/read` so query/response works.

### What doesn't work in the shim

- Image-conversion endpoints (BMP/JPG/PNG/TIF/GIF): ❌. Not implemented; pass
  PDF instead, or rasterize client-side before sending.
- `action: "store"` on `/convert` (which sends `^DG` flash-storage commands
  to the printer): ❌. Returns 501.

The shim's `/config` advertises `api_level: 2` if Ghostscript is missing
(only `device.send`/`device.read` work) and **API level 4 with
`supportedConversions: {"pdf": ["zpl"]}`** when Ghostscript is present (so
`/convert` is enabled).

### PDF conversion (the shim's `/convert`)

When `gs` is on the PATH, the shim implements `POST /convert` end-to-end:

1. **Render** page 1 of the PDF with Ghostscript at the configured dpi
   (`--convert-dpi`, default 300), with full text + graphics antialiasing
   (`-dTextAlphaBits=4 -dGraphicsAlphaBits=4`).
2. **Halftone** the resulting 8-bit PGM into 1-bit. `--convert-mode dither`
   (default) uses Floyd-Steinberg error diffusion — preserves grayscale
   gradients and antialiased edges. `--convert-mode threshold` does a naive
   `< 128` cut — sharper for pure text/barcode but loses grayscale detail.
3. **Compress** the bitmap into ZPL `^GF` data using the standard letter
   scheme (`G..Y` = 1..19, `g..z` = 20..400, `,` = white-pad row, `!` =
   black-pad row, `:` = repeat previous row). The same scheme Zebra's
   tooling produces. For a mostly-white label this typically shrinks ~5–10×
   compared with raw hex.
4. **Wrap** in `^XA^PW{w}^LL{h}^LH0,0^FO0,0^GFA,…^FS^XZ` and return as a
   JSON-encoded string (which is what the SDK does `JSON.parse` on and
   resolves the `getConvertedResource` promise with).

If `options.action == "print"` (the default for `convertAndSendFile`) the
shim *also* sends the converted ZPL to the device after returning the
response — same behavior as Zebra's helper.

Performance on a 3"×2" label at 300 dpi (900×600 pixels = 540 K px):
threshold mode ~70 ms, dither mode ~200 ms (Floyd-Steinberg in pure
Python). Acceptable for interactive use; could be 5–10× faster with numpy
if it becomes a bottleneck.

**Caveat — this is *not* Zebra's licensed converter.** It's a credible
substitute (Ghostscript renders well, Floyd-Steinberg is the de facto
standard halftone, the `^GF` compression is the same scheme), but small
fidelity differences are inevitable, especially for content that exercises
specialized halftoning (photographs, dense grayscale). For exact parity
with what production clients will print, run the page against Zebra's
official helper on Mac/Windows and compare on real labels.

The `featureKey` field is accepted but not validated by the shim — there's
no license to check.

**Validated end-to-end during development** with `curl` against the API
contract extracted from `BrowserPrint-3.1.250.min.js`: `/config`,
`/available`, `/default`, `/default?type=printer`, `OPTIONS /write` (CORS
preflight), `POST /write`, `POST /read`, and `POST /convert` for both
`action=return` (used by `getConvertedResource`) and `action=print` (used
by `convertAndSendFile`). HTTP shapes round-trip with the SDK's
expectations.

### mDNS printer discovery

At startup and on each periodic rescan (see `--rescan-seconds`), the shim
calls `discover_mdns_network_printers()` unless `--no-mdns` is passed. The
function shells out to `avahi-browse -ptr _pdl-datastream._tcp` with a 5 s
timeout. Lines starting with `=` carry resolved records in
semicolon-delimited form:
`=;<iface>;<proto>;<service-name>;<type>;<domain>;<host>;<addr>;<port>;<txt>`.
IPv6 entries (fields[2] != `'IPv4'`) are skipped to avoid duplicate
registrations for the same printer. By default, parsed entries are filtered
to Zebra ones — the lowercased concatenation of service name + TXT records
must contain "zebra" or the entry is dropped. `--all-mdns-printers` disables
this; explicit `--network` / `printers.json` registrations bypass it.
Discovered devices are deduped against any already-registered `(host, port)`
pairs from `--network` CLI args or `printers.json`; explicit registrations
win on collision so users can override an auto-discovered display name. Any
failure (missing `avahi-browse`, timeout, parse error) is swallowed — the
function returns an empty list rather than raising.

The page's **Refresh printer list** button POSTs to `POST /rediscover`,
which calls `refresh_devices` synchronously. This lets users pick up new
network printers without restarting the shim. Zebra's official helper
returns 404 on `/rediscover`; the page silently ignores that and proceeds
with the normal `getLocalDevices` flow.
