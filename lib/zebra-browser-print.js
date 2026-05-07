/*!
 * zebra-browser-print.js — minimal Zebra Browser Print client
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2026 Partners In Health.
 * Co-authored by Anthropic Claude.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

/*
 * Vanilla-JS client for Zebra Browser Print's localhost HTTP API.
 *
 * Drop-in replacement for the proprietary BrowserPrint-3.x.min.js +
 * BrowserPrint-Zebra-1.x.min.js SDK files for the subset of operations
 * a typical label-printing webapp needs: discovery + raw-byte send +
 * read + status-style query (send + drain-until-quiet).
 *
 * INCLUDED
 *   Discovery & helper config
 *     ZebraBrowserPrint.getApplicationConfiguration()     GET  /config
 *     ZebraBrowserPrint.getDefaultDevice(type)            GET  /default?type=...
 *     ZebraBrowserPrint.getLocalDevices(type)             GET  /available
 *
 *   Per-Device (low-level transport)
 *     device.send(data: string)                           POST /write
 *     device.read(): Promise<string>                      POST /read
 *     device.sendAndRead(data, opts?): Promise<string>    send + drain-until-quiet
 *     device.convertAndSendFile(blob, options?)           POST /convert (multipart)
 *
 *   Per-Printer (high-level, parsed responses) — wraps a Device:
 *     new ZebraBrowserPrint.Printer(device)
 *     printer.getStatus(): Promise<Status>                ~hs        → ready/paused/etc.
 *     printer.getConfiguration(): Promise<Configuration>  ^XA^HH^XZ  → printWidth/labelLength/firmware
 *     printer.getInfo(): Promise<Info>                    ~hi        → model/firmware/dpm
 *     printer.getSGD(name): Promise<string>               ! U1 getvar"name"
 *
 * NOT INCLUDED (deliberately)
 *   - getConvertedResource (PDF→ZPL returning ZPL to the caller). The
 *     prototype this lib was written against migrated to the
 *     action="print" path with `fitTo`; getConvertedResource without
 *     `fitTo` doesn't scale uploaded PDFs to label dimensions and the
 *     use case faded. Add as a ~10-line wrapper if you need it.
 *   - Per-printer command queue. The proprietary SDK serialises every
 *     send/read on a Printer instance; this client trusts the caller to
 *     await each promise (or to await Promise.all when concurrency is
 *     OK) since most callers only have one operation in flight at a
 *     time anyway.
 *   - Promise/callback dual API. Promise-only.
 *
 * WIRE PROTOCOL is the same one Zebra's official Java helper exposes on
 * 127.0.0.1:9100 (HTTP) / 127.0.0.1:9101 (HTTPS). A working server-side
 * implementation lives at utils/browser-print-shim.py in this repo —
 * read its handle_* methods if you want a second source on shapes.
 *
 * USAGE (script tag)
 *   <script src="zebra-browser-print.js"></script>
 *   <script>
 *     (async () => {
 *       const printer = await ZebraBrowserPrint.getDefaultDevice('printer');
 *       if (!printer) throw new Error('No printer registered with Browser Print');
 *       await printer.send('^XA^FO50,50^A0N,30,30^FDHello^FS^XZ');
 *     })();
 *   </script>
 *
 * USAGE (ESM)
 *   import './zebra-browser-print.js';            // attaches to globalThis
 *   const printer = await globalThis.ZebraBrowserPrint.getDefaultDevice('printer');
 *
 * USAGE (Node tests — see zebra-browser-print.test.mjs)
 *   import './zebra-browser-print.js';
 *   const ZBP = globalThis.ZebraBrowserPrint;
 *   ZBP.setHelperBaseUrl('http://127.0.0.1:9999');  // point at a fake/mock
 */

;(function () {
  'use strict';

  // Browser Print's Java helper binds 9100 (HTTP) and 9101 (HTTPS) on
  // 127.0.0.1, with SO_EXCLUSIVEADDRUSE on Windows. The page picks the
  // matching transport based on its own protocol — mixed-content rules
  // forbid HTTP fetches from an HTTPS page anyway. The 9101 endpoint
  // uses a self-signed cert that the browser prompts the user to accept
  // once per origin.
  let HELPER_BASE =
    (typeof location !== 'undefined' && location.protocol === 'https:')
      ? 'https://127.0.0.1:9101'
      : 'http://127.0.0.1:9100';

  // ---------- transport ----------

  // Build a fetch + read text body. Throws on non-2xx with the body
  // included so failures are diagnosable from the message alone.
  async function _request(method, path, jsonBody) {
    const opts = { method, headers: {} };
    if (jsonBody !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(jsonBody);
    }
    const r = await fetch(HELPER_BASE + path, opts);
    const text = await r.text();
    if (!r.ok) {
      throw new Error(
        'Browser Print helper ' + method + ' ' + path +
        ' returned ' + r.status + ': ' + text
      );
    }
    return text;
  }

  async function _requestJson(method, path, jsonBody) {
    const text = await _request(method, path, jsonBody);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(
        'Browser Print helper ' + path +
        ' returned non-JSON body: ' + text.slice(0, 200)
      );
    }
  }

  // ---------- Device ----------

  class Device {
    constructor(json) {
      // Helper's Device record. uid is required for routing /write and
      // /read; everything else is descriptive (shown in pickers, used
      // for human-readable logs). We keep the original JSON in _json to
      // echo back to /write and /read — Zebra's helper distinguishes
      // certain protocol variants by fields beyond uid.
      this.uid          = json.uid;
      this.name         = json.name || '';
      this.deviceType   = json.deviceType || 'printer';
      this.connection   = json.connection || '';
      this.manufacturer = json.manufacturer || '';
      this.provider     = json.provider || '';
      this.version      = json.version;
      this._json        = json;

      // Per-Device serialization. Concurrent calls to send / read /
      // sendAndRead / convertAndSendFile on the same Device queue here
      // so only one operation is on the wire at a time.
      //
      // Without this, two callers can interleave their bytes — a
      // parallel ~hs and ~hi over the same /write+/read pair lets each
      // /read race for the buffered reply. Symptom: query A's response
      // gets parsed against query B's parser, producing nonsense (e.g.
      // status frame fields landing in the model field of an info
      // parser). Decision-log entry 28 documents the case where the
      // prototype's detectPrinterCapabilities fires three queries via
      // Promise.allSettled assuming the SDK serialises them.
      //
      // The proprietary Browser Print SDK has the same queue, on the
      // Printer wrapper. We put it on Device so raw `device.send`/
      // `device.read` from outside any Printer (e.g. a diagnostic page)
      // also benefits.
      this._queue = Promise.resolve();
    }

    // Schedules `op` after every previously-enqueued op. Errors don't
    // break the chain — the next op fires either way (otherwise a
    // single failed query would freeze the queue forever).
    _enqueue(op) {
      const result = this._queue.then(op, op);
      this._queue = result.catch(function () {});
      return result;
    }

    // Send ZPL (or any printer-language string) to the device.
    // Resolves once the helper has accepted the bytes — NOT once the
    // printer has finished printing.
    async send(data) {
      return this._enqueue(() => this._sendImpl(data));
    }

    async _sendImpl(data) {
      if (typeof data !== 'string') {
        throw new TypeError(
          'Device.send() expects a string. For binary, encode as ZPL ^GF/^DG ' +
          'hex/B64 or send via convertAndSendFile (not in this client).'
        );
      }
      await _request('POST', '/write', { device: this._json, data });
    }

    // Read whatever bytes the helper currently has buffered for this
    // device. May return '' if the printer hasn't replied yet — for
    // status / config queries that return multiple frames, prefer
    // sendAndRead() which drains until the printer goes quiet.
    async read() {
      return this._enqueue(() => this._readImpl());
    }

    async _readImpl() {
      return await _request('POST', '/read', { device: this._json });
    }

    // Send a query command and drain the reply until the printer is
    // quiet (no new bytes for `idleQuietMs`) or `hardCapMs` elapses.
    //
    // The proprietary SDK calls this `sendThenReadAllAvailable` and
    // recurses without delay until /read is empty; that pattern races
    // with multi-frame replies (~hs returns three STX/ETX frames a few
    // ms apart, the first /read often only catches the first frame
    // before the others arrive). We poll instead — see decision-log
    // entry 17 in this repo for the diagnosis.
    //
    // Defaults: poll every 100 ms, stop after 150 ms of empty replies,
    // hard cap 1500 ms total. Tune via opts for slow links / slow
    // commands.
    async sendAndRead(data, opts) {
      return this._enqueue(() => this._sendAndReadImpl(data, opts));
    }

    async _sendAndReadImpl(data, opts) {
      opts = opts || {};
      const pollIntervalMs = opts.pollIntervalMs || 100;
      const idleQuietMs    = opts.idleQuietMs    || 150;
      const hardCapMs      = opts.hardCapMs      || 1500;

      // Use the unqueued impls — we already hold the queue slot for
      // this whole sendAndRead. Calling this.send / this.read here
      // would re-enqueue and deadlock waiting for ourselves.
      await this._sendImpl(data);

      let buffer = '';
      let lastDataAt = Date.now();
      const startedAt = lastDataAt;
      while (true) {
        await new Promise(function (r) { setTimeout(r, pollIntervalMs); });
        const chunk = await this._readImpl();
        if (chunk) {
          buffer += chunk;
          lastDataAt = Date.now();
        }
        const now = Date.now();
        // Quiet for long enough AND we have something → done.
        if (buffer && (now - lastDataAt) > idleQuietMs) break;
        // Hard cap regardless — covers the "printer never replied" case
        // (offline / wrong command / wrong query). Caller sees an empty
        // string and treats it as a timeout.
        if ((now - startedAt) > hardCapMs) break;
      }
      return buffer;
    }

    // POST a Blob to the helper's /convert endpoint as multipart/form-data
    // (`json` part with `{options, device}`, `blob` part with the file).
    // Action defaults to "print" — the helper rasterises the file (PDF /
    // PNG / JPEG / etc.) at the printer's native DPI and sends the
    // resulting ZPL straight to the device. Pass `action: "return"` if
    // you want the converted ZPL handed back instead.
    //
    // The licensing key for PDF input MUST be wrapped as
    // `{ keys: { pdf: "<key>" } }` — Zebra's helper looks for
    // `options.keys.<fromFormat>`, NOT a flat `featureKey`. The strings
    // `featureKey` / `licenseKey` / `keys` don't appear anywhere in
    // Zebra's own SDK source; the SDK forwards your options object to
    // the helper verbatim, so any name mismatch is invisible until the
    // helper rejects with "licensing key... none was provided".
    // Verified shape: cagdemo.com/BrowserPrint/test/external/zebra_test.html.
    //
    // Scale-to-label-fit: pass `fitTo: { width: <dots>, height: <dots> }`
    // with the loaded media's dimensions. Zebra's `printImageAsLabel`
    // wrapper auto-derives this from `printer.printWidth/labelLength`,
    // but those are print-HEAD width and last-calibrated length — both
    // can be wrong (wider-head printers, drift). Pass your own.
    async convertAndSendFile(blob, options) {
      return this._enqueue(() => this._convertAndSendFileImpl(blob, options));
    }

    async _convertAndSendFileImpl(blob, options) {
      if (typeof Blob === 'undefined' || !(blob instanceof Blob)) {
        throw new TypeError('convertAndSendFile() expects a Blob (File extends Blob, so File works too)');
      }
      const opts = Object.assign({}, options || {});
      if (!opts.action) opts.action = 'print';
      // The proprietary SDK auto-derives `fromFormat` from the blob's
      // MIME type if it starts with image/ or application/, stripping
      // the prefix and a possible "x-ms-" sub-prefix (e.g.
      // "application/x-ms-bmp" → "bmp"). Mirror that behaviour so
      // callers don't have to set fromFormat themselves for common
      // mimetypes — the helper requires it.
      if (!opts.fromFormat && blob.type) {
        const t = blob.type.toLowerCase();
        if (t.startsWith('image/') || t.startsWith('application/')) {
          opts.fromFormat = t
            .replace('image/', '')
            .replace('application/', '')
            .replace('x-ms-', '');
        }
      }
      const fd = new FormData();
      fd.append('json', JSON.stringify({ options: opts, device: this._json }));
      fd.append('blob', blob);
      const r = await fetch(HELPER_BASE + '/convert', { method: 'POST', body: fd });
      const text = await r.text();
      if (!r.ok) {
        throw new Error(
          'Browser Print helper POST /convert returned ' + r.status + ': ' + text
        );
      }
      // action="print" usually returns 200 with empty body; action="return"
      // returns a JSON envelope ({data: "<zpl>"} on Zebra's helper). Be
      // forgiving — some helper variants return raw text.
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        return text;
      }
    }
  }

  // ---------- ZPL response parsers ----------

  // Status is sent as three STX/ETX-framed records flushed back-to-back:
  //   \x02 frame1 \x03 \x02 frame2 \x03 \x02 frame3 \x03
  // Frame layouts per Zebra ZPL Programming Guide (~hs response):
  //   frame1 = aaa,b,c,dddd,eee,f,g,h,iii,j,k,l
  //   frame2 = mmm,n,o,p,q,r,s,t,uuuuuuuu,v,w
  //   frame3 = xxxx,y                                    (rarely consumed)
  // A short or corrupt read can return fewer than three frames; the
  // proprietary SDK marks that as `offline=true`, callers usually retry
  // a couple times before surfacing it (transient bus-buffer race; see
  // decision-log entry 17). We mirror that flag so retry logic works.
  function parseStatusResponse(raw) {
    const frames = [];
    let i = 0;
    while (i < raw.length) {
      const start = raw.indexOf('\x02', i);
      if (start < 0) break;
      const end = raw.indexOf('\x03', start);
      if (end < 0) break;
      frames.push(raw.slice(start + 1, end));
      i = end + 1;
    }
    if (frames.length < 3) {
      return new Status({ offline: true, raw: raw });
    }
    return new Status({ offline: false, frames: frames });
  }

  class Status {
    constructor(parsed) {
      this.offline = !!parsed.offline;
      if (this.offline) {
        this.raw = parsed.raw;
        return;
      }
      const f1 = (parsed.frames[0] || '').split(',');
      const f2 = (parsed.frames[1] || '').split(',');
      // Frame 1
      this.commInterface         = f1[0];
      this.paperOut              = f1[1] === '1';
      this.paused                = f1[2] === '1';
      this.labelLength           = parseInt(f1[3], 10);
      this.labelsInReceiveBuffer = parseInt(f1[4], 10);
      this.bufferFull            = f1[5] === '1';
      this.commsDiagnosticMode   = f1[6] === '1';
      this.partialFormat         = f1[7] === '1';
      this.corruptRam            = f1[9] === '1';
      this.tempUnder             = f1[10] === '1';
      this.tempOver              = f1[11] === '1';
      // Frame 2
      this.functionSetting        = f2[0];
      this.headOpen               = f2[2] === '1';
      this.ribbonOut              = f2[3] === '1';
      this.thermalTransferMode    = f2[4] === '1';
      this.printMode              = f2[5];
      this.printWidthMode         = f2[6];
      this.labelWaiting           = f2[7] === '1';
      this.labelsRemainingInBatch = parseInt(f2[8], 10);
      this.formatWhilePrinting    = f2[9] === '1';
      this.fontsInGraphicMemory   = parseInt(f2[10], 10);
      // Frame 3 (xxxx password, y static-RAM flag) is rarely consumed.
    }

    isPrinterReady() {
      if (this.offline) return false;
      return !this.paperOut && !this.paused && !this.headOpen
          && !this.ribbonOut && !this.bufferFull
          && !this.tempUnder && !this.tempOver;
    }

    getMessage() {
      if (this.offline)         return 'Status reply was malformed (transient — retry)';
      if (this.paperOut)        return 'Paper out';
      if (this.headOpen)        return 'Print head open';
      if (this.ribbonOut)       return 'Ribbon out';
      if (this.paused)          return 'Paused';
      if (this.tempOver)        return 'Print head over temperature';
      if (this.tempUnder)       return 'Print head under temperature';
      if (this.bufferFull)      return 'Receive buffer full';
      return 'Ready';
    }
  }

  // The ^HH printer-config dump is multi-line text. Each line is
  // "<value>" then >=2 spaces then "<RIGHT-ALIGNED LABEL>". The header
  // line ("PRINTER CONFIGURATION") has no value and is skipped by the
  // pattern. We pre-parse the well-known fields (printWidth, labelLength,
  // firmwareVersion, linkOSVersion) into typed properties; everything
  // else stays in `.settings` keyed by the original right-aligned label.
  //
  // Note: `linkOSVersion` uses the camelCase name the prototype expects
  // (info-card row reads `c.linkOSVersion`); RESOLUTION stays under
  // `.settings.RESOLUTION` so the page's parseDensity can do its
  // dpi-from-dpm extraction unchanged.
  function parseConfigResponse(raw) {
    const settings = {};
    const lines = String(raw).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      // Greedy on the value side `(.+\S)` matters: the FIRMWARE row often
      // has internal double-spaces — "6.0  6.0.5 <-          FIRMWARE" —
      // and a non-greedy match would split at the first `\s{2,}` gap and
      // capture only "6.0" as the value. Greedy + backtracking finds the
      // last `\s{2,}` gap before the right-aligned label, which is what
      // we want.
      //
      // The trailing ` <-` on certain rows (FIRMWARE slot in use, active
      // LINK-OS version, etc.) is Zebra's "currently in use" marker —
      // we keep it in the value verbatim so callers see the same string
      // they'd see in the raw `^HH` dump.
      const m = lines[i].match(/^\s*(.+\S)\s{2,}(\S.*?)\s*$/);
      if (!m) continue;
      const value = m[1].trim();
      const label = m[2].trim();
      if (!value || !label) continue;
      settings[label] = value;
    }
    function asInt(s) {
      if (s == null) return undefined;
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    return {
      printWidth:      asInt(settings['PRINT WIDTH']),
      labelLength:     asInt(settings['LABEL LENGTH']),
      firmwareVersion: settings['FIRMWARE'],
      linkOSVersion:   settings['LINK-OS VERSION'],
      settings:        settings,
    };
  }

  // ~hi reply is a single STX/ETX-framed comma-separated record:
  //   \x02 model, firmware, dotsPerMm, memory, options, cutter, power \x03
  // First field (model) is the most-consumed — it carries the dpi suffix
  // ("ZTC GX430t-300dpi") used as a final dpi-detection fallback.
  function parseInfoResponse(raw) {
    let s = String(raw);
    const stx = s.indexOf('\x02');
    if (stx >= 0) s = s.slice(stx + 1);
    const etx = s.indexOf('\x03');
    if (etx >= 0) s = s.slice(0, etx);
    const fields = s.split(',');
    function asInt(s) {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : undefined;
    }
    return {
      model:    (fields[0] || '').trim(),
      firmware: (fields[1] || '').trim(),
      dpm:      asInt(fields[2]),
      memory:   (fields[3] || '').trim(),
    };
  }

  // SGD getvar reply is the value as a quoted string, sometimes with
  // STX/ETX framing depending on firmware. Strip framing then surrounding
  // double quotes.
  function parseSGDResponse(raw) {
    let s = String(raw).trim();
    if (s.charCodeAt(0) === 0x02) s = s.slice(1);
    if (s.charCodeAt(s.length - 1) === 0x03) s = s.slice(0, -1);
    s = s.trim();
    if (s.length >= 2 && s.charCodeAt(0) === 0x22 && s.charCodeAt(s.length - 1) === 0x22) {
      s = s.slice(1, -1);
    }
    return s.trim();
  }

  // ---------- Printer ----------

  // Promise-based equivalent of the proprietary SDK's `Zebra.Printer`.
  // Wraps a Device and exposes the four query methods the prototype
  // tool's detection cycle uses: getStatus, getConfiguration, getInfo,
  // getSGD. All four go through Device.sendAndRead, so they share its
  // drain-until-quiet semantics; getConfiguration uses an extended hard
  // cap because ^HH dumps are large and slow on first request.
  class Printer {
    constructor(device) {
      if (!(device instanceof Device)) {
        throw new TypeError('Printer requires a Device instance');
      }
      this.device = device;
    }

    async getStatus() {
      const raw = await this.device.sendAndRead('~hs\r\n');
      return parseStatusResponse(raw);
    }

    async getConfiguration() {
      // ^HH is a substantial multi-line dump; ~3-4 KB is typical and the
      // first byte can take ~1.5 s on Windows + Browser Print to arrive.
      // 4000 ms hard cap covers worst case observed in the field.
      const raw = await this.device.sendAndRead('^XA^HH^XZ', { hardCapMs: 4000 });
      return parseConfigResponse(raw);
    }

    async getInfo() {
      const raw = await this.device.sendAndRead('~hi\r\n');
      return parseInfoResponse(raw);
    }

    async getSGD(name) {
      if (typeof name !== 'string' || !name) {
        throw new TypeError('getSGD() requires a non-empty SGD name string');
      }
      // Quoted form is the canonical syntax. Some firmwares accept
      // unquoted but quoted works everywhere.
      const cmd = '! U1 getvar "' + name.replace(/"/g, '\\"') + '"\r\n';
      const raw = await this.device.sendAndRead(cmd);
      return parseSGDResponse(raw);
    }
  }

  // ---------- top-level API ----------

  async function getApplicationConfiguration() {
    return await _requestJson('GET', '/config');
  }

  // Returns null if the helper has no default for the given type. The
  // helper on Windows can also return a partial record with no uid when
  // the OS's default printer is a non-Zebra (e.g. an HP inkjet); the
  // SDK can't address such a record, so we treat it as no-default too.
  async function getDefaultDevice(type) {
    const path = type ? '/default?type=' + encodeURIComponent(type) : '/default';
    const text = await _request('GET', path);
    if (!text) return null;
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(
        'Browser Print helper ' + path +
        ' returned non-JSON body: ' + text.slice(0, 200)
      );
    }
    if (!json || !json.uid) return null;
    return new Device(json);
  }

  // Returns Device[]. With no type filter, returns every registered
  // device across all groups (`printer`, `scale`, etc. — though Browser
  // Print only ships with printers in current versions). Records with
  // no uid are dropped (they can't be addressed via /write or /read
  // anyway).
  async function getLocalDevices(type) {
    const groups = await _requestJson('GET', '/available');
    if (!groups) return [];
    const out = [];
    for (const groupType of Object.keys(groups)) {
      if (type && groupType !== type) continue;
      const list = groups[groupType] || [];
      for (let i = 0; i < list.length; i++) {
        const json = list[i];
        if (!json || !json.uid) continue;
        out.push(new Device(json));
      }
    }
    return out;
  }

  // Override the helper base URL. Useful for tests, dev shims on
  // non-default ports, or pointing at a remote helper for development.
  function setHelperBaseUrl(url) {
    if (typeof url !== 'string' || !url) {
      throw new TypeError('setHelperBaseUrl() expects a non-empty URL string');
    }
    HELPER_BASE = url.replace(/\/+$/, '');
  }

  function getHelperBaseUrl() {
    return HELPER_BASE;
  }

  // ---------- export ----------

  const api = {
    Device: Device,
    Printer: Printer,
    Status: Status,
    getApplicationConfiguration: getApplicationConfiguration,
    getDefaultDevice: getDefaultDevice,
    getLocalDevices: getLocalDevices,
    setHelperBaseUrl: setHelperBaseUrl,
    getHelperBaseUrl: getHelperBaseUrl,
    // Internal — exposed for unit tests against canned ZPL responses.
    _parseStatusResponse: parseStatusResponse,
    _parseConfigResponse: parseConfigResponse,
    _parseInfoResponse:   parseInfoResponse,
    _parseSGDResponse:    parseSGDResponse,
  };

  // Attach to globalThis (works in browsers as window.ZebraBrowserPrint
  // and in Node for testing). Also export as CommonJS / ESM if those
  // environments are present.
  if (typeof globalThis !== 'undefined') globalThis.ZebraBrowserPrint = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
