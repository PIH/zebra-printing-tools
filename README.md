# Client-side Zebra label printing

A self-contained Chrome page (`app/browser-print.html`) that prints
labels directly from the browser to any Zebra ZPL printer the Browser
Print helper can see, with no print dialog and no per-print user
interaction.
Resolution and label dimensions are auto-detected from whichever printer
the user picks — the page was developed against a GX430t but works
unchanged on any GX/ZD/ZT/etc.

Two operations on a single ZPL textarea:

1. **Print** — sends the textarea contents directly to the printer
   via `device.send`. Native ZPL primitives, sharpest result, smallest
   payload (~340 bytes for the demo label).
2. **Generate PDF** — POSTs the ZPL to the shim's `POST /zpl-to-pdf`
   endpoint (which shells out to the bundled `zpl2pdf` binary), gets a
   PDF back, displays it inline in an iframe. Useful for previewing
   labels without wasting media while iterating on the ZPL. The
   rendered PDF can then be printed via the helper's PDF→ZPL
   conversion, giving an apples-to-apples comparison with the direct
   primitive print.

Plus a skip-preview shortcut: pick any pre-made PDF and route it
straight through the helper's PDF→ZPL conversion to the printer
(useful for printing arbitrary PDFs from another system).

The page also includes a Diagnostics panel (preset Zebra commands plus
a free-form raw-command input with decoded + hex-dumped responses), so
it doubles as a setup / troubleshooting tool.

**Target printers:** any Zebra ZPL printer the Browser Print helper /
shim can see. Developed against a GX430t (300 dpi); should also work
on GX420t / ZD220 (203 dpi), ZD/ZT 600 dpi variants, etc.

**Client OSes:** Linux, Windows, macOS (see §3 Quickstart for setup
per OS).

**Browser:** Chrome.

---

## 1. What this is

The page exposes two main operations on a single ZPL textarea, plus a
skip-preview shortcut for arbitrary PDFs:

| Op | What | Source | Output to printer |
|---|---|---|---|
| 1 | **Print ZPL** | textarea | bytes from the textarea via `device.send`; native primitives rendered by the printer's firmware — sharpest, smallest payload (~340 bytes for the demo label) |
| 2 | **Generate PDF + Print this PDF** | textarea | `POST /zpl-to-pdf` → bundled `zpl2pdf` → PDF preview; then on print, the helper's PDF→ZPL conversion — typically 6–25 KB compressed ZPL |
| 3 | **Print uploaded PDF** (skip-preview shortcut) | file picker | helper's PDF→ZPL conversion only — typically 6–25 KB compressed ZPL |

On printer-select the page pre-fills the ZPL textarea with a default
template whose `^PW` (print width) and `^LL` (label length) specify
a 3"×2" demo label, sized to the detected DPI. Label dimensions are
configured by `^PW`/`^LL` in the ZPL itself — edit those lines in
the textarea for other media.

---

## 2. Where the shim is needed

The shim (`utils/browser-print-shim.py`) is purely a Browser Print API substitute. Whether you need it depends on platform and which features you want:

| Platform | For printing | For the *Generate PDF* preview |
|---|---|---|
| **Linux** | **Required** — Zebra doesn't currently distribute a Linux Browser Print build | **Required** (it's the same shim, plus the bundled `zpl2pdf` binary) |
| **Windows** | Not needed — use Zebra's official Browser Print helper | **Optional** — install the shim + `zpl2pdf` only if you want the live PDF preview |
| **macOS** | Not needed — use Zebra's official Browser Print helper | **Optional** — same as Windows |

If you only want to print labels on Windows or macOS, install Zebra's official helper (§4a) and skip the shim entirely. The page detects which helper is running and gracefully shows "PDF preview unavailable" when only the official helper is present (the *Print* button and *Print uploaded PDF* skip-preview shortcut still work).

---

## 3. Quickstart

**Linux** (Ubuntu / Debian / similar):

```bash
sudo apt install ghostscript                    # for PDF→ZPL conversion (existing pipeline)
sudo usermod -aG lp $USER && newgrp lp          # USB printer access (re-login if newgrp not available)
./utils/install-zpl2pdf.sh                      # bundled ZPL→PDF binary (~60 MB)
./utils/restart-shim.sh                         # starts the shim in foreground; Ctrl-C to stop
# in another terminal:
python3 -m http.server 8000 -d app
# open http://localhost:8000/browser-print.html in Chrome
```

(The shim ignores Zebra's PDF feature-key license check, so no key
setup is required on Linux.)

**Windows:**

```powershell
# 1. Install Zebra's Browser Print helper (one-time, GUI installer):
#    https://www.zebra.com/us/en/support-downloads/software/printer-software/browser-print.html
# 2. Drop a PDF feature key in app\feature-key.txt — required for PDF→ZPL
#    prints through Zebra's official helper (license check). See §4a for
#    where to obtain one. Direct ZPL prints work without this; you can
#    skip it if you only need that path. Example with a key extracted
#    from Zebra's public demo harness:
echo YOUR_KEY_HERE > app\feature-key.txt
# 3. (optional, only for Generate-PDF preview) install the shim and zpl2pdf.
#    PowerShell's default ExecutionPolicy blocks unsigned scripts; bypass it
#    for this one invocation, or set CurrentUser policy once (see §5 Windows):
powershell -ExecutionPolicy Bypass -File .\utils\install-zpl2pdf.ps1
python utils\browser-print-shim.py
# 4. Serve the page in another terminal:
python -m http.server 8000 -d app
# open http://localhost:8000/browser-print.html in Chrome
```

**macOS:**

```bash
# 1. Install Zebra's Browser Print helper (one-time, .pkg installer):
#    https://www.zebra.com/us/en/support-downloads/software/printer-software/browser-print.html
# 2. Drop a PDF feature key in app/feature-key.txt — required for PDF→ZPL
#    prints through Zebra's official helper (license check). See §4a for
#    where to obtain one. Direct ZPL prints work without this; skip if
#    that's all you need.
echo YOUR_KEY_HERE > app/feature-key.txt
# 3. (optional, only for Generate-PDF preview) install the shim and zpl2pdf:
brew install ghostscript                        # if not already installed
./utils/install-zpl2pdf.sh
./utils/restart-shim.sh
# 4. Serve the page in another terminal:
python3 -m http.server 8000 -d app
# open http://localhost:8000/browser-print.html in Chrome
```

The sections below cover what each piece does and the trade-offs when something goes wrong. If you just want to print, the quickstart above is sufficient.

---

## 4. Setup details

You need *something* listening on `http://127.0.0.1:9100/` that speaks the
Browser Print API. Two routes:

- **Production-style** — install Zebra's official Browser Print helper.
  Available for Windows and macOS. See §4a.
- **Linux dev / test** — run the small Python shim included in this repo
  (`utils/browser-print-shim.py`). Speaks the same API; the SDK doesn't
  know it's talking to a substitute. See §4b.

Once one of those is running, the rest is the same:

1. **Make sure the printer is reachable.** USB Zebra connected and powered
   on, or its IP listed in the helper's config.
2. **Serve the `app/` folder.** `127.0.0.1` is treated as a secure context
   in Chrome, so the SDK can reach the helper from `file://` too:
   ```
   python3 -m http.server 8000 -d app
   # → http://localhost:8000/browser-print.html
   ```
3. Open the page, pick your printer in the dropdown — the printer info
   card populates with detected dpi / model / firmware, and the ZPL
   textarea is pre-filled with the demo label sized to the detected DPI.
   Edit the textarea (e.g. `^PW`/`^LL` for non-3"×2" media), then click
   **Print** for direct ZPL or **Generate PDF** to preview. Watch the
   status pill after each print.

### 4a. Official Zebra Browser Print helper (Windows / macOS)

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

**PDF preview support.** The *Generate PDF* button in the page requires a `POST /zpl-to-pdf` endpoint that Zebra's official helper does NOT expose. If you want the live PDF preview on Windows or macOS, you have two options:

1. **Run the shim alongside the official helper.** The shim listens on the same port (9100) by default — pick one to keep enabled at a time, or run the shim on a different port and adjust the page's fetch URL. The shim's `POST /zpl-to-pdf` endpoint shells out to a bundled `zpl2pdf` binary; install it via `.\utils\install-zpl2pdf.ps1` on Windows or `./utils/install-zpl2pdf.sh` on macOS. See §4b for shim setup details.
2. **Skip the preview.** The *Print* button (direct ZPL) and the *Print uploaded PDF* skip-preview shortcut still work without the shim. The page detects this and shows "PDF preview unavailable" in the Generated PDF section instead of the iframe — graceful degradation, no errors.

If you don't need the preview at all, the official helper is sufficient.

#### PDF feature key

Zebra's official helper enforces a `featureKey` license check on
`device.convertAndSendFile` for PDF input — both the *Print this PDF*
button (under Generated PDF) and the *Print uploaded PDF* shortcut go
through this code path. **Without a key, both PDF print buttons fail
with a license error against the official helper.** Direct ZPL prints
are unaffected.

We do not bundle a key in this repo. To configure one, drop a one-line
file at `app/feature-key.txt` (gitignored, loaded by the page at
startup). There is no UI input; it's deployment config, not per-session
state.

**Where to obtain a key.** Zebra publishes a public demo key for
prototyping at <https://developer.zebra.com/content/browser-print-pdf>.
The same key also appears in plaintext in Zebra's public test harness
— view-source on
<https://cagdemo.com/BrowserPrint/test/external/zebra_test.html> and
look for the `feature_keys` JS variable. For production rollouts,
obtain a per-machine or per-fleet key directly from Zebra rather than
depending on the demo key (Zebra can rotate or revoke it).

**The shim ignores the key entirely** (no license check on its
`/convert` endpoint), so on Linux + shim, no key setup is required —
both PDF print buttons work without `app/feature-key.txt` existing.
The key only matters when the page is talking to Zebra's official
helper on Windows or macOS.

For an even cleaner path on supported printers, see PDF Direct in
[internals §5](docs/internals.md#5-pdf-direct-as-alternative-architecture)
— firmware-side PDF rendering, no `featureKey` required at all.

### 4b. The shim — `utils/browser-print-shim.py`

A minimal Python shim that mirrors the Browser Print HTTP API. The SDK in
the browser does not know it's talking to a substitute. **Two main use cases:**

1. **Linux primary helper.** Zebra doesn't ship a current Browser Print build for Linux, so the shim is the only practical way to drive a Zebra printer from this page on Ubuntu / Debian / etc.
2. **Windows / macOS PDF-preview helper.** The shim's `POST /zpl-to-pdf` endpoint (backed by the bundled `zpl2pdf` binary) doesn't exist in Zebra's official helper. Run the shim alongside or instead of Zebra's helper to get the live PDF preview on Win/Mac. (See §4a for trade-offs.)

```
python3 utils/browser-print-shim.py                                    # USB only
python3 utils/browser-print-shim.py --network 192.168.1.42             # one network printer
python3 utils/browser-print-shim.py --network 'Lab GX430t=10.0.0.5'    # named, default port
python3 utils/browser-print-shim.py --no-usb --network 192.168.1.42    # network only
```

Stdlib only — no `pip install` needed. CORS-allows everything (it's a dev
tool). Listens on `http://127.0.0.1:9100`. Pass `--https` to also bind
`https://127.0.0.1:9101` (auto-generates a self-signed cert via openssl on
first run, for testing pages that are themselves served HTTPS).

#### PDF preview support — install `zpl2pdf`

For the page's *Generate PDF* button (and the auto-fired preview on
printer-select) the shim shells out to a bundled `zpl2pdf` binary. To
install it once:

```
./utils/install-zpl2pdf.sh                 # Linux / macOS
.\utils\install-zpl2pdf.ps1                # Windows
```

The script downloads a pinned release from
[brunoleocam/ZPL2PDF](https://github.com/brunoleocam/ZPL2PDF/releases)
into `utils/bin/<platform>/`, verifies SHA256 against the release's
`SHA256SUMS.txt`, and is idempotent (re-runs are no-ops if already
installed). The shim auto-detects the binary on startup and advertises
`zpl: ["pdf"]` in its `/config.supportedConversions`. The page reads
that flag at startup and either enables the preview flow or shows
"PDF preview unavailable" in the Generated PDF section.

Without `zpl2pdf` installed, *Print* and the upload-PDF skip-preview
shortcut still work — only the live preview is unavailable.

There's also a small `utils/restart-shim.sh` helper in the repo that
pkills any running shim and re-launches it; useful during the iterative
dev cycle. Pass-through for `--network`, `--https`, etc.

```
./utils/restart-shim.sh                          # plain run
./utils/restart-shim.sh --network 192.168.1.42   # with a network printer
```

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
python3 utils/browser-print-shim.py --network 192.168.1.42
python3 utils/browser-print-shim.py --network 'Lab GX430t=192.168.1.42:9100' \
                                    --network 'Pharmacy GX430t=192.168.1.43'
```
or in a `utils/printers.json` next to the shim:
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

##### Auto-discovery via mDNS (Avahi)

If `avahi-browse` is on PATH (Linux: `sudo apt install avahi-utils` if it isn't), the shim auto-discovers Zebra printers advertising `_pdl-datastream._tcp` (port 9100, raw / JetDirect — the service Zebra printers use for ZPL printing) at startup and on each periodic rescan. Discovered printers appear in the dropdown alongside any registered via `--network` or `printers.json`. Pass `--no-mdns` to disable.

The page's **Refresh printer list** button POSTs to `/rediscover` on the shim, which re-runs the USB + mDNS scan synchronously — no shim restart needed when you plug in a new network printer.

(macOS doesn't ship `avahi-browse`; for now use explicit `--network` registrations on macOS. Windows users use Zebra's official helper which has its own discovery.)

By default the shim filters auto-discovered printers to Zebra ones only — entries whose service name + TXT records don't contain "zebra" (case-insensitive) are dropped. The HP / Brother / etc. printers on a typical mixed-printer LAN won't pollute the dropdown. Pass `--all-mdns-printers` to disable the filter (useful if you have a Zebra that for some reason doesn't advertise its make in mDNS — explicit `--network` registrations also bypass the filter and are always honored).

#### Finding a Zebra's IP

On Linux with Avahi installed, the shim auto-discovers Zebra printers advertising `_pdl-datastream._tcp` (see "Auto-discovery via mDNS" above) — you usually don't need to look up the IP manually. The hints below are for cases where mDNS isn't available (macOS without dns-sd plumbing, network segments where mDNS is filtered, or if you've passed `--no-mdns`).

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

For the technical detail of how the shim's PDF→ZPL conversion works internally, see [internals.md §8 Shim internals](docs/internals.md#8-shim-internals).

---

## 5. Per-platform notes

### Windows
- Browser Print talks through the **installed Zebra driver**. If a print job
  comes out as a multi-page text dump of your ZPL, the printer is
  configured as a "Generic / Text" or "Microsoft IPP" device — switch it to
  the Zebra-supplied driver so the bytes pass through unchanged.
- No driver swap is needed (this is the whole point of choosing Browser
  Print over WebUSB).
- USB and network printers both work.
- **PowerShell ExecutionPolicy.** The default policy on Windows blocks
  unsigned `.ps1` scripts (you'll see "cannot be loaded because running
  scripts is disabled on this system" when running `install-zpl2pdf.ps1`).
  Two ways past it:
  - **One-shot bypass** — no machine state change, works without admin:
    ```powershell
    powershell -ExecutionPolicy Bypass -File .\utils\install-zpl2pdf.ps1
    ```
  - **Permanent for your user** — set once, forget; still requires
    signatures on internet-downloaded scripts:
    ```powershell
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
    ```
  If the file was downloaded as a zip (rather than `git clone`d), Windows
  may also have tagged it as internet-sourced; `Unblock-File .\utils\install-zpl2pdf.ps1`
  clears that. The Quickstart in §3 uses the one-shot form so it works
  on a fresh install.
- **PDF preview** is not provided by Zebra's helper. To get the *Generate PDF* button working on Windows, install the shim's `zpl2pdf` binary via `.\utils\install-zpl2pdf.ps1` (see ExecutionPolicy note above) and run `python utils\browser-print-shim.py` alongside (or instead of) Zebra's helper. See §4a for trade-offs.

### macOS
- Generally just works. The printer can stay registered in CUPS — Browser
  Print uses it normally rather than fighting for exclusive USB access.
- **PDF preview** same caveat as Windows: Zebra's helper doesn't expose `POST /zpl-to-pdf`. Run the shim with `./utils/install-zpl2pdf.sh` + `python3 utils/browser-print-shim.py` if you want the preview. See §4a.

### Ubuntu / Linux
- No official Browser Print build on the main downloads page; we use
  `browser-print-shim.py` instead (§4b).
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

## 6. Files in this directory

```
app/                                ← everything served to the browser
  browser-print.html                ← the page (single ZPL textarea + always-visible PDF preview iframe + diagnostics)
  BrowserPrint-3.1.250.min.js       ← Zebra Browser Print JS SDK v3.1.250 — generic helper-API client
  BrowserPrint-Zebra-1.1.250.min.js ← Zebra Browser Print JS SDK v3.1.250 — Zebra device wrapper (status / config helpers)
                                      Both .min.js files are from Zebra's "Browser Print SDK v3.1.250" download
                                      (see §7 Further reading for the developer-site link, JSDoc reference, and
                                      sample app); we vendor them so the page works offline.
  feature-key.txt                   ← optional, gitignored: one-line PDF feature key (see §4a). Required for
                                      PDF→ZPL prints when the active helper is Zebra's official one (Windows/
                                      macOS); not needed when the shim is the active helper (it ignores the
                                      license check).
utils/                              ← server-side helpers (run by the user, not loaded in the browser)
  browser-print-shim.py             ← Linux dev shim (Browser Print API substitute) — supports USB and network transports;
                                      adds POST /zpl-to-pdf for ZPL→PDF preview when the bundled zpl2pdf is installed
  install-zpl2pdf.sh                ← POSIX (Linux/macOS) installer for the bundled zpl2pdf binary
  install-zpl2pdf.ps1               ← Windows installer for the bundled zpl2pdf binary
  restart-shim.sh                   ← dev helper: pkill + restart the shim in one step
  bin/                              ← installed zpl2pdf binaries (.gitignored, populated by install-zpl2pdf.{sh,ps1})
  printers.json                     ← optional: list of network printers for the shim
  shim-cert.pem, shim-key.pem       ← generated by `--https`; gitignore them
docs/internals.md                   ← implementation reference for future maintainers
docs/decision-log.md                ← design history and rationale (alternatives surveyed, decision log)
README.md                           ← this file
```

---

## 7. Further reading

### In this repo

- **[Internals](docs/internals.md)** — implementation reference for
  future maintainers: Browser Print architecture, ZPL primer,
  capability-detection mechanics, the implementation gotchas (zpl2pdf
  MediaBox bug, content-padding bug), and shim internals.
- **[Decision log](docs/decision-log.md)** — design history and
  rationale: alternatives we considered and why we rejected them, and
  a chronological log of design decisions made during development.

### Zebra's documentation

The page loads two `.min.js` files from `app/` at runtime (the Browser
Print JS SDK v3.1.250); for everything else (JSDoc reference, sample
code, newer SDK versions, Browser Print helper installers, the ZPL
programming guide, SGD command reference, PDF Direct enablement)
consult Zebra directly:

- **Browser Print helper download** (Windows / macOS) —
  <https://www.zebra.com/us/en/support-downloads/software/printer-software/browser-print.html>
- **Browser Print JS SDK reference (JSDoc + examples)** —
  <https://developer.zebra.com/zebra-browser-print-sdk-2>
  (the SDK download from this page includes the JSDoc HTML + sample
  app that we used to live in our `Documentation/` and `sample/`
  subdirs; download a fresh copy if you want them locally).
- **ZPL II Programming Guide** — the canonical reference for every
  ZPL command (`^XA`, `^FO`, `^A0N`, `^BC`, `^GFA`, etc.).
  Search "ZPL Programming Guide" on
  <https://www.zebra.com/us/en/support-downloads/knowledge-articles/>
  or download the PDF directly from
  <https://www.zebra.com/content/dam/zebra/manuals/printers/common/programming/zpl-zbi2-pm-en.pdf>.
- **Set / Get / Do (SGD) command reference** — for queries like
  `head.resolution.in_dpi` used in §8b detection logic. PDF: search
  "SGD Programming Guide" on the Zebra support site.
- **PDF Direct firmware option** — for printers that support it,
  ZPL→PDF conversion can be skipped entirely. See "Print PDFs
  Directly to a Zebra Link-OS Printer" on the Zebra knowledge base,
  or the discussion in [internals §5](docs/internals.md#5-pdf-direct-as-alternative-architecture).
- **Zebra Setup Utilities** — Windows GUI for printer configuration,
  driver install, and PDF Direct enablement —
  <https://www.zebra.com/us/en/support-downloads/printer-software/printer-setup-utilities.html>.

If a link rots (Zebra's site reorganizes occasionally), search
<https://www.zebra.com/us/en/support-downloads/> for the document
title.
