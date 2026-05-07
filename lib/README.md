# `lib/zebra-browser-print.js` — minimal MPL-2.0 Browser Print client

Vanilla-JS replacement for Zebra's bundled `BrowserPrint-3.x.min.js` +
`BrowserPrint-Zebra-1.x.min.js` SDK files, scoped to the operations a
typical label-printing webapp actually uses: discovery + raw-byte send
+ read + status-style query.

**Drop into any web app** — single file, no dependencies, no build
step, no polyfills. Modern-browser JS (async/await, classes, fetch).

## Why this exists

The proprietary Zebra SDK bundled under `app/` is fine for prototyping
in this repo, but redistributing it in an MPL-licensed downstream
project (e.g. an OpenMRS module) is a licensing question we'd rather
not have. This file is the same wire protocol re-implemented from the
documented HTTP contract — no Zebra source consulted, no Zebra binary
bytes copied. MPL-2.0 licensed.

The protocol itself isn't a secret: `utils/browser-print-shim.py` in
this repo is a working *server-side* implementation of the same API
(it's how we developed Linux without Zebra's helper). This client and
that server were both written from the same observed wire format.

## What's included

| Method | HTTP | Notes |
|---|---|---|
| `ZebraBrowserPrint.getApplicationConfiguration()` | `GET /config` | Returns `{ version, api_level, platform, supportedConversions }`. |
| `ZebraBrowserPrint.getDefaultDevice(type?)` | `GET /default?type=...` | Returns a `Device` or `null`. |
| `ZebraBrowserPrint.getLocalDevices(type?)` | `GET /available` | Returns `Device[]`. With no type, returns all groups. |
| `device.send(data: string)` | `POST /write` | Sends ZPL (or any printer-language string). |
| `device.read(): Promise<string>` | `POST /read` | Single-shot read of buffered bytes. Returns `''` if nothing buffered. |
| `device.sendAndRead(data, opts?): Promise<string>` | `POST /write` + multiple `POST /read` | Send + drain-until-quiet, for status / config / SGD queries. |
| `ZebraBrowserPrint.setHelperBaseUrl(url)` | — | Override the helper URL (testing, non-localhost helpers). |
| `ZebraBrowserPrint.getHelperBaseUrl()` | — | Inspect the current URL. |

The default helper URL auto-switches between `http://127.0.0.1:9100`
(when the page is HTTP) and `https://127.0.0.1:9101` (when the page is
HTTPS) at module-load time. Browser Print's HTTPS endpoint uses a
self-signed cert — first-time users have to accept it once per origin.

## What's not included

- **`convertAndSendFile` / `getConvertedResource`** (PDF→ZPL via the
  helper's licensed converter). Most production webapps generate ZPL
  server-side and don't need helper-side PDF conversion.
- **Per-printer command queue.** The proprietary SDK serialises every
  send/read on a `Printer` instance behind a single in-flight slot.
  This client trusts the caller — most have one operation in flight at
  a time anyway. If concurrent calls land on the same physical printer
  through the same helper, the helper itself serialises the underlying
  USB/TCP transport.
- **Promise/callback dual API.** Promises only.
- **Higher-level `Zebra.Printer` wrapper** with `getStatus`/`getConfiguration`/
  `getInfo`/`getSGD`. Trivial to add on top — they're each a single
  `sendAndRead` call followed by parsing — but parsing is application-
  specific (which fields you care about, how strict you want to be on
  malformed replies), so I left it for the consumer to write.

## Usage

### Plain script tag

```html
<script src="zebra-browser-print.js"></script>
<script>
  (async () => {
    const printer = await ZebraBrowserPrint.getDefaultDevice('printer');
    if (!printer) {
      alert('No printer registered with Browser Print');
      return;
    }
    await printer.send('^XA^FO50,50^A0N,30,30^FDHello^FS^XZ');
  })();
</script>
```

### ESM

```js
import './zebra-browser-print.js';        // attaches to globalThis
const ZBP = globalThis.ZebraBrowserPrint;

const printers = await ZBP.getLocalDevices('printer');
for (const p of printers) {
  console.log(p.name, p.connection, p.uid);
}
```

### Status / config queries (drain pattern)

```js
const printer = await ZebraBrowserPrint.getDefaultDevice('printer');

// `~hs` returns three STX/ETX-framed records flushed back-to-back over
// a few hundred ms; sendAndRead polls /read until the printer's quiet.
const reply = await printer.sendAndRead('~hs');
// → "\x02030,...\x03\x02000,...\x03\x02014,...\x03"

// Parse however you want; the SDK's status parser is ~30 lines of
// bit-flag extraction. ZPL Programming Guide documents the format.
```

## Tests

```bash
node lib/zebra-browser-print.test.mjs
```

13 cases, no deps. Mocks `globalThis.fetch` and asserts the URL,
method, and body of every helper call.

## License

MPL-2.0. Copyright (c) 2026 Partners In Health. The full text is in
the SPDX line at the top of the source file; if redistributing this
into a project without an MPL header, drop a `LICENSE` next to it.

## Compatibility

Tested against:

- This repo's `utils/browser-print-shim.py` (Linux dev shim — implements
  the same protocol).
- Zebra's official Browser Print helper on Windows (via the prototype
  in `app/browser-print.html`, which exercises the same endpoints).

The wire format hasn't changed across Browser Print SDK versions
3.0.x → 3.1.x (the only published Zebra SDK versions in 2020-2026).
If Zebra ships a 4.x with a new protocol, this file would need an
update.
