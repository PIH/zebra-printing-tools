# Client-side label printing — prototype & findings

A self-contained Chrome page (`browser-print.html`) that prints a label
(text + Code 128 barcode `A456123`) directly from the browser to a Zebra
ZPL printer, with no print dialog and no per-print user interaction.
Resolution and label dimensions are auto-detected from whichever printer
the user picks — the prototype was developed against a GX430t but works
unchanged on any GX/ZD/ZT/etc. that the Browser Print helper can see.
The page has also grown a Diagnostics panel (preset Zebra commands plus a
free-form raw-command input with decoded + hex-dumped responses), so it
doubles as a setup / troubleshooting tool for any Zebra ZPL printer the
helper exposes.

This README captures both *how to run it* and *what we learned while
designing it*, so the next person picking this up doesn't have to retrace
the conversation.

---

## 1. Goal & constraints

- **Target printers:** any Zebra ZPL printer the Browser Print helper /
  shim can see. Developed against a GX430t (300 dpi); should also cover
  GX420t / ZD220 (203 dpi), ZD/ZT 600 dpi variants, etc. The page reads
  the head density and currently-loaded label size from the printer on
  selection (see §8b), defaults to whichever display unit the printer
  itself reports in (inches if dpi-only, millimetres if `N/mm` was
  found), and lets the user override either before printing.
- **Client OSes:** primarily Windows; should also work on Ubuntu and macOS.
- **Browser:** Chrome.
- **Hard requirements:**
  - No print dialog.
  - No per-print user interaction (one-time setup is fine).
  - Printer remains usable by other applications on the same machine.
- **Scope:** prototype an HTML page that prints a label with text and a
  Code 128 barcode of `A456123`, exploring both ZPL-direct and PDF-input
  pipelines. Default geometry is 3"×2" but can be set to whatever stock
  is loaded.
- **Existing OpenMRS module behaviour:** server-side ZPL generation, then
  pushed to network printers over a raw TCP socket on port 9100. The
  client-side path needs a different transport but should reuse the same
  ZPL where possible.

---

## 2. Options surveyed

### Print.js (already in this folder)
**Rejected.** Print.js generates an iframe and calls `window.print()`. That
still triggers Chrome's print preview, violating the "no dialog" requirement.
The file is left in the directory only because it was already there.

### `window.print()` / OS print system via Zebra driver
**Rejected.** Same dialog problem. Even with kiosk-print flags, you're at the
mercy of Chrome's print policy and the driver's behaviour, and you give up
fine control over ZPL.

### WebUSB (talk to the printer's bulk endpoint directly from the page)
**Considered, then rejected.** Zero-install on the *page* side, but each OS
has a friction point that blocks the prototype-to-production path:

- **Windows:** the OS's `usbprint.sys` claims the device. To make it
  WebUSB-visible you have to swap the driver to WinUSB (via Zadig). That
  removes the printer from the OS print system, so other apps can no longer
  use it — directly violating one of our constraints.
- **Linux:** the kernel `usblp` module auto-claims the printer-class
  interface; you'd need a udev rule + module blacklist or per-attach unbind.
- **macOS:** generally works, but if CUPS has the printer added it'll fight
  WebUSB for the device.
- **Pairing:** Chrome requires a one-time `requestDevice()` user gesture per
  origin/profile. That's small but not zero.

WebUSB is the cleanest "browser native" demo, but it doesn't survive contact
with the production constraint that the printer must remain usable by the OS.
We did not pursue it.

### Zebra Browser Print
**Selected.** Small native helper app (Windows MSI / macOS PKG / Linux DEB)
that runs in the user session and exposes a localhost HTTP service. The page
talks to it via Zebra's official JavaScript SDK. The helper sends bytes
through the OS's installed Zebra driver, so the printer remains a normal
system printer.

Trade-off: each client needs the helper installed once. In return: no driver
swaps, no kernel-module fights, no pairing prompt, USB *and* network printers,
official Zebra support, and parsed printer status.

### PDF Direct on the printer
**Not available on the GX430t.** PDF Direct is a Link-OS firmware option on
ZT400/ZT600 series and some ZD620 models — those printers can take a `.pdf`
straight on the wire. The GX430t's firmware has no PDF interpreter, so any
"send a PDF" workflow has to convert to ZPL on the client before transport.

---

## 3. Browser Print: architecture worth knowing

Two separately-downloaded artefacts that are easy to confuse:

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

### SDK shape (verified from the bundled JSDoc)

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

## 4. PDF input: two pathways, two trade-offs

The page builds the same content two ways so they can be compared on
physical labels:

| # | Pathway | Where the conversion happens | Output | License |
|---|---|---|---|---|
| 1 | **Direct ZPL**       | (no conversion) | ~340 bytes ZPL | none |
| 2 | **PDF → helper ZPL** | In the helper: `Zebra.Printer.getConvertedResource(pdf, {toFormat:'zpl'})` | typically ~6–25 KB compressed ZPL | **Zebra's official helper requires a PDF feature key. The bundled `browser-print-shim.py` does not.** |

(An earlier draft had a middle pathway that rasterized the PDF *in the
browser* via pdf.js + a naive luminance threshold, emitting raw `^GFA`
hex. We dropped it once the shim implemented `/convert` properly: that
earlier pathway was strictly worse than the helper-converted pathway on
every axis — quality, payload size, dependencies — and the only thing
it could do that the helper pathway can't was "render the PDF without a
helper", which doesn't matter because the helper is required for the
actual print transport regardless. See decision log entry 13.)

### Pathway 1 (Direct ZPL)

Text via `^A0N`, barcode via `^BC` (Code 128). Native primitives, rendered by
the printer's firmware. Sharp at any dpi, smallest payload, most robust
barcode (bars land exactly on dot boundaries).

This is the natural fit for anything OpenMRS already structures — patient
labels, specimen labels, wristbands.

### Pathway 2 (PDF → helper ZPL)

Calls `Zebra.Printer.getConvertedResource(blob, {toFormat:'zpl', featureKey})`.
The helper does the conversion in native code with proper halftoning. The
resulting ZPL is sent via `device.send` so the wire timing is comparable
across pathways.

**Licensing.** The bundled SDK docs are explicit:

> `featureKey` *string* — the licensing key for the file conversion.
> Currently, only converting from a PDF file requires a licensing key.

Without a valid `featureKey`, Zebra's official helper rejects the
conversion. The page surfaces the error and adds a hint when the message
contains "license" or "key". The license is normally per-machine and is
obtained from Zebra; image conversions (BMP/JPG/PNG/TIF/GIF) do *not*
require it.

**Public demo key.** The `DEFAULT_FEATURE_KEY` baked into
`browser-print.html` is the same key Zebra hands out for prototyping —
it's hardcoded in plaintext on Zebra's own public test harness at
[cagdemo.com/BrowserPrint/test/external/zebra_test.html](https://cagdemo.com/BrowserPrint/test/external/zebra_test.html)
and Zebra's developer forum
([thread 25874](https://developer.zebra.com/forum/25874)) directs people
there to copy it. So shipping it here is the same posture Zebra itself
takes. Caveat: Zebra could rotate or revoke it at any time, so for
production rollouts obtain a per-machine key — *or* skip the helper
conversion entirely via PDF Direct (next section).

The included Linux shim ignores the key (no licensing) and produces a
credible substitute via Ghostscript + Floyd-Steinberg + ZPL `^GF`
compression — see §5b.

### PDF Direct (alternative — no feature key required)

Modern Zebra Link-OS printers (the GX430t included, with current
firmware) support **PDF Direct**: send a raw PDF to the printer over the
wire and the firmware rasterises it on the device. From Browser Print
this is one call:

```js
device.sendFile(pdfBlob, onSuccess, onError);
```

No `getConvertedResource`, no helper-side conversion, no `featureKey`.
The constraint is firmware-side: PDF Direct must be enabled in the
printer's configuration (`! U1 setvar "apl.enable" "pdf"` via Zebra
Setup Utilities, or the printer's web UI). Some older Link-OS firmware
predates PDF Direct and won't accept this; check the printer's
capabilities page before relying on it.

We have *not* exercised this pathway in the prototype — the GX430t in
the dev environment hasn't had its firmware audited for PDF Direct
support — but it's the cleanest production answer if the deployed fleet
turns out to support it: no licensing entanglement, no per-machine keys,
no helper-side conversion latency. Worth validating early in any
PIH rollout. See §10.

### Things to compare on real labels

- **Barcode scannability.** Pathway 1 is the gold standard. Pathway 2
  should be close at 300 dpi via the official helper or the shim's dither
  mode. Verify with a hand scanner; module width is what matters.
- **Text weight.** Direct ZPL uses Zebra's bitmap font 0 (hand-tuned per
  dpi); pathway 2 uses Helvetica from the PDF rasterized by the converter.
  At 300 dpi the difference is small. At 203 dpi small body text from
  pathway 2 noticeably degrades.
- **Halftoning.** Pathway 2 wins handily for grayscale gradients,
  photographs, or logos — pathway 1 has nothing to halftone (it's printer
  primitives), and the shim's `--convert-mode dither` (default) does
  proper error diffusion.
- **Payload size.** ~340 bytes vs typically 6–25 KB. Both are trivial over
  USB; matters if you ever spool many labels over a slow link.
- **Latency.** Direct ZPL is essentially instant. Helper conversion adds a
  localhost round-trip plus the helper's conversion time (~70 ms threshold,
  ~200 ms dither in the shim; the official helper is C++ and should be
  faster).

---

## 5. Setup

You need *something* listening on `http://127.0.0.1:9100/` that speaks the
Browser Print API. Two routes:

- **Production-style** — install Zebra's official Browser Print helper.
  Available for Windows and macOS. See §5a.
- **Linux dev / test** — run the small Python shim included in this folder
  (`browser-print-shim.py`). Speaks the same API; the SDK doesn't know it's
  talking to a substitute. See §5b.

Once one of those is running, the rest is the same:

1. **Make sure the printer is reachable.** USB Zebra connected and powered
   on, or its IP listed in the helper's config.
2. **Serve this folder.** `127.0.0.1` is treated as a secure context in
   Chrome, so the SDK can reach the helper from `file://` too:
   ```
   cd testing
   python3 -m http.server 8000
   # → http://localhost:8000/browser-print.html
   ```
3. Open the page, pick your printer in the dropdown (the page reads its
   dpi and label dimensions on selection — see §8b — and pre-fills the
   geometry inputs accordingly; override anything the printer reports
   wrong), exercise each pathway. Watch the status pill after each print.

### 5a. Official Browser Print (Windows / macOS)

Download from
<https://www.zebra.com/us/en/support-downloads/software/printer-software/browser-print.html>
(search "Browser Print"). The page distributes builds for **Windows PC**,
**OSX**, **Android**, and the JavaScript Library — but **not Linux**. As of
the time we checked, Zebra's main downloads page has no current Linux
build; there is a knowledge-base article (`000022132 — Browser Print Client
Application for Linux OS`) but its content was not reachable from our
fetcher. If you find an actual Linux package there, please update this
README — we'd rather rely on Zebra's helper than the shim.

After install, the helper runs as a per-user background service started by
your desktop session. Verify with:
```
curl http://127.0.0.1:9100/available     # should return JSON
```

The printer must already be registered with the OS — USB driver installed
on Windows / macOS, or added as a network printer via its IP. Browser Print
discovers what the OS already sees.

### 5b. Linux dev shim — `browser-print-shim.py`

Since Zebra's helper isn't currently distributed for Linux, this folder
includes a minimal Python shim that mirrors the Browser Print HTTP API. The
SDK in the browser does not know it's talking to a substitute.

```
python3 browser-print-shim.py                                    # USB only
python3 browser-print-shim.py --network 192.168.1.42             # one network printer
python3 browser-print-shim.py --network 'Lab GX430t=10.0.0.5'    # named, default port
python3 browser-print-shim.py --no-usb --network 192.168.1.42    # network only
```

Stdlib only — no `pip install` needed. CORS-allows everything (it's a dev
tool). Listens on `http://127.0.0.1:9100`. Pass `--https` to also bind
`https://127.0.0.1:9101` (auto-generates a self-signed cert via openssl on
first run, for testing pages that are themselves served HTTPS).

The shim handles **both transports the GX430t supports** — same wire format
(ZPL bytes), different last hop:

#### USB printers

Auto-discovered from `/dev/usb/lp*`. Those are the device nodes the kernel
`usblp` driver creates for any USB printer plugged in — and they're
bidirectional, which is how the shim forwards `~HS` status reads back to
the SDK.

Your user needs read/write access to those nodes; the simplest fix is the
`lp` group:
```
sudo usermod -aG lp $USER     # then log out and log back in
```
The shim re-scans every 30 s, so hot-plug works.

#### Network printers

Two ways to register one:

```
# Inline on the command line (repeatable). Format: [NAME=]HOST[:PORT]
python3 browser-print-shim.py --network 192.168.1.42
python3 browser-print-shim.py --network 'Lab GX430t=192.168.1.42:9100' \
                              --network 'Pharmacy GX430t=192.168.1.43'
```
or in a `printers.json` next to the shim:
```json
{
  "network": [
    { "name": "Lab GX430t",      "host": "192.168.1.42", "port": 9100 },
    { "name": "Pharmacy GX430t", "host": "192.168.1.43" }
  ]
}
```

Default port is 9100 (raw / JetDirect — the same port the existing OpenMRS
module already uses to push ZPL to network printers). The shim opens a
persistent TCP socket per device so `device.write` followed by `device.read`
can do the `~HS` query/response cycle on the same connection.

#### Finding a Zebra's IP

If you don't already know the printer's IP:

- **Print a config label.** Most Zebras have a button combo (often: hold
  Feed for ~5 s) that emits a label with the IP printed on it.
- **Ask the printer over mDNS** — Zebra printers advertise via Bonjour:
  ```
  avahi-browse -rt _pdl-datastream._tcp     # raw / port 9100
  avahi-browse -rt _printer._tcp            # LPD
  avahi-browse -rt _ipp._tcp                # IPP
  ```
- **The printer's web UI** if it's already on the network — point a
  browser at the assigned IP.

The shim does *not* currently auto-discover network printers. If you want
mDNS auto-discovery wired in, that's a small addition (shells out to
`avahi-browse`, ~30 lines). Tell me if it's worth it.

**What works** in the shim:
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

**What doesn't work** in the shim:
- Image-conversion endpoints (BMP/JPG/PNG/TIF/GIF): ❌. Not implemented; pass
  PDF instead, or rasterize client-side before sending.
- `action: "store"` on `/convert` (which sends `^DG` flash-storage commands
  to the printer): ❌. Returns 501.

The shim's `/config` advertises `api_level: 2` if Ghostscript is missing
(only `device.send`/`device.read` work) and **API level 4 with
`supportedConversions: {"pdf": ["zpl"]}`** when Ghostscript is present (so
`/convert` is enabled).

#### PDF conversion (the shim's `/convert`)

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
response — same behaviour as Zebra's helper.

Performance on a 3"×2" label at 300 dpi (900×600 pixels = 540 K px):
threshold mode ~70 ms, dither mode ~200 ms (Floyd-Steinberg in pure
Python). Acceptable for interactive use; could be 5–10× faster with numpy
if it becomes a bottleneck.

**Caveat — this is *not* Zebra's licensed converter.** It's a credible
substitute (Ghostscript renders well, Floyd-Steinberg is the de facto
standard halftone, the `^GF` compression is the same scheme), but small
fidelity differences are inevitable, especially for content that exercises
specialised halftoning (photographs, dense grayscale). For exact parity
with what production clients will print, run the prototype against Zebra's
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

---

## 6. Per-platform notes

### Windows
- Browser Print talks through the **installed Zebra driver**. If a print job
  comes out as a multi-page text dump of your ZPL, the printer is
  configured as a "Generic / Text" or "Microsoft IPP" device — switch it to
  the Zebra-supplied driver so the bytes pass through unchanged.
- No driver swap is needed (this is the whole point of choosing Browser
  Print over WebUSB).
- USB and network printers both work.

### macOS
- Generally just works. The printer can stay registered in CUPS — Browser
  Print uses it normally rather than fighting for exclusive USB access.

### Ubuntu / Linux
- No official Browser Print build on the main downloads page; we use
  `browser-print-shim.py` instead (§5b).
- USB and network printers both work in the shim.
- For USB, the kernel `usblp` driver gives us `/dev/usb/lp*` — your user
  needs `lp` group membership. We did *not* need the udev rule / `usblp`
  blacklist required for the WebUSB approach, because the shim cooperates
  with the kernel driver instead of competing with it.
- Network printers are added via `--network HOST[:PORT]` or `printers.json`.
- The printer can also be added to CUPS for other applications; the shim
  doesn't interact with CUPS at all (it talks straight to `/dev/usb/lp*` or
  a TCP socket).

---

## 7. ZPL primer (what the prototype emits)

For a 3" × 2" label that's 900 × 600 dots at 300 dpi (or 609 × 406 at
203 dpi). The page reads dpi, width, and height from inputs (auto-filled
on device selection — see §8b) and scales `^PW` / `^LL` accordingly; the
sample ZPL below shows the 300-dpi GX430t case.

**Pathway 1 sample (layout matches what pathway 2 produces — same margins,
font sizes, bottom-anchored barcode):**
```
^XA
^CI28                                          ; UTF-8
^PW900                                         ; print width in dots
^LL600                                         ; label length in dots
^LH0,0                                         ; label home
^FO50,50^A0N,58,58^FDOpenMRS Test Label^FS     ; header (matches PDF 14 pt)
^FO50,130^A0N,46,46^FDID: A456123^FS           ; body (matches PDF 11 pt)
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

## 8. Querying the printer (status, capability detection, diagnostics)

The page consolidates three kinds of printer query into a single "Printer"
section (status pill + a model/firmware/dpi/connection/UID grid, with a
single Refresh button that re-runs both halves), plus a separate
Diagnostics section for ad-hoc commands. The mechanics differ enough to
be worth describing separately; see 8a/8b/8c below.

`Zebra.Printer.getStatus()` issues `~HS` to the device, reads the response,
and parses it into a `Zebra.Printer.Status` object with:

- `isPrinterReady()` → boolean
- `offline` → boolean (set when the response framing fails — see below)
- `getMessage()` → human-readable description (e.g., "Ready to Print",
  "Head Open", "Paper Out")

Plus boolean fields the SDK populates from the `~HS` response (head open,
paper out, paused, ribbon out, receive buffer full, partial format in
progress, head cold/hot, etc.).

The prototype refreshes status ~350 ms after each print (the SDK's queue
keeps the status query strictly after the in-flight print, so they don't
race).

`device.send` returning success only means *bytes were buffered to the
helper*, not that the label printed. The post-print status read is what
gives you the real "did it actually print" signal.

### 8a. The "Offline" trap

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

### 8b. Printer capability detection

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
`densityDpm` exactly. Width and height are filled from `printWidth` /
`labelLength` (dots) via `dotsToValue()` in the user's current display
unit. Manual edits to any of the three inputs (density, width, height)
are sticky — a re-detection won't stomp on a user override; reselect
the printer in the dropdown to wipe overrides and detect afresh.

#### Display units (in / mm) and the toggle

The page can show label dimensions in either inches or millimetres. The
current unit drives:

- the suffix shown after the width / height inputs (`in` / `mm`),
- the *resolution* field's units and datalist (`dpi` with options
  `152 / 203 / 300 / 600`, or `dots/mm` with options `6 / 8 / 12 / 24`),
- the Printer info card's Resolution row (`300 dpi (12 dots/mm)` or
  `12 dots/mm (300 dpi)` — primary in current unit, other in parens
  when known),
- the wording of the detected-summary line.

**Default behaviour is honest to the printer.** If `^HH RESOLUTION`
yields an exact `densityDpm` and the user hasn't already toggled the
unit this session, the page auto-switches to mm so the displayed
numbers match what the printer reports. The auto-switch is *not*
persisted — a fresh page load starts at inches and re-evaluates from
detection. A user toggle sets a session-only `userOverrodeUnit` flag
that disables auto-switching for the rest of the session.

**Toggling preserves physical output, not the inch/mm ratio.** Width
and height conversions go via *dots*, not via the naïve `× 25.4`
factor:

```
Inches mode:  3.00 in × 300 dpi  = 900 dots
Toggle to mm: 900 dots ÷ 12 dpm  = 75.0 mm   ← same dots, same physical output
              (NOT 3.00 × 25.4   = 76.2 mm × 12 dpm = 914 dots — different!)
```

This matters because Zebra's labelled dpi (`300`) and the underlying
dot density (`12 dots/mm = 304.8 dpi`) round differently — going
through the inch/mm ratio loses ~1.6%. Going through dots, the toggle
is a pure display change. Density values themselves convert via the
standard mapping (`6 ↔ 152`, `8 ↔ 203`, `12 ↔ 300`, `24 ↔ 600`); for
non-standard densities, computed via `× 25.4` (lossy by ≤1.6% in the
unusual case).

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

### 8c. Diagnostics & raw commands

The Diagnostics section near the bottom of the page sends arbitrary
Zebra commands directly to the selected device and shows the raw
response. It exists for two reasons: (1) the same primitives the page
uses for detection (SGD, `^HH`, `~hi`) are useful to inspect on their
own when something isn't working, and (2) the page might as well be a
generally-useful Zebra setup tool, not just a print demo.

**Bypasses the SDK's request queue.** Diagnostics call
`BrowserPrint.Device.send` / `.read` directly rather than going through
`Zebra.Printer`'s queued `Request` machinery. That gives predictable
single-shot behaviour and avoids contending with the SDK's internal
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
| Host info `~hi`            | `~hi\r\n`               | read  | STX-framed model/firmware string. Source for the model-string dpi fallback (§8b). |
| Host status `~HS`          | `~HS\r\n`               | read  | Three STX/ETX-framed records — see §8a. |
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
`<ETX>` are the framing the SDK is checking for in §8a — and the hex
dump below it is for the cases where a printer returns something
malformed enough that the decoded view isn't enough to debug.

---

## 9. Production integration thoughts (for the OpenMRS module)

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

## 10. Open questions / things we explicitly did not test

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
- **Multi-label batches** — the prototype prints one label per click. The
  OpenMRS use case (specimen sheets, etc.) probably wants concatenated
  `^XA…^XZ` blobs in a single `device.send`.

---

## 11. Files in this directory

```
browser-print.html                  ← the prototype (single file, both pathways)
browser-print-shim.py               ← Linux dev shim (Browser Print API substitute)
                                      — supports USB and network transports
README.md                           ← this file
zebra-browser-print-js-v31250/      ← Zebra SDK 3.1.250 + sample + bundled JSDoc
pdf-lib.min.js                      ← vendored, used by pathway 2 (PDF construction)
printers.json                       ← optional: list of network printers for the shim
print.min.js                        ← unused — Print.js still triggers a print dialog;
                                      left in tree only because it was already here
shim-cert.pem, shim-key.pem         ← generated by `--https`; gitignore them
```

External (CDN) dependencies the prototype loads:

- `JsBarcode` 3.11.5 — generates the Code 128 PNG embedded in the PDF.

For production this should be vendored next to `pdf-lib.min.js`.

---

## 12. Decision log (chronological summary)

| Step | What happened |
|---|---|
| 1 | Started from the existing module's network-socket ZPL printing, looking for client-side equivalents in the browser. |
| 2 | Surveyed: Print.js (rejected — dialog), `window.print()` (rejected — dialog), WebUSB (rejected — Windows driver swap removes the printer from the OS), Zebra Browser Print (selected). |
| 3 | First prototype hit Browser Print's HTTP API directly via `fetch()`. Worked, but didn't handle the HTTP↔HTTPS port switch and didn't surface parsed printer status. |
| 4 | Discovered the SDK and the helper application are *separate* downloads — adding the SDK alone isn't sufficient. |
| 5 | Discovered (by reading `BrowserPrint-3.1.250.min.js`) that the helper actually listens on **two** ports: 9100 (HTTP) and 9101 (HTTPS, self-signed). The SDK picks based on the page's protocol. |
| 6 | Discovered (in the SDK's bundled JSDoc) that PDF conversion via the helper is gated on a Zebra `featureKey` license. Image conversions are not. |
| 7 | Refactored to use the SDK throughout (`BrowserPrint.getDefaultDevice`, `device.send`, `Zebra.Printer.getStatus`), added a third pathway via `Zebra.Printer.getConvertedResource`, wired post-print status reads. |
| 8 | Discovered Zebra no longer distributes a Linux Browser Print build on the main downloads page (only Windows / macOS / Android). |
| 9 | Built `browser-print-shim.py` — a stdlib-only Python service that mirrors the Browser Print HTTP API contract (extracted from `BrowserPrint-3.1.250.min.js`). Supports both transports the GX430t actually uses: USB (via the kernel `usblp` device node, which is bidirectional, so status reads work) and network (raw TCP on port 9100, persistent socket so `~HS` query/response works). Validated end-to-end with `curl`. |
| 10 | Added the user's Zebra PDF feature key as a default in the prototype HTML so pathway 3 doesn't need re-pasting on each load. (Security note: don't commit the file with the key intact to a public repo.) |
| 11 | Tried pathway 3 against the shim, hit the 501 from `/convert` — implemented `/convert` in the shim using Ghostscript + Floyd-Steinberg + ZPL `^GF` run-length compression. The shim now advertises `api_level: 4` and `supportedConversions: {"pdf": ["zpl"]}` when `gs` is on the PATH, so all three pathways can be exercised on Linux dev boxes. Output isn't bit-identical to Zebra's licensed converter but is a credible substitute. |
| 12 | Realised the original "pathway 2" (PDF rasterized in the browser via pdf.js + naive luminance threshold + raw `^GFA`) had become strictly worse than the shim's helper conversion on every axis — quality, payload size, dependencies — and that its only unique property ("works without any helper for the *render* step") was moot because a helper is required for the print transport regardless. Removed pathway 2 entirely; pdf.js dependency dropped; old "pathway 3" promoted to "pathway 2". Page is ~130 lines smaller. |
| 13 | Aligned the direct-ZPL layout (margins, font sizes, barcode size and position) with what the PDF pathway produces, so labels from both pathways come out the same physical size for direct apples-to-apples comparison. Fixed a `^GF` byte-alignment bug in the shim's compression (`rstrip('0')` could strip a single nibble from the last byte when width % 8 ≠ 0). Added stale-USB-buffer drain on device open in the shim (was the likely cause of "Invalid Response" after a shim restart). |
| 14 | This README. |
| 15 | Confirmed the `DEFAULT_FEATURE_KEY` in `browser-print.html` is the *public* PDF demo key Zebra hands out for prototyping (hardcoded plaintext on Zebra's own test harness at `cagdemo.com/BrowserPrint/test/external/zebra_test.html`, with Zebra's developer forum thread 25874 directing users there to copy it). Kept the key in the repo with a citation comment instead of stripping it. Documented PDF Direct (`device.sendFile(pdfBlob)`) as an alternative pathway that needs no `featureKey` if the printer firmware supports it — best production answer if the deployed GX430t fleet has it enabled. |
| 16 | Promoted this prototype out of `openmrs-module-printer/testing/` into a standalone repo at `pih/zebra-printing-tools` — it had grown beyond a "testing" scratchpad (shim, README, SDK, multiple pathways) and the dependency direction is the other way around (the OpenMRS module would consume tools from here, not the other way). |
| 17 | Tracked spurious red "Offline" pills + indefinite "querying…" on the status row to the SDK's STX/ETX framing check on `~HS` responses (`offline = true` whenever the trimmed body doesn't *both* start with `0x02` and end with `0x03`). The actual `~HS` reply is three STX/ETX-framed records flushed back-to-back; the shim's old `/read` returned after the first `select()` fired, often capturing only the first frame. Fixed at the shim layer with `_drain_until_quiet_fd` / `_drain_until_quiet_sock` (drain until 150 ms of silence, 1500 ms hard cap). Belt-and-braces on the page: race each `getStatus` against a 500 ms timeout, retry up to 3× silently on offline / timeout / error, surface the truthful end state. ~2.3 s worst case for both auto-fire and manual click. |
| 18 | Generalised the prototype off the GX430t. Resolution dropdown → numeric input + datalist; new width / height inputs in inches. On device selection the page now fires `head.resolution.in_dpi` SGD + `^XA^HH^XZ` + `~hi` in parallel through the SDK queue, then resolves dpi by escalating fallbacks (canonical SGD → `cfg.settings.RESOLUTION` → model-string regex → `device.host_resolution` SGD). The GX430t we tested doesn't expose the canonical SGD or a RESOLUTION field; detection succeeds on the model-string fallback (`"GX430t-300dpi"` → 300). User edits are sticky — re-detection won't overwrite them; reselect the printer to wipe overrides and detect afresh. Detection has its own 5 s per-query timeout (separate from the status budget) because `getSGD` uses `sendThenReadAllAvailable`, which recurses until `/read` returns empty — costing ~2.25 s per SGD call even on a fast printer. |
| 19 | Promoted the page from "demo with hidden detection" to "general Zebra setup / troubleshooting tool". Added a Printer info section (model / firmware / Link-OS / dpi / connection / UID) populated from the same detection cycle that fills the geometry inputs; merged the previously-separate Status section into it (status row spans the full info-grid width with a thin underline) and replaced the two refresh buttons with a single ↻ Refresh that re-runs status + detection together. New Diagnostics section with eight preset commands (`~hi`, `~HS`, `^HH`, `^HZa`, `getvar "*"`, `^WC`, `~JC`, `~JR`) plus a free-form custom-command textarea; presets are tagged `read` or `write` so query commands wait for a response and fire-and-forget commands skip the read. Raw-response viewer shows control bytes as `<STX>`/`<ETX>`/etc. with a 16-byte/row hex dump beneath. Diagnostics deliberately bypass the SDK's queued Request machinery (uses `device.send` / `device.read` directly) for predictable single-shot behaviour and to avoid contending with the SDK's auto-fired `configTimeout` cycle. Light visual rework: subtle 1 px rules between adjacent non-pathway sections, generous vertical margin, info card uses a grid with monospace values. |
| 20 | Caught that the existing dpi parser dropped `"1280 12/MM FULL"` because it grabbed the leading integer (head width in dots, not dpi) and the "1280" failed the range gate. Replaced `parseDpiCandidate` with `parseDensity` returning both `{ dpi, dpm }` — when an `N/mm` token is present the page now also captures the *exact* dots-per-mm density. Added a unit toggle (in / mm) for the Label-geometry section: changing units flips the resolution-field label between `dpi` and `dots/mm`, swaps its datalist (`152/203/300/600` ↔ `6/8/12/24`), updates the suffix on the width/height inputs, and reflows the Printer-info card's Resolution row to match (with the other representation in parens when known). Page defaults to whatever the printer reports — auto-switches to mm on detection when `densityDpm` is captured, *not* persisted (no localStorage). User toggling sets a session-only `userOverrodeUnit` flag so re-selection of the same printer doesn't bounce them back. The toggle converts width/height via *dots*, not via the naïve `× 25.4` factor — so the toggle preserves physical print output exactly even when the labelled dpi (300) and underlying density (12/mm = 304.8 dpi) round differently. Density itself converts via the standard `6 ↔ 152`, `8 ↔ 203`, `12 ↔ 300`, `24 ↔ 600` mapping; non-standard densities go through `× 25.4` (lossy by ≤1.6% in the unusual case). |
