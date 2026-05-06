#!/usr/bin/env python3
"""
browser-print-shim.py — a minimal Linux replacement for Zebra's Browser Print
helper, intended for development and testing only.

Speaks the same localhost HTTP API as Zebra's official Browser Print helper, so
the official Browser Print SDK in the browser (BrowserPrint-3.x.x.min.js +
BrowserPrint-Zebra-1.x.x.min.js) doesn't know it's talking to a substitute.

Implements:

  GET  /config       Application configuration
                     ({version, build_number, api_level, platform,
                       supportedConversions})
  GET  /available    Discovered devices, grouped by deviceType
                     (e.g. {"printer": [...]})
  GET  /default      Default device. ?type=printer to filter.
                     Empty body = null (the SDK handles that).
  POST /write        Body {device, data}. Forwards `data` bytes to the device.
  POST /read         Body {device}. Reads bytes back from the device (used
                     for ~HS status responses, etc.).
  POST /convert      Body multipart/form-data with `json` (options + device)
                     and `blob` (the file). Renders PDF input via Ghostscript,
                     halftones to 1-bit (Floyd-Steinberg by default; see
                     --convert-mode), and emits compressed ZPL ^GFA. PDF only
                     — image-format conversions (BMP/JPG/PNG/TIF/GIF) are
                     not implemented and return 501.

Listens on http://127.0.0.1:9100. With --https it also binds
https://127.0.0.1:9101 using a self-signed cert (auto-generated via openssl
on first run). CORS-allows everything (dev tool).

USB discovery: globs /dev/usb/lp* and /dev/usblp* (the kernel usblp driver
creates these). Make sure your user can read/write those device nodes — the
simplest way is to be in the `lp` group:

    sudo usermod -aG lp $USER       # then log out and back in

Network printers can be added two ways:

  1. Inline on the command line, one or more times:
       python3 browser-print-shim.py --network 192.168.1.42
       python3 browser-print-shim.py --network 'Lab GX430t=192.168.1.42:9100'
     Format is [name=]host[:port]. Default port is 9100 (raw / JetDirect).

  2. In a printers.json next to this script:
       {
         "network": [
           {"name": "Lab GX430t", "host": "192.168.1.42", "port": 9100}
         ]
       }

Usage:
    python3 browser-print-shim.py
    python3 browser-print-shim.py --network 192.168.1.42
    python3 browser-print-shim.py --no-usb --network 192.168.1.42  # network only
    python3 browser-print-shim.py --https
    python3 browser-print-shim.py --config /path/to/printers.json

This is a shim, not Browser Print. It exists so the prototype's two
pathways — (1) Direct ZPL and (2) Helper-converted PDF — can be exercised on
a Linux dev machine. The PDF→ZPL conversion in pathway 2 isn't bit-identical
to Zebra's licensed converter (we don't have access to that), but the
pipeline is the standard one — Ghostscript render at the printer's dpi,
Floyd-Steinberg dither, ZPL ^GF run-length compression — so output is a
credible substitute for development and visual comparison.
"""

import argparse
import glob
import json
import logging
import os
import re
import select
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

DEFAULT_HTTP_PORT  = 9100
DEFAULT_HTTPS_PORT = 9101
DEFAULT_CONVERT_DPI = 300         # GX430t native; override with --convert-dpi
DEFAULT_CONVERT_MODE = 'dither'   # 'dither' (Floyd-Steinberg) or 'threshold'
SHIM_VERSION = '0.1.0-shim'

# Filled in from CLI args at startup; read by the convert handler.
CONVERT_DPI  = DEFAULT_CONVERT_DPI
CONVERT_MODE = DEFAULT_CONVERT_MODE

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)-5s %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('browser-print-shim')


# -----------------------------------------------------------------------------
# Read drain helpers
# -----------------------------------------------------------------------------
# Some Zebra queries (notably ~HS) reply with multiple STX/ETX-framed records
# flushed back-to-back from the printer. Returning after the first os.read /
# socket.recv often captures only the first frame, which the SDK rejects:
#
#   function h(c){ return 2 !== c.charCodeAt(0)
#                      || 3 !== c.charCodeAt(c.length - 1) ? false : true; }
#   ...this.offline = !h(a.trim());
#
# i.e. trimmed body must start with 0x02 *and* end with 0x03, or the SDK
# reports `offline = true` even though the printer is fine. Draining until
# QUIET_MS of silence (after the first byte arrived) lets the trailing frames
# land in the same response body.
#
# QUIET_MS is sized to be longer than the inter-frame gap a Zebra GX430t
# leaves between ~HS records (observed: tens of ms over USB) and shorter than
# the user-visible round-trip budget. 150 ms is comfortably both.
DRAIN_QUIET_MS = 150
DRAIN_HARD_CAP_MS = 1500     # safety: never spin past this even if the printer keeps emitting

def _drain_until_quiet_fd(fd, max_bytes):
    """Read from a non-blocking file descriptor until QUIET_MS of silence."""
    out = bytearray()
    deadline = time.monotonic() + DRAIN_HARD_CAP_MS / 1000.0
    while True:
        try:
            chunk = os.read(fd, max_bytes)
        except BlockingIOError:
            chunk = b''
        if chunk:
            out.extend(chunk)
            if len(out) >= max_bytes:
                break
        # Wait for more, up to QUIET_MS. If nothing arrives in that window,
        # the printer is done flushing this reply.
        ready, _, _ = select.select([fd], [], [], DRAIN_QUIET_MS / 1000.0)
        if not ready:
            break
        if time.monotonic() > deadline:
            log.warning('drain exceeded %d ms cap (%d bytes so far)', DRAIN_HARD_CAP_MS, len(out))
            break
    return bytes(out)

def _drain_until_quiet_sock(sock, max_bytes):
    """Same as _drain_until_quiet_fd but for a non-blocking socket."""
    out = bytearray()
    deadline = time.monotonic() + DRAIN_HARD_CAP_MS / 1000.0
    while True:
        try:
            chunk = sock.recv(max_bytes)
        except BlockingIOError:
            chunk = b''
        if chunk:
            out.extend(chunk)
            if len(out) >= max_bytes:
                break
        ready, _, _ = select.select([sock], [], [], DRAIN_QUIET_MS / 1000.0)
        if not ready:
            break
        if time.monotonic() > deadline:
            log.warning('drain exceeded %d ms cap (%d bytes so far)', DRAIN_HARD_CAP_MS, len(out))
            break
    return bytes(out)


# -----------------------------------------------------------------------------
# Device abstractions — common interface for USB and network printers.
# -----------------------------------------------------------------------------

class Device:
    def __init__(self, name, uid, connection, manufacturer='', model='', serial=''):
        self.name = name
        self.uid = uid
        self.connection = connection         # 'usb' or 'network'
        self.deviceType = 'printer'
        self.version = SHIM_VERSION
        self.provider = 'browser-print-shim'
        self.manufacturer = manufacturer
        self.model = model
        self.serial = serial
        self.lock = threading.Lock()

    def to_json(self):
        # Match the field set the SDK echoes back on every /write and /read.
        return {
            'name': self.name,
            'uid': self.uid,
            'connection': self.connection,
            'deviceType': self.deviceType,
            'version': self.version,
            'provider': self.provider,
            'manufacturer': self.manufacturer,
        }

    def write(self, data: bytes):
        raise NotImplementedError

    def read(self, max_bytes=8192, timeout=1.0) -> bytes:
        raise NotImplementedError

    def close(self):
        pass


class UsbDevice(Device):
    """Talks to /dev/usb/lpN (or /dev/usblpN) — bidirectional via usblp."""
    def __init__(self, devpath, manufacturer='', model='', serial=''):
        nice_model = (model or 'USB printer').strip()
        suffix = os.path.basename(devpath)
        if manufacturer:
            name = f'{manufacturer.strip()} {nice_model} ({suffix})'
        else:
            name = f'{nice_model} ({suffix})'
        # Use the serial if we have one (stable across replug); else fall back
        # to the path. Either way the SDK echoes this back to us on /write.
        uid = f'usb:{serial}' if serial else f'usb:{devpath}'
        super().__init__(name, uid, 'usb', manufacturer, nice_model, serial)
        self.devpath = devpath
        self.fd = None

    def _open(self):
        if self.fd is None:
            log.info('Opening %s', self.devpath)
            self.fd = os.open(self.devpath, os.O_RDWR | os.O_NONBLOCK)
            # Drain any stale bytes left in the kernel read buffer by a previous
            # shim instance that exited mid-read. If we don't, the very next
            # read against this device returns yesterday's response, which
            # poisons the SDK's getConfiguration/getInfo parsers (those throw
            # "Invalid Response" when they don't see STX/ETX framing).
            drained = 0
            while True:
                try:
                    chunk = os.read(self.fd, 4096)
                    if not chunk:
                        break
                    drained += len(chunk)
                except (BlockingIOError, OSError):
                    break
            if drained:
                log.info('Drained %d stale bytes from %s', drained, self.devpath)

    def close(self):
        if self.fd is not None:
            try: os.close(self.fd)
            except OSError: pass
            self.fd = None

    def write(self, data: bytes):
        with self.lock:
            self._open()
            written = 0
            deadline = time.monotonic() + 30.0
            while written < len(data):
                if time.monotonic() > deadline:
                    raise IOError('USB write timed out')
                try:
                    n = os.write(self.fd, data[written:])
                    written += max(n, 0)
                except BlockingIOError:
                    select.select([], [self.fd], [], 1.0)
                except OSError as e:
                    self.close()
                    raise IOError(f'USB write error on {self.devpath}: {e}') from e

    def read(self, max_bytes=8192, timeout=1.0):
        with self.lock:
            self._open()
            ready, _, _ = select.select([self.fd], [], [], timeout)
            if not ready:
                return b''
            # Drain until quiet. The Zebra ~HS reply is three STX/ETX-framed
            # records flushed back-to-back; if we return after the first
            # os.read() we may capture only the first frame, and the SDK then
            # reports `offline=true` because the trimmed body doesn't end on
            # 0x03. See _drain_until_quiet() for the rationale.
            try:
                return _drain_until_quiet_fd(self.fd, max_bytes)
            except OSError as e:
                self.close()
                raise IOError(f'USB read error on {self.devpath}: {e}') from e


class NetworkDevice(Device):
    """TCP socket on raw-print port (9100 by default). Persistent connection so
    a /write followed by /read can do query/response (e.g. ~HS)."""
    def __init__(self, name, host, port=9100):
        uid = f'net:{host}:{port}'
        super().__init__(name, uid, 'network')
        self.host = host
        self.port = port
        self.sock = None
        self.last_io = 0.0

    def _ensure_socket(self):
        # Reconnect if the connection has been idle for a while (printer-side
        # timeouts vary; 30 s is a safe default for raw-port).
        if self.sock is not None and time.monotonic() - self.last_io > 30.0:
            self.close()
        if self.sock is None:
            log.info('Connecting to %s:%d', self.host, self.port)
            self.sock = socket.create_connection((self.host, self.port), timeout=10)
            self.sock.setblocking(False)
        self.last_io = time.monotonic()

    def close(self):
        if self.sock is not None:
            try: self.sock.close()
            except OSError: pass
            self.sock = None

    def write(self, data: bytes):
        with self.lock:
            self._ensure_socket()
            sent = 0
            while sent < len(data):
                try:
                    sent += self.sock.send(data[sent:])
                except BlockingIOError:
                    select.select([], [self.sock], [], 1.0)
                except OSError as e:
                    self.close()
                    raise IOError(f'Network write error on {self.host}:{self.port}: {e}') from e
            self.last_io = time.monotonic()

    def read(self, max_bytes=8192, timeout=1.0):
        with self.lock:
            if self.sock is None:
                return b''
            ready, _, _ = select.select([self.sock], [], [], timeout)
            if not ready:
                return b''
            try:
                # See UsbDevice.read() — same drain-until-quiet rationale for
                # multi-frame ~HS replies.
                chunk = _drain_until_quiet_sock(self.sock, max_bytes)
                if chunk:
                    self.last_io = time.monotonic()
                return chunk
            except OSError as e:
                self.close()
                raise IOError(f'Network read error: {e}') from e


# -----------------------------------------------------------------------------
# Discovery
# -----------------------------------------------------------------------------

def udev_info(path):
    try:
        out = subprocess.check_output(
            ['udevadm', 'info', '--query=property', '--name', path],
            text=True, timeout=3, stderr=subprocess.DEVNULL,
        )
        return dict(line.split('=', 1) for line in out.splitlines() if '=' in line)
    except Exception:
        return {}


def discover_usb_printers():
    devices = []
    paths = sorted(set(glob.glob('/dev/usb/lp*') + glob.glob('/dev/usblp*')))
    if not paths:
        log.info('No USB printers found under /dev/usb/lp* or /dev/usblp*. '
                 'Is a USB printer plugged in and the usblp kernel module loaded?')
        return devices

    for p in paths:
        if not os.access(p, os.R_OK | os.W_OK):
            log.warning('No read/write access to %s. Add your user to the lp group:', p)
            log.warning('    sudo usermod -aG lp $USER     (then log out and back in)')
            continue
        info = udev_info(p)
        manufacturer = info.get('ID_VENDOR', '').replace('_', ' ').strip()
        model        = (info.get('ID_MODEL') or info.get('ID_MODEL_FROM_DATABASE') or '').replace('_', ' ').strip()
        serial       = info.get('ID_SERIAL_SHORT', '') or info.get('ID_SERIAL', '')
        try:
            d = UsbDevice(p, manufacturer=manufacturer, model=model, serial=serial)
            devices.append(d)
            log.info('Discovered USB printer: %s', d.name)
        except Exception as e:
            log.warning('Could not register %s: %s', p, e)
    return devices


def load_network_printers(config_path):
    if not os.path.exists(config_path):
        return []
    try:
        cfg = json.load(open(config_path))
    except Exception as e:
        log.warning('Could not parse %s: %s', config_path, e)
        return []
    out = []
    for entry in cfg.get('network', []) or []:
        try:
            d = NetworkDevice(entry['name'], entry['host'], int(entry.get('port', 9100)))
            out.append(d)
            log.info('Configured network printer: %s @ %s:%s', d.name, d.host, d.port)
        except Exception as e:
            log.warning('Bad network printer entry %s: %s', entry, e)
    return out


# -----------------------------------------------------------------------------
# Registry
# -----------------------------------------------------------------------------

class Registry:
    def __init__(self):
        self.lock = threading.Lock()
        self.devices = []
        self._by_uid = {}

    def replace(self, devices):
        with self.lock:
            for d in self.devices:
                d.close()
            self.devices = list(devices)
            self._by_uid = {d.uid: d for d in self.devices}

    def find(self, device_dict):
        if not isinstance(device_dict, dict):
            return None
        uid = device_dict.get('uid')
        with self.lock:
            return self._by_uid.get(uid)

    def all(self):
        with self.lock:
            return list(self.devices)


registry = Registry()


# -----------------------------------------------------------------------------
# PDF → ZPL conversion (used by /convert)
#
# Pipeline:
#   1. Render page 1 of the PDF to grayscale PGM via Ghostscript.
#   2. Convert grayscale → 1-bit using Floyd-Steinberg error diffusion (or
#      simple threshold, depending on --convert-mode).
#   3. Pack to row-major bytes (8 px / byte, MSB-first, 1 = black).
#   4. Run-length compress into ZPL ^GF data using the standard letter scheme:
#        G..Y  = 1..19          (uppercase, additive ones)
#        g..z  = 20..400         (lowercase, additive twenties; z = 400)
#        ','   = fill rest of row with 0   (white)
#        '!'   = fill rest of row with F   (black)
#        ':'   = repeat previous row
#   5. Wrap as ^XA^PWw^LLh^FO0,0^GFA,bytes,bytes,bytesPerRow,DATA^FS^XZ.
#
# This is the same ^GF compression scheme Zebra's official tooling uses, so
# the output is a credible substitute for the licensed converter — good
# enough for visual comparison and development, though not bit-identical.
# -----------------------------------------------------------------------------

def _have_ghostscript():
    return shutil.which('gs') is not None


def _gs_version_str():
    try:
        return subprocess.check_output(['gs', '--version'], text=True, timeout=2).strip()
    except Exception:
        return '?'


def _render_pdf_to_pgm(pdf_bytes, dpi):
    """Render page 1 of a PDF to PGM (8-bit grayscale). Returns (w, h, pixels).
    pixels: bytes of length w*h, 0=black, 255=white."""
    if not _have_ghostscript():
        raise RuntimeError(
            'Ghostscript (gs) is required for PDF conversion in the shim. '
            'Install: sudo apt install ghostscript'
        )
    cmd = [
        'gs', '-dQUIET', '-dBATCH', '-dNOPAUSE', '-dSAFER',
        '-sDEVICE=pgmraw',
        f'-r{int(dpi)}',
        '-dTextAlphaBits=4',
        '-dGraphicsAlphaBits=4',
        '-dFirstPage=1', '-dLastPage=1',
        '-sOutputFile=-',
        '-',
    ]
    proc = subprocess.run(cmd, input=pdf_bytes, capture_output=True, timeout=60)
    if proc.returncode != 0 or not proc.stdout:
        raise RuntimeError(
            'gs failed: ' + proc.stderr.decode('utf-8', 'replace')[:500]
        )
    return _parse_pgm(proc.stdout)


def _parse_pgm(data):
    """Parse PGM raw (P5) output from Ghostscript."""
    if not data.startswith(b'P5'):
        raise RuntimeError('Not a PGM (P5) image')
    pos = 2
    tokens = []
    while len(tokens) < 3:
        # Skip whitespace
        while pos < len(data) and data[pos:pos+1] in (b' ', b'\t', b'\n', b'\r'):
            pos += 1
        # Skip comments (one per line)
        if pos < len(data) and data[pos:pos+1] == b'#':
            while pos < len(data) and data[pos:pos+1] != b'\n':
                pos += 1
            continue
        # Read a token
        start = pos
        while pos < len(data) and data[pos:pos+1] not in (b' ', b'\t', b'\n', b'\r'):
            pos += 1
        tokens.append(data[start:pos].decode('ascii'))
    width, height, maxval = int(tokens[0]), int(tokens[1]), int(tokens[2])
    pos += 1   # exactly one whitespace byte after maxval per spec
    if maxval != 255:
        raise RuntimeError(f'Unexpected PGM maxval {maxval}; expected 255')
    pixels = data[pos:pos + width * height]
    if len(pixels) != width * height:
        raise RuntimeError(f'PGM size mismatch: got {len(pixels)} bytes, expected {width*height}')
    return width, height, pixels


def _floyd_steinberg(width, height, gray, threshold=128):
    """Convert grayscale to packed 1-bit via Floyd-Steinberg error diffusion.
    Returns bytes: bytes_per_row * height bytes, MSB=leftmost pixel, 1=black."""
    pix = list(gray)             # mutable working copy of int pixels
    bpr = (width + 7) // 8
    out = bytearray(bpr * height)
    for y in range(height):
        rs = y * width
        ns = rs + width
        os_ = y * bpr
        for x in range(width):
            old = pix[rs + x]
            if old < threshold:
                out[os_ + (x >> 3)] |= 0x80 >> (x & 7)
                err = old           # err = old - 0 = old
            else:
                err = old - 255
            if err == 0:
                continue
            # Distribute to not-yet-processed neighbours.
            if x + 1 < width:
                pix[rs + x + 1] += (err * 7) >> 4
            if y + 1 < height:
                if x > 0:
                    pix[ns + x - 1] += (err * 3) >> 4
                pix[ns + x] += (err * 5) >> 4
                if x + 1 < width:
                    pix[ns + x + 1] += err >> 4
    return bytes(out)


def _threshold(width, height, gray, threshold=128):
    """Naive < threshold = black. Returns same packed-1-bit format."""
    bpr = (width + 7) // 8
    out = bytearray(bpr * height)
    for y in range(height):
        rs = y * width
        os_ = y * bpr
        for x in range(width):
            if gray[rs + x] < threshold:
                out[os_ + (x >> 3)] |= 0x80 >> (x & 7)
    return bytes(out)


def _encode_run(ch, n):
    """Emit n consecutive ch hex digits using ZPL ^GF compression letters."""
    if n <= 0:
        return ''
    out = []
    # Bigger-than-400 runs: chunk with z + ch (each z = 400).
    while n >= 400:
        out.append('z')
        out.append(ch)
        n -= 400
    if n == 0:
        return ''.join(out)
    if n == 1:
        out.append(ch)
        return ''.join(out)
    # n in [2, 399].
    tens = n // 20      # 0..19  → maps to g..y (g=20, y=380)
    ones = n % 20       # 0..19  → maps to G..Y (G=1, Y=19)
    if tens > 0:
        out.append(chr(ord('g') + tens - 1))
    if ones >= 2 or (ones == 1 and tens > 0):
        out.append(chr(ord('G') + ones - 1))
    out.append(ch)
    return ''.join(out)


def _compress_runs(hex_str):
    out = []
    i, n = 0, len(hex_str)
    while i < n:
        ch = hex_str[i]
        j = i
        while j < n and hex_str[j] == ch:
            j += 1
        out.append(_encode_run(ch, j - i))
        i = j
    return ''.join(out)


def _strip_trailing_byte_pairs(hex_row, byte_val):
    """Strip whole trailing bytes whose hex is `byte_val + byte_val`.

    `bytes.hex()` always emits two chars per byte. A naive `.rstrip('0')` can
    delete a single '0' nibble in the middle of a byte (e.g. 'F0' → 'F'),
    which creates an odd-length hex string and confuses ZPL's ^GF parser.
    Stripping in 2-char pairs preserves byte alignment.
    """
    pair = byte_val + byte_val
    while hex_row.endswith(pair):
        hex_row = hex_row[:-2]
    return hex_row


def _compress_zpl_gfa(width, height, packed):
    """Compress the 1-bit bitmap into a ZPL ^GF data string."""
    bpr = (width + 7) // 8
    pieces = []
    prev_hex = None
    for y in range(height):
        row = packed[y * bpr : (y + 1) * bpr]
        hex_row = row.hex().upper()         # 2 hex chars per byte
        if hex_row == prev_hex:
            pieces.append(':')
            continue
        prev_hex = hex_row
        # Trailing-all-white-byte / trailing-all-black-byte shortcuts. Strip in
        # whole bytes (2 hex chars) so we never produce an odd-length sequence.
        s0 = _strip_trailing_byte_pairs(hex_row, '0')
        sF = _strip_trailing_byte_pairs(hex_row, 'F')
        if not s0:
            pieces.append(',')
            continue
        if not sF:
            pieces.append('!')
            continue
        zlen = len(hex_row) - len(s0)
        flen = len(hex_row) - len(sF)
        if zlen >= flen and zlen > 0:
            pieces.append(_compress_runs(s0))
            pieces.append(',')
        elif flen > 0:
            pieces.append(_compress_runs(sF))
            pieces.append('!')
        else:
            pieces.append(_compress_runs(hex_row))
    return ''.join(pieces)


def pdf_to_zpl(pdf_bytes, dpi=300, mode='dither'):
    """Convert a PDF (page 1) to a complete ZPL label."""
    width, height, gray = _render_pdf_to_pgm(pdf_bytes, dpi)
    if mode == 'threshold':
        packed = _threshold(width, height, gray)
    else:
        packed = _floyd_steinberg(width, height, gray)
    bpr = (width + 7) // 8
    total = bpr * height
    data = _compress_zpl_gfa(width, height, packed)
    return (
        f'^XA^PW{width}^LL{height}^LH0,0'
        f'^FO0,0^GFA,{total},{total},{bpr},{data}^FS^XZ'
    )


# -----------------------------------------------------------------------------
# Multipart/form-data parser (just enough for what the SDK posts to /convert).
# -----------------------------------------------------------------------------

def _parse_multipart(content_type, body):
    """Returns dict {field_name: (filename, content_type, content_bytes)}."""
    m = re.search(r'boundary=([^;]+)', content_type)
    if not m:
        raise ValueError('multipart/form-data without boundary')
    boundary = m.group(1).strip().strip('"')
    delim = b'--' + boundary.encode('ascii')
    parts = body.split(delim)
    out = {}
    for chunk in parts[1:-1]:               # skip preamble + closing
        if chunk.startswith(b'\r\n'):
            chunk = chunk[2:]
        if chunk.endswith(b'\r\n'):
            chunk = chunk[:-2]
        sep = chunk.find(b'\r\n\r\n')
        if sep < 0:
            continue
        header_block = chunk[:sep].decode('latin-1', errors='replace')
        part_body = chunk[sep + 4:]
        headers = {}
        for line in header_block.split('\r\n'):
            if ':' in line:
                k, v = line.split(':', 1)
                headers[k.strip().lower()] = v.strip()
        cd = headers.get('content-disposition', '')
        nm = re.search(r'name="([^"]+)"', cd)
        if not nm:
            continue
        fn = re.search(r'filename="([^"]*)"', cd)
        out[nm.group(1)] = (
            fn.group(1) if fn else None,
            headers.get('content-type'),
            part_body,
        )
    return out


# -----------------------------------------------------------------------------
# HTTP handler
# -----------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):

    # Friendlier access log
    def log_message(self, fmt, *args):
        log.info('%s', fmt % args)

    # ---- response helpers ----

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With')

    def _send(self, status, body=b'', content_type='text/plain; charset=utf-8'):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self._send(status, body, 'application/json; charset=utf-8')

    def _read_body(self):
        n = int(self.headers.get('Content-Length', '0') or '0')
        return self.rfile.read(n) if n > 0 else b''

    def _read_json(self):
        raw = self._read_body()
        if not raw:
            return {}
        try:
            return json.loads(raw.decode('utf-8'))
        except Exception:
            return {}

    # ---- routing ----

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/config':       return self.handle_config()
        if path == '/available':    return self.handle_available()
        if path == '/default':      return self.handle_default()
        return self._send(404, 'Not found')

    def do_POST(self):
        path = urlparse(self.path).path
        if path == '/write':        return self.handle_write()
        if path == '/read':         return self.handle_read()
        if path == '/convert':      return self.handle_convert()
        return self._send(404, 'Not found')

    # ---- handlers ----

    def handle_config(self):
        # Advertise PDF→ZPL conversion if Ghostscript is available.
        # api_level 4 is the level the SDK requires for convert/* endpoints.
        if _have_ghostscript():
            api = 4
            conv = {'pdf': ['zpl']}
        else:
            api = 2
            conv = {}
        return self._send_json(200, {
            'version': SHIM_VERSION,
            'build_number': 0,
            'api_level': api,
            'platform': 'linux',
            'supportedConversions': conv,
        })

    def handle_available(self):
        groups = {}
        for d in registry.all():
            groups.setdefault(d.deviceType, []).append(d.to_json())
        return self._send_json(200, groups)

    def handle_default(self):
        q = parse_qs(urlparse(self.path).query)
        wanted = (q.get('type') or [None])[0]
        for d in registry.all():
            if wanted is None or d.deviceType == wanted:
                return self._send_json(200, d.to_json())
        # SDK treats empty body as "no default device".
        return self._send(200, '')

    def handle_write(self):
        body = self._read_json()
        device = registry.find(body.get('device') or {})
        if device is None:
            return self._send(404, 'Unknown device (uid not in registry)')
        data = body.get('data', '')
        if isinstance(data, str):
            data_bytes = data.encode('utf-8')
        elif isinstance(data, list):
            data_bytes = bytes(data)
        else:
            return self._send(400, 'Bad data field')
        try:
            t0 = time.monotonic()
            device.write(data_bytes)
            dt_ms = (time.monotonic() - t0) * 1000.0
            log.info('write → %s : %d bytes in %.0f ms',
                     device.name, len(data_bytes), dt_ms)
        except Exception as e:
            log.exception('write failed')
            return self._send(500, f'write failed: {e}')
        return self._send(200, '')

    def handle_read(self):
        body = self._read_json()
        device = registry.find(body.get('device') or {})
        if device is None:
            return self._send(404, 'Unknown device (uid not in registry)')
        try:
            chunk = device.read(timeout=2.0)
            log.info('read  ← %s : %d bytes', device.name, len(chunk))
        except Exception as e:
            log.exception('read failed')
            return self._send(500, f'read failed: {e}')
        return self._send(200, chunk.decode('utf-8', errors='replace'))

    def handle_convert(self):
        ct = self.headers.get('Content-Type', '')
        if 'multipart/form-data' not in ct.lower():
            return self._send(400, 'Expected multipart/form-data')
        body = self._read_body()
        try:
            parts = _parse_multipart(ct, body)
        except Exception as e:
            return self._send(400, f'Could not parse multipart: {e}')

        json_part = parts.get('json')
        blob_part = parts.get('blob')
        if not blob_part:
            return self._send(400, "Missing 'blob' part in multipart body")

        options, device_dict = {}, None
        if json_part:
            try:
                payload = json.loads(json_part[2].decode('utf-8'))
                options = payload.get('options') or {}
                device_dict = payload.get('device')
            except Exception as e:
                return self._send(400, f"Bad 'json' part: {e}")

        to_format   = (options.get('toFormat') or 'zpl').lower()
        from_format = (options.get('fromFormat') or '').lower()
        action      = (options.get('action') or 'print').lower()

        if to_format != 'zpl':
            return self._send(501, f"Shim only outputs ZPL (got toFormat={to_format!r})")
        if action == 'store':
            return self._send(501, "action='store' is not implemented in the shim")

        blob_bytes = blob_part[2]
        blob_ct = (blob_part[1] or '').lower()
        is_pdf = (
            from_format == 'pdf'
            or 'pdf' in blob_ct
            or blob_bytes[:5] == b'%PDF-'
        )
        if not is_pdf:
            return self._send(
                501,
                f"Shim only converts PDF input (got fromFormat={from_format!r}, "
                f"content-type={blob_ct!r})",
            )

        log.info('convert: PDF → ZPL @ %d dpi, mode=%s, action=%s, %d bytes input',
                 CONVERT_DPI, CONVERT_MODE, action, len(blob_bytes))
        try:
            t0 = time.monotonic()
            zpl = pdf_to_zpl(blob_bytes, dpi=CONVERT_DPI, mode=CONVERT_MODE)
            dt = (time.monotonic() - t0) * 1000.0
            log.info('convert: produced %s chars ZPL in %.0f ms',
                     f'{len(zpl):,}', dt)
        except Exception as e:
            log.exception('PDF conversion failed')
            return self._send(500, f'PDF conversion failed: {e}')

        # action='print' (and the default) also routes to the device.
        if action == 'print':
            device = registry.find(device_dict or {})
            if device is None:
                return self._send(404, 'Unknown device for action=print')
            try:
                device.write(zpl.encode('utf-8'))
                log.info('convert: printed to %s', device.name)
            except Exception as e:
                log.exception('post-convert print failed')
                return self._send(500, f'Print failed after convert: {e}')

        # SDK does JSON.parse(responseText) and resolves the promise with the
        # result, so a JSON-encoded string is what user code receives back.
        return self._send_json(200, zpl)


# -----------------------------------------------------------------------------
# Server bootstrap
# -----------------------------------------------------------------------------

def ensure_self_signed_cert(cert_path, key_path):
    if os.path.exists(cert_path) and os.path.exists(key_path):
        return
    log.info('Generating self-signed cert at %s', cert_path)
    subprocess.check_call([
        'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', key_path, '-out', cert_path, '-days', '3650',
        '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ])


def serve(port, ssl_ctx=None):
    httpd = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    if ssl_ctx is not None:
        httpd.socket = ssl_ctx.wrap_socket(httpd.socket, server_side=True)
        log.info('HTTPS listening on https://127.0.0.1:%d (self-signed; visit once and trust)', port)
    else:
        log.info('HTTP  listening on http://127.0.0.1:%d', port)
    httpd.serve_forever()


def parse_args():
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser(description='Browser Print API shim for Linux (development only).')
    p.add_argument('--http-port',  type=int, default=DEFAULT_HTTP_PORT)
    p.add_argument('--https-port', type=int, default=DEFAULT_HTTPS_PORT)
    p.add_argument('--https', action='store_true',
                   help='Also bind HTTPS on --https-port (auto-generates a self-signed cert if needed).')
    p.add_argument('--cert', default=os.path.join(here, 'shim-cert.pem'))
    p.add_argument('--key',  default=os.path.join(here, 'shim-key.pem'))
    p.add_argument('--no-usb', action='store_true', help='Skip USB discovery.')
    p.add_argument('--network', action='append', default=[], metavar='[NAME=]HOST[:PORT]',
                   help='Register a network printer (repeatable). Default port 9100. '
                        'Examples: --network 192.168.1.42  or  --network "Lab GX430t=10.0.0.5:9100"')
    p.add_argument('--config', default=os.path.join(here, 'printers.json'),
                   help='Path to a JSON file listing additional network printers.')
    p.add_argument('--rescan-seconds', type=int, default=30,
                   help='How often to rediscover USB devices.')
    p.add_argument('--convert-dpi', type=int, default=DEFAULT_CONVERT_DPI,
                   help='Render PDFs at this dpi when /convert is called. '
                        'Default %(default)d (matches GX430t native).')
    p.add_argument('--convert-mode', choices=['dither', 'threshold'],
                   default=DEFAULT_CONVERT_MODE,
                   help='Halftoning mode for PDF→1-bit. "dither" = Floyd-Steinberg '
                        '(better for grayscale / photos / antialiased edges). '
                        '"threshold" = naive < 128 cutoff (sharpest for pure text/barcode '
                        'but loses gradient detail). Default %(default)s.')
    return p.parse_args()


def parse_network_arg(spec):
    """Parse '[NAME=]HOST[:PORT]' into a NetworkDevice."""
    name = None
    rest = spec
    if '=' in spec and not spec.startswith('['):
        name, rest = spec.split('=', 1)
        name = name.strip()
    # IPv6 in [brackets] support
    if rest.startswith('['):
        end = rest.find(']')
        host = rest[1:end]
        port_part = rest[end+1:]
        port = int(port_part.lstrip(':')) if port_part else 9100
    elif ':' in rest:
        host, port_str = rest.rsplit(':', 1)
        port = int(port_str)
    else:
        host = rest
        port = 9100
    if not name:
        name = f'{host}:{port}'
    return NetworkDevice(name, host.strip(), port)


def refresh_devices(args):
    devices = []
    if not args.no_usb:
        devices += discover_usb_printers()

    # Network printers from --network CLI args
    for spec in (args.network or []):
        try:
            d = parse_network_arg(spec)
            devices.append(d)
            log.info('Configured network printer (CLI): %s @ %s:%d', d.name, d.host, d.port)
        except Exception as e:
            log.warning('Bad --network %r: %s', spec, e)

    # Network printers from printers.json (if present)
    devices += load_network_printers(args.config)

    registry.replace(devices)
    if not devices:
        log.warning('No printers registered. Either:')
        log.warning('  - Plug in a USB Zebra (and ensure your user has access to /dev/usb/lp*)')
        log.warning('  - Pass --network HOST[:PORT] for a network printer')
        log.warning('  - Add network printers to %s', args.config)


def main():
    global CONVERT_DPI, CONVERT_MODE
    args = parse_args()
    CONVERT_DPI  = args.convert_dpi
    CONVERT_MODE = args.convert_mode
    if _have_ghostscript():
        log.info('PDF conversion: enabled (gs %s, dpi=%d, mode=%s)',
                 _gs_version_str(), CONVERT_DPI, CONVERT_MODE)
    else:
        log.warning('PDF conversion: DISABLED — Ghostscript not found. '
                    'Install with `sudo apt install ghostscript` to enable /convert.')
    refresh_devices(args)

    threads = [threading.Thread(target=serve, args=(args.http_port,), daemon=True)]

    if args.https:
        try:
            ensure_self_signed_cert(args.cert, args.key)
            ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
            ctx.load_cert_chain(args.cert, args.key)
            threads.append(threading.Thread(target=serve, args=(args.https_port, ctx), daemon=True))
        except Exception as e:
            log.error('Could not enable HTTPS: %s. Continuing with HTTP only.', e)

    for t in threads:
        t.start()

    log.info('Ready. Open the prototype HTML page in Chrome and click "Refresh printer list".')
    try:
        while True:
            time.sleep(args.rescan_seconds)
            refresh_devices(args)
    except KeyboardInterrupt:
        log.info('Shutting down.')
        for d in registry.all():
            d.close()


if __name__ == '__main__':
    main()
