# ZPL textarea & PDF-preview redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-pathway form-driven page with a single ZPL textarea
plus a server-rendered PDF preview, eliminating in-browser PDF construction
(`pdf-lib` + `JsBarcode`) and giving us a useful ZPL → PDF tool as a side
effect.

**Architecture:** A new shim endpoint `POST /zpl-to-pdf` shells out to a
bundled `zpl2pdf` binary (installed via `install-zpl2pdf.sh`, not vendored).
The page reads `/config.supportedConversions.zpl` at startup to decide
whether to enable the auto-fire preview flow or show an unavailability
message. Pathway-1 print logic now reads from a freely-edited textarea
instead of form fields; the upload-PDF pathway is re-framed as a
skip-preview shortcut.

**Tech stack:**
- `browser-print.html` — vanilla JS, no framework, talks to Browser Print
  helper / shim via Zebra SDK. Chrome's built-in PDF viewer renders the
  preview iframe.
- `browser-print-shim.py` — stdlib HTTP server. New endpoint shells out via
  `subprocess.run` to a bundled binary.
- `zpl2pdf` v3.1.1 — C# / .NET 9 self-contained, MIT licensed,
  `BinaryKits.Zpl` renderer.
- No automated test framework in repo. Verification is by `curl` (shim) +
  manual browser smoke test (page).

**Reference spec:** `docs/superpowers/specs/2026-05-06-zpl-textarea-and-pdf-preview-redesign.md`

---

## Files touched

**Created:**
- `install-zpl2pdf.sh` — POSIX installer (Linux + macOS).
- `install-zpl2pdf.ps1` — Windows installer.
- `bin/.gitkeep` — placeholder so the directory exists in fresh clones.

**Modified:**
- `.gitignore` — ignore `/bin/*/zpl2pdf*` and friends.
- `browser-print-shim.py` — add `_have_zpl2pdf()` helper, extend
  `handle_config`, add `handle_zpl_to_pdf` + routing, add startup hint.
- `browser-print.html` — major surgery (HTML + JS rewrite).
- `README.md` — rewrite affected sections per spec §10.

**Deleted:**
- `pdf-lib.min.js` (vendored, ~525 KB).

---

## Task ordering rationale

Foundation → installer → shim → page → cleanup → docs.

The shim changes are independently testable with `curl` (no page changes
required). Once those land, the page rewrite has a working backend to
target. Cleanup (deleting `pdf-lib.min.js`) and README come last because
they only make sense after the page is in its final shape.

---

### Task 1: Foundation — `bin/` directory and `.gitignore` entry

**Files:**
- Create: `bin/.gitkeep`
- Modify: `.gitignore`

- [ ] **Step 1: Read existing `.gitignore`**

Run: `cat .gitignore`
Expected: contains `shim-cert.pem` and `shim-key.pem` already.

- [ ] **Step 2: Append `bin/` ignore rules**

Edit `.gitignore` — append at the end:

```
# zpl2pdf binaries (installed via install-zpl2pdf.sh; not committed)
/bin/*/
!/bin/.gitkeep
```

The `!/bin/.gitkeep` re-includes the placeholder so the directory itself is
tracked.

- [ ] **Step 3: Create the placeholder file**

Run: `mkdir -p bin && touch bin/.gitkeep`

- [ ] **Step 4: Verify the rules work**

Run: `mkdir -p bin/test-platform && touch bin/test-platform/zpl2pdf && git status`
Expected: `bin/test-platform/zpl2pdf` does NOT appear in untracked files;
only `bin/.gitkeep` and the modified `.gitignore` show up.
Cleanup: `rm -rf bin/test-platform`

- [ ] **Step 5: Commit**

```bash
git add .gitignore bin/.gitkeep
git commit -m "Add bin/ directory and gitignore zpl2pdf binaries"
```

---

### Task 2: POSIX installer — `install-zpl2pdf.sh`

**Files:**
- Create: `install-zpl2pdf.sh`

The script detects platform/arch, downloads the matching tarball from a
pinned `zpl2pdf` GitHub release, verifies SHA256 against the release's
`checksums.txt`, extracts to `bin/<platform>/`, and chmod +x's the binary.

- [ ] **Step 1: Inspect a real release tarball to confirm the layout**

Goal: figure out whether the tarball extracts as a flat binary or a
directory tree, and what the executable file is actually named.

Run:
```bash
mkdir -p /tmp/zpl2pdf-probe && cd /tmp/zpl2pdf-probe
curl -fsSL -o probe.tar.gz \
  https://github.com/brunoleocam/zpl2pdf/releases/download/v3.1.1/ZPL2PDF-v3.1.1-linux-x64.tar.gz
tar tzf probe.tar.gz | head -30
```
Expected output: the executable will most likely be named `ZPL2PDF`
(capitalised); take note of the directory prefix (probably
`ZPL2PDF-v3.1.1-linux-x64/`).

If the asset URL 404s, list the release's actual asset names:
```bash
curl -fsSL https://api.github.com/repos/brunoleocam/zpl2pdf/releases/tags/v3.1.1 \
  | grep -oE '"browser_download_url":"[^"]+"'
```
Update the URL pattern in step 2 to match the real asset names.

- [ ] **Step 2: Write the installer script**

Create `install-zpl2pdf.sh` with the following content. Adjust the
`ASSET_BASENAME` template if step 1 revealed a different naming pattern.

```bash
#!/usr/bin/env bash
# Install zpl2pdf into bin/<platform>/ for use by browser-print-shim.py.
# Pinned to a specific release for reproducibility. Idempotent.

set -euo pipefail

VERSION="v3.1.1"
REPO="brunoleocam/zpl2pdf"
HERE="$(cd "$(dirname "$0")" && pwd)"

# Detect platform/arch.
case "$(uname -s)" in
  Linux)   OS="linux" ;;
  Darwin)  OS="osx" ;;
  *) echo "Unsupported OS: $(uname -s). Use install-zpl2pdf.ps1 on Windows." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
PLATFORM="${OS}-${ARCH}"
DEST="${HERE}/bin/${PLATFORM}"

# Skip if already installed.
if [[ -x "${DEST}/zpl2pdf" ]]; then
  echo "zpl2pdf already installed at ${DEST}/zpl2pdf"
  "${DEST}/zpl2pdf" --version 2>/dev/null || true
  exit 0
fi

ASSET="ZPL2PDF-${VERSION}-${PLATFORM}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
CHECKSUMS_URL="https://github.com/${REPO}/releases/download/${VERSION}/checksums.txt"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "Downloading ${ASSET}…"
curl -fsSL -o "${TMP}/${ASSET}" "${URL}"

echo "Fetching checksums.txt…"
if curl -fsSL -o "${TMP}/checksums.txt" "${CHECKSUMS_URL}"; then
  EXPECTED="$(grep -E "[[:space:]]${ASSET}\$" "${TMP}/checksums.txt" | awk '{print $1}' || true)"
  if [[ -n "${EXPECTED}" ]]; then
    echo "Verifying SHA256…"
    ACTUAL="$(sha256sum "${TMP}/${ASSET}" | awk '{print $1}')"
    if [[ "${EXPECTED}" != "${ACTUAL}" ]]; then
      echo "SHA256 mismatch! expected=${EXPECTED} actual=${ACTUAL}" >&2
      exit 1
    fi
    echo "  OK"
  else
    echo "Warning: ${ASSET} not listed in checksums.txt — skipping verification."
  fi
else
  echo "Warning: checksums.txt not available — skipping verification."
fi

echo "Extracting to ${DEST}/…"
mkdir -p "${DEST}"
# --strip-components=1 in case the tarball wraps everything in a single
# top-level dir like "ZPL2PDF-v3.1.1-linux-x64/". If the tarball is flat,
# tar will error and we retry without it.
if ! tar -xzf "${TMP}/${ASSET}" -C "${DEST}" --strip-components=1 2>/dev/null; then
  tar -xzf "${TMP}/${ASSET}" -C "${DEST}"
fi

# The released binary is named ZPL2PDF on most platforms; symlink to lower
# case so the shim's invocation is consistent across platforms.
if [[ -f "${DEST}/ZPL2PDF" && ! -e "${DEST}/zpl2pdf" ]]; then
  ln -s ZPL2PDF "${DEST}/zpl2pdf"
fi
chmod +x "${DEST}/zpl2pdf" "${DEST}/ZPL2PDF" 2>/dev/null || true

echo "Installed:"
"${DEST}/zpl2pdf" --version || echo "  (binary present at ${DEST}/zpl2pdf)"
```

- [ ] **Step 3: chmod +x and run it**

```bash
chmod +x install-zpl2pdf.sh
./install-zpl2pdf.sh
```

Expected: download progress, "Installed: zpl2pdf X.Y.Z" or similar.

- [ ] **Step 4: Smoke-test the installed binary**

Run:
```bash
echo '^XA^FO50,50^A0N,40,40^FDhello^FS^XZ' > /tmp/hello.zpl
./bin/linux-x64/zpl2pdf -i /tmp/hello.zpl --stdout -d 203 > /tmp/hello.pdf
file /tmp/hello.pdf
```
Expected: `/tmp/hello.pdf: PDF document, version 1.X, …`

If the binary path uses a different platform name (e.g. `linux-arm64`),
adjust accordingly. If `-d 203` fails, check `./bin/linux-x64/zpl2pdf
--help` for the exact flag name.

- [ ] **Step 5: Verify `bin/linux-x64/` contents are gitignored**

Run: `git status`
Expected: `install-zpl2pdf.sh` shows up; `bin/linux-x64/` does NOT.

- [ ] **Step 6: Commit**

```bash
git add install-zpl2pdf.sh
git commit -m "Add install-zpl2pdf.sh — POSIX installer for the bundled ZPL→PDF binary"
```

---

### Task 3: Windows installer — `install-zpl2pdf.ps1`

**Files:**
- Create: `install-zpl2pdf.ps1`

A parallel PowerShell script for Windows. Not run-tested in this session
(no Windows machine in the loop); validate when a Windows user picks it up.

- [ ] **Step 1: Write the script**

Create `install-zpl2pdf.ps1`:

```powershell
# Install zpl2pdf into bin\win-x64\ for use by browser-print-shim.py.
# Pinned to a specific release for reproducibility. Idempotent.

$ErrorActionPreference = 'Stop'
$Version = 'v3.1.1'
$Repo = 'brunoleocam/zpl2pdf'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

$Platform = 'win-x64'  # only supported Windows arch in zpl2pdf releases
$Dest = Join-Path $Here "bin\$Platform"
$Exe = Join-Path $Dest 'zpl2pdf.exe'

if (Test-Path $Exe) {
    Write-Host "zpl2pdf already installed at $Exe"
    & $Exe --version 2>$null
    exit 0
}

$Asset = "ZPL2PDF-$Version-$Platform.zip"
$Url = "https://github.com/$Repo/releases/download/$Version/$Asset"
$ChecksumsUrl = "https://github.com/$Repo/releases/download/$Version/checksums.txt"

$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
try {
    $AssetPath = Join-Path $Tmp $Asset
    Write-Host "Downloading $Asset…"
    Invoke-WebRequest -Uri $Url -OutFile $AssetPath -UseBasicParsing

    Write-Host "Fetching checksums.txt…"
    $ChecksumsPath = Join-Path $Tmp 'checksums.txt'
    try {
        Invoke-WebRequest -Uri $ChecksumsUrl -OutFile $ChecksumsPath -UseBasicParsing
        $Line = Get-Content $ChecksumsPath | Where-Object { $_ -match "\s$([regex]::Escape($Asset))$" }
        if ($Line) {
            $Expected = ($Line -split '\s+')[0]
            $Actual = (Get-FileHash -Algorithm SHA256 $AssetPath).Hash.ToLower()
            if ($Expected.ToLower() -ne $Actual) {
                throw "SHA256 mismatch! expected=$Expected actual=$Actual"
            }
            Write-Host "  SHA256 OK"
        } else {
            Write-Warning "$Asset not listed in checksums.txt — skipping verification."
        }
    } catch [System.Net.WebException] {
        Write-Warning 'checksums.txt not available — skipping verification.'
    }

    Write-Host "Extracting to $Dest\…"
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    Expand-Archive -Path $AssetPath -DestinationPath $Dest -Force

    # If the zip wraps everything in a top-level dir, flatten it.
    $TopDirs = Get-ChildItem $Dest -Directory
    if ($TopDirs.Count -eq 1 -and -not (Test-Path $Exe)) {
        Get-ChildItem $TopDirs[0].FullName -Force | Move-Item -Destination $Dest -Force
        Remove-Item $TopDirs[0].FullName -Recurse -Force
    }

    Write-Host 'Installed:'
    & $Exe --version
} finally {
    Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
```

- [ ] **Step 2: Lint the syntax (optional, on Linux)**

Run: `pwsh -NoProfile -Command "& { . ./install-zpl2pdf.ps1 } -WhatIf 2>&1 || true"`
(Skip if `pwsh` isn't installed; this is just a syntax check.)

- [ ] **Step 3: Commit**

```bash
git add install-zpl2pdf.ps1
git commit -m "Add install-zpl2pdf.ps1 — Windows installer for the bundled ZPL→PDF binary"
```

---

### Task 4: Shim — `_have_zpl2pdf()` helper + `/config` advertising

**Files:**
- Modify: `browser-print-shim.py`

- [ ] **Step 1: Read the shim's existing structure**

Read `browser-print-shim.py:466-475` (the `_have_ghostscript()` helper) and
`browser-print-shim.py:790-805` (the `handle_config` method). The new helper
follows the same shape; the config method gets one extra branch.

- [ ] **Step 2: Add `_have_zpl2pdf()` helper**

Below the existing `_have_ghostscript()` function (around line 475 — locate
it via `grep -n "_have_ghostscript" browser-print-shim.py`), add a sibling
helper:

```python
def _zpl2pdf_path():
    """Return the path to the bundled zpl2pdf binary for this platform, or
    None if it isn't installed. Layout matches install-zpl2pdf.sh:
    bin/<os>-<arch>/zpl2pdf[.exe].
    """
    import platform as _pl
    here = os.path.dirname(os.path.abspath(__file__))
    osname = {'Linux': 'linux', 'Darwin': 'osx', 'Windows': 'win'}.get(_pl.system())
    if not osname:
        return None
    arch = {'x86_64': 'x64', 'amd64': 'x64', 'AMD64': 'x64',
            'arm64': 'arm64', 'aarch64': 'arm64'}.get(_pl.machine())
    if not arch:
        return None
    binname = 'zpl2pdf.exe' if osname == 'win' else 'zpl2pdf'
    candidate = os.path.join(here, 'bin', f'{osname}-{arch}', binname)
    return candidate if os.path.isfile(candidate) and os.access(candidate, os.X_OK) else None


def _have_zpl2pdf():
    return _zpl2pdf_path() is not None
```

If `os` isn't already imported at the top of the file, verify it (it
should be — search `^import os` near the top).

- [ ] **Step 3: Extend `handle_config` to advertise both directions**

Locate `handle_config` (around `browser-print-shim.py:790`). Replace its
body with:

```python
    def handle_config(self):
        # Advertise PDF→ZPL conversion if Ghostscript is available, and
        # ZPL→PDF if zpl2pdf is bundled in bin/. api_level 4 is what the
        # SDK requires for any /convert endpoint to be considered.
        conv = {}
        if _have_ghostscript():
            conv['pdf'] = ['zpl']
        if _have_zpl2pdf():
            conv['zpl'] = ['pdf']
        api = 4 if conv else 2
        return self._send_json(200, {
            'version': SHIM_VERSION,
            'build_number': 0,
            'api_level': api,
            'platform': 'linux',
            'supportedConversions': conv,
        })
```

- [ ] **Step 4: Smoke-test with curl**

In one terminal: `python3 browser-print-shim.py`

In another:
```bash
curl -s http://127.0.0.1:9100/config | python3 -m json.tool
```
Expected (with `bin/linux-x64/zpl2pdf` present):
```json
{
    "version": "...",
    "build_number": 0,
    "api_level": 4,
    "platform": "linux",
    "supportedConversions": {
        "pdf": ["zpl"],
        "zpl": ["pdf"]
    }
}
```

If the binary isn't present, `supportedConversions.zpl` is absent. To
verify that branch: `mv bin/linux-x64/zpl2pdf bin/linux-x64/_zpl2pdf` →
restart shim → curl again → confirm only `pdf: ["zpl"]` is advertised →
restore: `mv bin/linux-x64/_zpl2pdf bin/linux-x64/zpl2pdf`.

- [ ] **Step 5: Commit**

```bash
git add browser-print-shim.py
git commit -m "Shim: advertise zpl→pdf conversion in /config when zpl2pdf is installed"
```

---

### Task 5: Shim — `POST /zpl-to-pdf` endpoint

**Files:**
- Modify: `browser-print-shim.py`

- [ ] **Step 1: Add the handler method**

Locate `handle_convert` (around `browser-print-shim.py:858`) and add a new
sibling method directly below it (before the closing of the `Handler`
class). Insert:

```python
    def handle_zpl_to_pdf(self):
        """POST /zpl-to-pdf
        Body: raw ZPL bytes (Content-Type: text/plain).
        Query: ?dpi=<int> — print density in dots per inch (default 203).
        Response: 200 application/pdf with the rendered PDF bytes.
                  503 text/plain if zpl2pdf isn't installed.
                  4xx text/plain with stderr if conversion fails.
        Shells out to the bundled binary; ZPL goes via a temp file (not -z
        argv) because ^GFA blocks at 600 dpi can blow past Windows' 32 KB
        argv limit.
        """
        binpath = _zpl2pdf_path()
        if binpath is None:
            return self._send(503,
                'zpl2pdf not installed; run ./install-zpl2pdf.sh '
                'to enable the ZPL → PDF preview endpoint.')

        zpl_bytes = self._read_body()
        if not zpl_bytes:
            return self._send(400, 'Empty body; expected raw ZPL.')

        try:
            dpi = int((parse_qs(urlparse(self.path).query).get('dpi') or ['203'])[0])
        except ValueError:
            return self._send(400, "Bad 'dpi' query param; expected an integer.")

        # Temp file rather than -z argv (Windows argv is capped at 32 KB).
        # delete=False because Windows can't reopen an open NamedTemporaryFile.
        tmp = tempfile.NamedTemporaryFile(prefix='zpl-', suffix='.zpl', delete=False)
        try:
            tmp.write(zpl_bytes)
            tmp.flush()
            tmp.close()
            t0 = time.monotonic()
            proc = subprocess.run(
                [binpath, '-i', tmp.name, '--stdout', '-d', str(dpi)],
                capture_output=True, timeout=30,
            )
            dt_ms = (time.monotonic() - t0) * 1000.0
            if proc.returncode != 0:
                stderr = proc.stderr.decode('utf-8', errors='replace')[:2048]
                log.warning('zpl2pdf failed (rc=%d): %s', proc.returncode, stderr.strip())
                return self._send(400, stderr or f'zpl2pdf exited with code {proc.returncode}')
            log.info('zpl-to-pdf: %d bytes ZPL @ %d dpi → %d bytes PDF in %.0f ms',
                     len(zpl_bytes), dpi, len(proc.stdout), dt_ms)
            return self._send(200, proc.stdout, 'application/pdf')
        except subprocess.TimeoutExpired:
            return self._send(500, 'zpl2pdf timed out (>30 s)')
        except Exception as e:
            log.exception('zpl-to-pdf failed')
            return self._send(500, f'zpl-to-pdf failed: {e}')
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass
```

- [ ] **Step 2: Confirm `tempfile` and `subprocess` are imported**

Run: `grep -n "^import \(tempfile\|subprocess\)" browser-print-shim.py`
Expected: both present (subprocess is used by the existing Ghostscript
pipeline; tempfile may need adding). If `tempfile` is missing, add
`import tempfile` near the top with the other imports.

- [ ] **Step 3: Wire the route**

Locate `do_POST` (around `browser-print-shim.py:781`) and add the new
route. Replace:

```python
    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/write':        return self.handle_write()
        if path == '/read':         return self.handle_read()
        if path == '/convert':      return self.handle_convert()
        return self._send(404, 'Not found')
```

with:

```python
    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/write':        return self.handle_write()
        if path == '/read':         return self.handle_read()
        if path == '/convert':      return self.handle_convert()
        if path == '/zpl-to-pdf':   return self.handle_zpl_to_pdf()
        return self._send(404, 'Not found')
```

- [ ] **Step 4: Smoke-test the success path**

Restart shim. Then:
```bash
curl -sSf -X POST -H 'Content-Type: text/plain' \
  --data-binary $'^XA^FO50,50^A0N,40,40^FDhello world^FS^XZ' \
  'http://127.0.0.1:9100/zpl-to-pdf?dpi=203' \
  > /tmp/preview.pdf
file /tmp/preview.pdf
```
Expected: `/tmp/preview.pdf: PDF document, version 1.X, …`

Open with `xdg-open /tmp/preview.pdf` and visually confirm "hello world"
appears. The shim log should show one
`zpl-to-pdf: <N> bytes ZPL @ 203 dpi → <M> bytes PDF in <ms> ms` line.

- [ ] **Step 5: Smoke-test the failure paths**

Bad ZPL:
```bash
curl -s -X POST -H 'Content-Type: text/plain' \
  --data-binary 'totally invalid' \
  http://127.0.0.1:9100/zpl-to-pdf -o /tmp/err.txt -w '%{http_code}\n'
cat /tmp/err.txt
```
Expected: 4xx (400) with stderr text in the body. (zpl2pdf may actually
succeed with garbage input — note the actual behaviour and only treat
non-zero return codes as failures.)

Empty body:
```bash
curl -s -X POST http://127.0.0.1:9100/zpl-to-pdf -w '%{http_code}\n'
```
Expected: `400` and "Empty body; expected raw ZPL."

Missing binary (verify the 503 branch by temporarily renaming the binary,
re-running curl, then renaming back):
```bash
mv bin/linux-x64/zpl2pdf bin/linux-x64/_off
# kill and restart shim
curl -sS -X POST --data-binary '^XA^XZ' http://127.0.0.1:9100/zpl-to-pdf -w '\n%{http_code}\n'
# expect: zpl2pdf not installed; run ./install-zpl2pdf.sh ...
#         503
mv bin/linux-x64/_off bin/linux-x64/zpl2pdf
```

- [ ] **Step 6: Commit**

```bash
git add browser-print-shim.py
git commit -m "Shim: add POST /zpl-to-pdf endpoint backed by bundled zpl2pdf"
```

---

### Task 6: Shim — startup hint when binary missing

**Files:**
- Modify: `browser-print-shim.py`

- [ ] **Step 1: Find the existing Ghostscript startup hint**

Run: `grep -n "Ghostscript\|sudo apt install ghostscript" browser-print-shim.py`
Expected: a block around line ~1043–1048 that warns when Ghostscript is
missing.

- [ ] **Step 2: Add a parallel zpl2pdf hint**

Just below the Ghostscript hint block (find it via the grep above), add:

```python
    if _have_zpl2pdf():
        log.info('zpl2pdf %s found — POST /zpl-to-pdf is enabled.',
                 _zpl2pdf_path())
    else:
        log.warning('zpl2pdf not found in bin/<platform>/ — run '
                    './install-zpl2pdf.sh to enable the ZPL → PDF '
                    'preview endpoint.')
```

The exact insertion site depends on the surrounding code — match the
indentation of the existing Ghostscript block.

- [ ] **Step 3: Verify both branches**

Restart shim, look for the new info / warning line in the startup output:

With binary present:
```
INFO zpl2pdf /…/bin/linux-x64/zpl2pdf found — POST /zpl-to-pdf is enabled.
```

With binary absent (temp rename as in Task 5 step 5):
```
WARNING zpl2pdf not found in bin/<platform>/ — run ./install-zpl2pdf.sh to enable the ZPL → PDF preview endpoint.
```

- [ ] **Step 4: Commit**

```bash
git add browser-print-shim.py
git commit -m "Shim: log a startup hint when zpl2pdf is installed/missing"
```

---

### Task 7: Page rewrite — HTML structure + JS lifecycle

**Files:**
- Modify: `browser-print.html`

This is the biggest task. The page is rewritten in a single commit because
the new JS references new HTML IDs; an intermediate state would be broken.
Steps 1–8 modify the file; step 9 is a manual smoke test before committing.

The new structure (per spec §4.2):

```
Title / blurb
─────────────────────────
Printer (unchanged)
─────────────────────────
ZPL                                    ← new
  help text
  <textarea id="zpl">                  default content
  [ Print ] [ Generate PDF ]
  ↺ Reset to default
─────────────────────────
Generated PDF (always visible)         ← new
  <iframe id="pdfPreview">  (or message box for unavailability/dirty/error)
  [ Print this PDF ]   ⬇ Download
─────────────────────────
Print uploaded PDF (re-framed)         ← reworded; same plumbing
─────────────────────────
Diagnostics (unchanged)
```

The default ZPL written into the textarea matches what `buildDirectZpl`
produces today.

- [ ] **Step 1: Remove vendored library script tags**

Open `browser-print.html`. Find the script-tag block (around line 274–278):

```html
<script src="zebra-browser-print-js-v31250/BrowserPrint-3.1.250.min.js"></script>
<script src="zebra-browser-print-js-v31250/BrowserPrint-Zebra-1.1.250.min.js"></script>
<script src="pdf-lib.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js"></script>
```

Replace with (`pdf-lib` and `JsBarcode` removed):

```html
<script src="zebra-browser-print-js-v31250/BrowserPrint-3.1.250.min.js"></script>
<script src="zebra-browser-print-js-v31250/BrowserPrint-Zebra-1.1.250.min.js"></script>
```

- [ ] **Step 2: Replace the "Label geometry" + "Label content" sections**

Find the two `<section>` blocks at lines 105–136 (Label geometry) and the
inline "Label content" (lines 130–135 inside the same section). Delete
both (the entire `<section>` containing `Label geometry` and `Label
content`).

These are gone in the new design. There is no replacement section — their
role is absorbed into the new ZPL textarea (Step 4).

- [ ] **Step 3: Replace the "Generated PDF (used by pathway 2)" section**

Find the block starting `<h2>Generated PDF (used by pathway 2)</h2>` (around
line 140). Delete that entire `<section>`. It will be re-added in Step 5
with new content and positioning.

- [ ] **Step 4: Replace pathway 1 with the new ZPL section**

Find the `<!-- ============================================================ Pathway 1 -->`
comment and its `<section class="pathway">` (around lines 148–162).
Replace the entire section with:

```html
<!-- ============================================================ ZPL -->
<section class="pathway">
  <h2>ZPL</h2>
  <p>
    This is the ZPL that will be sent to the printer. The default below is
    populated from the selected printer's detected dimensions; edit
    <code>^PW</code> (print width, in dots) and <code>^LL</code> (label
    length, in dots) to match your loaded media if they differ. Anything
    else can be edited freely — pre-generated ZPL from the OpenMRS module
    or another system can be pasted here directly.
  </p>
  <textarea id="zpl" rows="14" spellcheck="false"
            style="font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.92em"></textarea>
  <div class="row" style="margin-top: 0.5em">
    <button id="printZpl" disabled>Print →</button>
    <button id="generatePdf" disabled>Generate PDF</button>
    <a href="#" id="resetZpl" class="muted" style="font-size: 0.92em; margin-left: 0.5em">↺ Reset to default</a>
    <span id="zplStatus" class="muted"></span>
  </div>
</section>
```

- [ ] **Step 5: Replace pathway 2 with the always-visible Generated PDF section**

Find the `<!-- ============================================================ Pathway 2 -->`
block and its `<section class="pathway">` (lines 164–190). Replace with:

```html
<!-- ============================================================ Generated PDF -->
<section class="pathway">
  <h2>Generated PDF</h2>
  <p>
    Rendered server-side by <code>zpl2pdf</code> via the shim's
    <code>POST /zpl-to-pdf</code> endpoint. Updates whenever you click
    <b>Generate PDF</b> above (auto-fired once on printer-select). Useful
    for previewing labels without wasting media while iterating on the
    ZPL.
  </p>
  <div id="pdfPreviewWrap">
    <iframe id="pdfPreview" class="pdf-preview" title="PDF preview"
            style="width: 100%; min-height: 400px; border: 1px solid #ddd"></iframe>
    <div id="pdfMessage" class="muted" style="display: none; padding: 1em; border: 1px dashed #ccc"></div>
  </div>
  <div class="row" style="margin-top: 0.5em">
    <button id="printPdf" disabled>Print this PDF →</button>
    <a href="#" id="downloadPdf" download="label.pdf" style="margin-left: 0.5em">⬇ Download</a>
    <span id="pdfStatus" class="muted"></span>
  </div>
</section>
```

The feature-key input (used by pathway 2 for Zebra's official helper)
moves into the upload-PDF section in Step 7 (it's still relevant when
the page is talking to Zebra's helper instead of the shim, since both
preview-print and upload-print go through `convertAndSendFile`).

- [ ] **Step 6: Delete the standalone "Print custom ZPL" section**

Find `<!-- ============================================================ Custom ZPL -->`
(around lines 192–207). Delete the entire `<section>`. Its purpose is
absorbed into the new ZPL textarea.

- [ ] **Step 7: Re-frame the upload-PDF section**

Find `<!-- ============================================================ Upload PDF -->`
(around lines 209–226). Replace the `<h2>` and `<p>` with:

```html
<!-- ============================================================ Upload PDF -->
<section class="pathway">
  <h2>Print uploaded PDF</h2>
  <p>
    If you already have a PDF, skip the preview and print it directly via
    the helper conversion (<code>Zebra.Printer.getConvertedResource</code>).
    Same conversion pipeline that the Generated PDF section uses to print
    the ZPL→PDF round-trip.
  </p>
  <div class="row">
    <label>PDF feature key:
      <input id="featureKey" type="password" size="40"
             placeholder="paste Zebra PDF conversion license key (ignored by the shim)">
    </label>
    <label><input id="rememberKey" type="checkbox"> remember in localStorage</label>
  </div>
  <div class="row" style="margin-top: 0.5em">
    <input type="file" id="customPdfFile" accept="application/pdf,.pdf">
    <span id="customPdfInfo" class="muted"></span>
  </div>
  <div class="row" style="margin-top: 0.5em">
    <button id="printCustomPdf" disabled>Print uploaded PDF →</button>
    <span id="customPdfStatus" class="muted"></span>
  </div>
</section>
```

(The feature-key input is moved here from the now-gone pathway 2 — it
gates `convertAndSendFile` against Zebra's official helper. The shim
ignores it; on Linux dev nothing changes.)

- [ ] **Step 8: Rewrite the page header blurb**

Find the top-of-page `<h1>` and the introductory paragraph (lines 50–70
roughly — search `Four print pathways`). Replace the introductory text
(the explanation block, not the `<h1>` itself) with:

```html
<p>
  Print labels directly from the browser to any Zebra ZPL printer the
  Browser Print helper can see, with no print dialog and no per-print
  user interaction. Two operations on the same ZPL textarea: <b>Print
  the ZPL directly</b> (vector primitives rendered by the printer
  firmware — sharpest, smallest payload) or <b>Generate a PDF preview</b>
  via the shim's <code>zpl2pdf</code> endpoint, then print the rasterised
  result via the helper's PDF→ZPL conversion. The PDF preview is also
  useful as a layout sanity-check before printing — saves wasted labels
  while iterating on formatting. There's also a skip-preview shortcut
  for printing existing PDFs (e.g. server-generated from another
  system).
</p>
```

- [ ] **Step 9: Replace the JS state declarations**

Find the State block (around lines 311–319):

```javascript
let device = null;          // BrowserPrint.Device
let zebra  = null;          // Zebra.Printer wrapper
let allDevices = [];
let lastPdfBytes = null;    // Uint8Array — PDF for pathway 2
let lastPdfUrl   = null;    // Object URL for the iframe
```

Replace with:

```javascript
let device = null;          // BrowserPrint.Device
let zebra  = null;          // Zebra.Printer wrapper
let allDevices = [];
let lastPdfBytes = null;    // Uint8Array — last successful /zpl-to-pdf result
let lastPdfUrl   = null;    // blob: URL backing the iframe + Download link
let lastDetected = null;    // {dpi, dpm, widthDots, heightDots, model, …}
let pdfPreviewSupported = false;   // from /config supportedConversions.zpl
let zplDirty = false;       // textarea edited since last successful Generate
let defaultZplSnapshot = '';// most recent default written into the textarea
```

- [ ] **Step 10: Remove all the unit-toggle / form-input JS**

Find and delete (or comment with `// REMOVED:` for review-then-delete) the
following functions and their event hookups. Use `grep -n "<NAME>" browser-print.html`
for each to locate:

- `userOverrodeUnit` (declaration + writes)
- `dpmToDpi`, `dpiToDpm` (helper conversions used only by toggle)
- `unit()` (reads `#unit` which no longer exists)
- `syncDensityFromInput`
- `valueToDots`, `dotsToValue`
- `valueToInches`, `formatDisplayValue`, `formatDensityValue`
- `applyUnitToInputs`
- `switchUnit`
- `maybeAutoSwitchUnitToMm`
- `parseDensity`, `parseSgdValue` — **keep** these; printer detection still uses them
- The standalone `applyUnitToInputs()` call near line 664
- Any event listeners on `#unit`, `#density`, `#labelW`, `#labelH`,
  `#title`, `#body`, `#value`, `#zplDirect` and the
  `#zplDirectSize` updater

After this step, the file should still parse — open it in a browser to
verify (a console error like "Cannot read property of null" for
`#unit` etc. would mean a stray reference). If found, fix.

- [ ] **Step 11: Simplify `buildDirectZpl` → `defaultZpl`**

Find `function buildDirectZpl(` (around line 1088). Replace the entire
function with:

```javascript
// Default ZPL written into the textarea on printer-select. Header / body /
// barcode are now hard-coded — the previous form inputs are gone. Same
// content the page emitted before; only widthDots / heightDots vary, from
// detection. Whoever wants different content edits the textarea directly.
function defaultZpl({ widthDots, heightDots }) {
  return [
    '^XA',
    '^CI28',
    `^PW${widthDots}`,
    `^LL${heightDots}`,
    '^LH0,0',
    '^FO50,50^A0N,58,58^FDOpenMRS Test Label^FS',
    '^FO50,130^A0N,46,46^FDID: A456123^FS',
    '^BY6,2,200',
    '^FO50,310^BCN,200,Y,N,N^FDA456123^FS',
    '^XZ',
  ].join('\n');
}
```

Find every caller of `buildDirectZpl` (likely just `regenerateDirect` and
`printDirectZpl` actions) and update them to call `defaultZpl` with only
`{widthDots, heightDots}`.

- [ ] **Step 12: Remove `buildPdf`, `regenerateDirect`, `convertViaHelper`, and the old pathway listeners**

The HTML edits in Steps 4–7 deleted the elements these functions and
listeners targeted. Now remove the JS that targeted them so nothing
references missing IDs.

Functions to delete (locate via `grep -n "<NAME>" browser-print.html`):
- `async function buildPdf(` (around line 1160) — through its closing
  brace.
- `function regenerateDirect(` (around line 1116) — through its closing
  brace.
- `async function convertViaHelper(` (around line 1248) — through its
  closing brace.

Listeners to delete (around lines 1295–1316):
```javascript
$('printDirect').addEventListener('click', () => printZpl($('zplDirect').value, 'Direct ZPL'));
$('printHelper').addEventListener('click', () => printZpl($('zplHelper').value, 'PDF→helper→ZPL'));
$('convertHelper').addEventListener('click', convertViaHelper);
$('downloadPdf').addEventListener('click', () => { … });
$('printCustomZpl').addEventListener('click', () => { … });
```

Delete all five blocks. The new `printZpl`, `generatePdf`, `printPdf`,
and `downloadPdf` listeners are added in Step 14.

Button-enable bookkeeping to update — find the function that toggles all
the disabled states on/off after device selection (around lines
381–386, currently references `printDirect`, `convertHelper`,
`printCustomZpl`, etc.). Replace those references with the new IDs:

Before:
```javascript
$('printDirect').disabled    = !enabled;
$('convertHelper').disabled  = !enabled;
$('printCustomZpl').disabled = !enabled;
```
After:
```javascript
$('printZpl').disabled      = !enabled;
$('generatePdf').disabled   = !(enabled && pdfPreviewSupported);
```

(The `printPdf` button stays disabled until a PDF actually exists; its
state is managed inside `showPdf` / `clearPdf`.)

Also remove the input-event listener that called `regenerateDirect` on
form-field changes (around line 1378 — `// Pathway-2 textarea becomes
stale on input change …` comment). The replacement is `markZplDirty`
hooked to the new `#zpl` textarea, added in Step 14.

Helper-key persistence (`localStorage` for `featureKey` /
`rememberKey`) — keep this. The feature key is still needed for the
upload-PDF and Print-this-PDF paths against Zebra's official helper.
The relevant code is around line 1250; leave it alone but verify the
selectors still resolve after the section restructure (`#featureKey`
and `#rememberKey` IDs are preserved in Step 7).

- [ ] **Step 13: Add the new lifecycle helpers**

Below the existing `selectDevice` / detection code, add a new block of
functions:

```javascript
// =============================================================================
// ZPL textarea + Generated PDF lifecycle (per spec §7)
// =============================================================================

function setPdfMessage(text, kind /* 'info' | 'warn' | 'err' */) {
  const wrap = $('pdfPreviewWrap');
  const msg = $('pdfMessage');
  const iframe = $('pdfPreview');
  if (text == null) {
    msg.style.display = 'none';
    iframe.style.display = '';
    return;
  }
  msg.textContent = text;
  msg.style.display = '';
  iframe.style.display = 'none';
  msg.style.color = kind === 'err' ? '#a40000'
                  : kind === 'warn' ? '#9a6700'
                  : '#444';
}

function clearPdf() {
  if (lastPdfUrl) { URL.revokeObjectURL(lastPdfUrl); lastPdfUrl = null; }
  lastPdfBytes = null;
  $('pdfPreview').src = 'about:blank';
  $('printPdf').disabled = true;
  $('downloadPdf').removeAttribute('href');
}

function showPdf(bytes) {
  clearPdf();
  lastPdfBytes = bytes;
  const blob = new Blob([bytes], { type: 'application/pdf' });
  lastPdfUrl = URL.createObjectURL(blob);
  $('pdfPreview').src = lastPdfUrl;
  $('downloadPdf').href = lastPdfUrl;
  $('printPdf').disabled = !device;
  setPdfMessage(null);
}

function markZplDirty() {
  zplDirty = true;
  clearPdf();
  setPdfMessage('ZPL changed — click Generate PDF to refresh the preview.', 'info');
}

async function generatePdfFromZpl() {
  if (!device) { setPdfMessage('Select a printer first.', 'warn'); return; }
  if (!pdfPreviewSupported) {
    setPdfMessage('PDF preview unavailable. This requires browser-print-shim.py with zpl2pdf installed (see README §5b).', 'warn');
    return;
  }
  const zpl = $('zpl').value;
  const dpi = (lastDetected && lastDetected.dpi) || 203;
  setPdfMessage('Rendering…', 'info');
  $('generatePdf').disabled = true;
  try {
    const r = await fetch(`http://127.0.0.1:9100/zpl-to-pdf?dpi=${encodeURIComponent(dpi)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: zpl,
    });
    if (!r.ok) {
      const errText = await r.text();
      setPdfMessage(`Conversion failed (HTTP ${r.status}):\n${errText}`, 'err');
      log(`zpl-to-pdf failed: ${r.status} ${errText}`, 'err');
      return;
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    showPdf(buf);
    zplDirty = false;
    log(`zpl-to-pdf: ${zpl.length} chars ZPL → ${buf.length} bytes PDF`);
  } catch (e) {
    setPdfMessage(`Conversion failed: ${e.message || e}`, 'err');
    log(`zpl-to-pdf failed: ${e}`, 'err');
  } finally {
    $('generatePdf').disabled = !device;
  }
}

function regenerateDefaultZpl() {
  if (!lastDetected) return;
  const zpl = defaultZpl({
    widthDots: lastDetected.widthDots,
    heightDots: lastDetected.heightDots,
  });
  $('zpl').value = zpl;
  defaultZplSnapshot = zpl;
  zplDirty = false;
  setPdfMessage(null);
  if (pdfPreviewSupported) generatePdfFromZpl();
}

function maybeRegenerateDefaultZpl() {
  // Called after a printer-change. If the textarea hasn't been edited
  // (still matches the previous default), it's safe to overwrite. If
  // the user has edits, leave them — show a hint instead.
  if (!lastDetected) return;
  if ($('zpl').value === defaultZplSnapshot) {
    regenerateDefaultZpl();
  } else {
    log('Printer changed — current ZPL has user edits. ' +
        'Click Reset to default to use new dimensions.');
  }
}
```

- [ ] **Step 14: Wire the page-load `/config` probe and event handlers**

Find the existing `bpGetAppConfig` call near line 305 and the
`refreshHelperInfo` function (around line 323). After it logs the API
level, also set `pdfPreviewSupported`:

```javascript
async function refreshHelperInfo() {
  try {
    const cfg = await bpGetAppConfig();
    const apiLevel = cfg.api_level ?? '?';
    const platform = cfg.platform ?? '?';
    const conv = cfg.supportedConversions || {};
    pdfPreviewSupported = Array.isArray(conv.zpl) && conv.zpl.includes('pdf');
    setText('apiInfo', `helper: ${platform}, API L${apiLevel}`, 'pill ok');
    log(`Browser Print: platform=${platform}, api_level=${apiLevel}, ` +
        `supportedConversions=${JSON.stringify(conv)}`);
    if (!pdfPreviewSupported) {
      setPdfMessage('PDF preview unavailable. This requires browser-print-shim.py with zpl2pdf installed (see README §5b). Pathway 1 (Print) and the upload-PDF section still work.', 'warn');
    }
  } catch (e) {
    log('getApplicationConfiguration failed: ' + e, 'err');
  }
}
```

Add event listeners (find a good spot near the other listener wiring,
e.g. just below the diagnostics section's listener block):

```javascript
$('zpl').addEventListener('input', markZplDirty);
$('printZpl').addEventListener('click', async () => {
  if (!device) return;
  const zpl = $('zpl').value;
  if (!zpl.trim()) { log('Empty ZPL — nothing to print', 'warn'); return; }
  $('printZpl').disabled = true;
  setText('zplStatus', 'Sending…');
  try {
    await devSend(device, zpl);
    setText('zplStatus', `Sent ${zpl.length} chars`);
    log(`print: device.send ${zpl.length} chars`);
    setTimeout(refreshStatus, 350);
  } catch (e) {
    setText('zplStatus', `Failed: ${e}`, 'err');
    log(`print failed: ${e}`, 'err');
  } finally {
    $('printZpl').disabled = !device;
  }
});

$('generatePdf').addEventListener('click', generatePdfFromZpl);

$('resetZpl').addEventListener('click', (ev) => {
  ev.preventDefault();
  regenerateDefaultZpl();
});

$('printPdf').addEventListener('click', async () => {
  if (!device || !lastPdfBytes) return;
  $('printPdf').disabled = true;
  setText('pdfStatus', 'Sending…');
  try {
    const blob = new Blob([lastPdfBytes], { type: 'application/pdf' });
    await convertAndSendFileViaSdk(blob);
    setText('pdfStatus', `Sent ${lastPdfBytes.length} bytes`);
    log(`print pdf: ${lastPdfBytes.length} bytes via convertAndSendFile`);
    setTimeout(refreshStatus, 350);
  } catch (e) {
    const hint = /license|key/i.test(String(e))
      ? ' (Zebra\'s official helper requires a PDF feature key; the shim ignores it.)' : '';
    setText('pdfStatus', `Failed: ${e}${hint}`, 'err');
    log(`print pdf failed: ${e}`, 'err');
  } finally {
    $('printPdf').disabled = !device || !lastPdfBytes;
  }
});

// Wrap the SDK's callback-style convertAndSendFile in a Promise. The
// helper auto-detects the input format from the blob's MIME type, runs
// the configured PDF→ZPL conversion (Zebra's licensed converter on
// Windows/macOS, or the shim's Ghostscript pipeline on Linux), and
// sends the resulting ZPL to the device.
function convertAndSendFileViaSdk(blob) {
  const featureKey = ($('featureKey') && $('featureKey').value) || '';
  return new Promise((res, rej) => {
    device.convertAndSendFile(blob, res, rej, { featureKey });
  });
}
```

The existing pathway-4 (uploaded PDF) listener already calls
`convertAndSendFile`; verify it still works after the section's HTML
restructure in Step 7. If the button id `printCustomPdf` still matches,
no listener change needed.

- [ ] **Step 15: Wire `regenerateDefaultZpl` into device selection**

Find `selectDevice` (around line 377). After `lastDetected` is populated
(at the bottom of the detection chain in `runDetection` or whatever the
file calls it — search for `lastDetected =` to see where it gets set),
trigger:

```javascript
// If this is a brand-new selection (no defaultZplSnapshot yet) or a re-
// select (same printer), wipe & regenerate. Otherwise sticky-on-edit.
if (!defaultZplSnapshot) {
  regenerateDefaultZpl();
} else if (device && device.uid === previousUid) {
  // Same printer reselected — wipe & regenerate (matches existing
  // "reselect to detect afresh" model).
  regenerateDefaultZpl();
} else {
  maybeRegenerateDefaultZpl();
}
```

This needs `previousUid` tracked between selections — add a module-level
`let previousUid = null;` near the other state, and update it inside
`selectDevice` *before* the new selection completes.

Also enable the new buttons after a successful selection:
```javascript
$('printZpl').disabled = false;
$('generatePdf').disabled = !pdfPreviewSupported;
```

- [ ] **Step 16: Browser smoke test**

Restart the shim. Open the page in Chrome:

```bash
python3 -m http.server 8000   # in the repo root
# then visit http://localhost:8000/browser-print.html
```

Walk through:

1. Page loads with no console errors. The Generated PDF section shows
   "PDF preview unavailable…" or the auto-fired preview, depending on
   whether `bin/linux-x64/zpl2pdf` is installed.
2. Pick the printer from the dropdown. Printer info card populates.
   Textarea fills with the default ZPL (with `^PW{widthDots}` /
   `^LL{heightDots}` reflecting the detected size).
3. (If preview supported) iframe shows the rendered PDF a moment later.
4. Click **Print** — physical label comes out matching today's pathway-1
   output.
5. Edit the textarea (e.g. change `OpenMRS Test Label` to `HELLO`).
   Iframe goes blank, message says "ZPL changed — click Generate PDF".
6. Click **Generate PDF**. Iframe re-renders with the new content.
7. Click **Print this PDF**. Physical label comes out matching the
   round-tripped pathway.
8. Click **Download**. PDF saves to `label.pdf`.
9. Click **↺ Reset to default**. Textarea reverts; iframe re-renders.
10. Pick a different printer (if available). Existing edits to ZPL stay
    sticky; with no edits, ZPL refreshes.
11. Use **Print uploaded PDF** with any small PDF — verify the label
    prints (helper conversion).
12. Diagnostics section unchanged — quick `~hi` press still works.

If anything fails, fix in this same task; don't commit until the smoke
test passes.

- [ ] **Step 17: Commit**

```bash
git add browser-print.html
git commit -m "Page: rewrite around a single ZPL textarea and a server-rendered PDF preview

- Collapse pathways 1 + 3 into one ZPL textarea (free-form edit; default
  pre-filled from detected dimensions).
- Replace in-browser pdf-lib + JsBarcode construction with a server
  call to the shim's new POST /zpl-to-pdf endpoint, which shells out to
  the bundled zpl2pdf binary.
- Always show the Generated PDF section. Auto-fire on printer-select
  when the shim advertises supportedConversions.zpl. Show a clear
  unavailability message otherwise.
- Re-frame the upload-PDF pathway as a 'skip preview' shortcut.
- Drop Header / Body / Barcode form inputs, density / width / height
  inputs, and the unit toggle — guidance text in the ZPL section points
  users at ^PW / ^LL instead.
- Drop pdf-lib script, JsBarcode CDN script, and the unit-toggle JS
  (parseDensity / parseSgdValue retained — printer detection still uses
  them)."
```

---

### Task 8: Delete `pdf-lib.min.js`

**Files:**
- Delete: `pdf-lib.min.js`

- [ ] **Step 1: Confirm nothing references it**

```bash
grep -nr "pdf-lib" --include='*.html' --include='*.js' --include='*.md' .
```
Expected: only README mentions remain (Task 9 cleans those up).

- [ ] **Step 2: Delete the file**

```bash
git rm pdf-lib.min.js
```

- [ ] **Step 3: Commit**

```bash
git commit -m "Remove pdf-lib.min.js — no longer used after the page rewrite"
```

---

### Task 9: README updates

**Files:**
- Modify: `README.md`

Per spec §10. The README is long — touch only the affected sections, keep
voice consistent with the rest of the document.

- [ ] **Step 1: Rewrite §1 intro**

Locate the `# Client-side Zebra label printing` block at the top and the
"Four print pathways" paragraph beneath it (lines 1–28). Replace the
"Four print pathways covering the deployable use-cases" enumeration with:

```markdown
Two operations on a freely-edited ZPL textarea:

1. **Print** — sends the textarea contents directly to the printer
   via `device.send`. Native primitives, sharpest result, smallest
   payload.
2. **Generate PDF** — POSTs the ZPL to the shim's
   `POST /zpl-to-pdf` endpoint (which shells out to the bundled
   `zpl2pdf` binary), gets a PDF back, displays it inline. Useful
   for previewing labels without wasting media. The rendered PDF
   can then be printed via the helper's PDF→ZPL conversion (same
   round-trip path the form-driven pathway used to take).

Plus a skip-preview shortcut: pick any PDF file and route it
straight through the helper's PDF→ZPL conversion.

The page also includes a Diagnostics panel … (rest unchanged)
```

- [ ] **Step 2: Replace §4 Print pathways**

The whole §4 (lines ~177–286) describes the old four-pathway model and
is now obsolete. Replace its contents with a section that covers:

- The two-operation model (Print vs Generate PDF + Print this PDF).
- The ZPL→PDF preview's purpose (iteration without wasted media).
- The PDF→ZPL helper conversion still works the same way it did for the
  old pathway 2; the feature-key caveat is unchanged for users on
  Zebra's official helper.
- The skip-preview shortcut for arbitrary PDFs.

Use the existing tone (decision log style, includes
"things-to-compare-on-real-labels" trade-offs). Pull text from §1 of the
spec for accuracy. Keep the existing PDF Direct subsection as-is — it's
still relevant.

(This is the longest README edit. If preserving git blame matters, do
this in a single commit so the section gets one clean rewrite line.)

- [ ] **Step 3: Add a §5b sub-subsection about installing zpl2pdf**

Find §5b (the Linux dev shim section, around line 337). After its
opening paragraph, before "USB printers", insert:

```markdown
#### PDF preview support — install `zpl2pdf`

For the page's *Generate PDF* button (and the auto-fired preview on
printer-select) the shim shells out to a bundled `zpl2pdf` binary. To
install it once:

```
./install-zpl2pdf.sh                # on Linux / macOS
.\install-zpl2pdf.ps1               # on Windows
```

The script downloads a pinned release from
[brunoleocam/zpl2pdf](https://github.com/brunoleocam/zpl2pdf/releases)
into `bin/<platform>/`, verifies SHA256 against the release's
`checksums.txt`, and is idempotent (re-runs are no-ops if already
installed). The shim auto-detects the binary on startup and advertises
`zpl: ["pdf"]` in its `/config.supportedConversions`. The page reads
that flag at startup and either enables the preview flow or shows
"PDF preview unavailable" in the Generated PDF section.

Without `zpl2pdf` installed, *Print* and the upload-PDF skip-preview
shortcut still work — only the live preview is unavailable.
```

- [ ] **Step 4: Drop §8b "Display units (in/mm)" subsection**

The unit toggle is gone. Find the `#### Display units (in / mm) and the
toggle` heading (around line 663) and the explanation that follows it
(through the line `- \`parseSgdValue(raw)\` — strips STX/ETX framing…`).
Delete this subsection. The two parser helpers documented at the bottom
(`parseDensity`, `parseSgdValue`) **stay** since detection still uses
them — keep them documented in §8b's main body.

- [ ] **Step 5: Update §11 file inventory**

Find the file inventory block (around line 832). Replace with:

```
browser-print.html                  ← the page (single textarea + server-rendered PDF preview + diagnostics)
browser-print-shim.py               ← Linux dev shim (Browser Print API substitute)
                                      — supports USB and network transports + ZPL→PDF preview via zpl2pdf
install-zpl2pdf.sh                  ← POSIX installer for the bundled zpl2pdf binary
install-zpl2pdf.ps1                 ← Windows installer for the bundled zpl2pdf binary
bin/                                ← installed zpl2pdf binaries (.gitignored)
README.md                           ← this file
zebra-browser-print-js-v31250/      ← Zebra SDK 3.1.250 + sample + bundled JSDoc
printers.json                       ← optional: list of network printers for the shim
print.min.js                        ← unused — Print.js still triggers a print dialog;
                                      left in tree only because it was already here
shim-cert.pem, shim-key.pem         ← generated by `--https`; gitignore them
```

(Removed `pdf-lib.min.js`. The `JsBarcode` CDN line in the "External
dependencies" paragraph beneath should also go — find and delete it.)

- [ ] **Step 6: Add a §12 decision-log entry**

Append a new row to the table at the bottom of the file. Use the next
sequential step number (currently the last is #22):

```
| 23 | Simplified the page around a single ZPL textarea and a server-rendered PDF preview. Pathways 1 + 3 collapse into one freely-edited textarea (default pre-filled from detected dimensions; help text points at `^PW`/`^LL`). Pathway 2's in-browser PDF construction (pdf-lib + JsBarcode) is replaced by a `POST /zpl-to-pdf` endpoint on the shim that shells out to a bundled [`zpl2pdf`](https://github.com/brunoleocam/zpl2pdf) binary (MIT licensed, .NET self-contained, `BinaryKits.Zpl` renderer). Drops the form-input + unit-toggle UI entirely. The Generated PDF section is always visible and auto-renders on printer-select; users can iterate on ZPL formatting and preview without printing. Surveyed alternatives: [`zebrafy`](https://github.com/miikanissi/zebrafy) — rejected, only decodes embedded `^GF` bitmaps, not native primitives; Labelary HTTP API — rejected, ZPL contains patient data so a third-party server is unsuitable. The bundled binary is installed via `install-zpl2pdf.sh` (POSIX) / `install-zpl2pdf.ps1` (Windows), pinned to a specific release with SHA256 verification — not vendored in git (would bloat the repo by ~250 MB). |
```

- [ ] **Step 7: Sanity-check for stale references**

```bash
grep -nE "pdf-lib|JsBarcode|userOverrodeUnit|switchUnit|labelW|labelH|valueToDots|buildPdf|buildDirectZpl|Generated ZPL \(used by pathway|Header text|Body text|featureKey.*pathway 2" README.md
```
Expected: no matches. Each match is a stale reference to fix.

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "README: document the ZPL textarea + server-rendered PDF preview redesign"
```

---

## Self-review

After completing all tasks, the engineer should run a final sanity sweep:

- [ ] **Cross-platform install script test (on whichever OS the engineer is on)**
  ```bash
  rm -rf bin/*/
  ./install-zpl2pdf.sh   # or .ps1 on Windows
  ./bin/<platform>/zpl2pdf --version
  ```
- [ ] **Full repo grep for stale references**
  ```bash
  grep -nrE "pdf-lib|JsBarcode|userOverrodeUnit|switchUnit|valueToDots|dotsToValue|maybeAutoSwitchUnitToMm|buildPdf|buildDirectZpl" --include='*.html' --include='*.js' --include='*.py' --include='*.md' .
  ```
  Expected: each remaining match is intentional (e.g. README §12 history
  entries that mention buildDirectZpl in past tense are OK).

- [ ] **Page smoke test on a real printer (the GX430t in the dev box)**
  1. Print ZPL directly — physical label.
  2. Generate PDF + Print this PDF — physical label, round-tripped.
  3. Compare the two: round-tripped should be visibly close (font face
     differs as documented; layout positions match within a dot or two).

- [ ] **Shim smoke tests with `bin/` present and absent**
  - With binary present: `/config` advertises `zpl: ["pdf"]`,
    `POST /zpl-to-pdf` returns a PDF.
  - With binary absent (rename for the test): `/config` omits the key,
    `POST /zpl-to-pdf` returns 503 with the install hint.

If any of these fail, file a follow-up rather than re-opening the merged
plan.
