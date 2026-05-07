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
 *   ZebraBrowserPrint.getApplicationConfiguration()       GET  /config
 *   ZebraBrowserPrint.getDefaultDevice(type)              GET  /default?type=...
 *   ZebraBrowserPrint.getLocalDevices(type)               GET  /available
 *   device.send(data: string)                             POST /write
 *   device.read(): Promise<string>                        POST /read
 *   device.sendAndRead(data, opts?): Promise<string>      send + drain-until-quiet
 *
 * NOT INCLUDED (deliberately, to keep this small + MPL-clean)
 *   - convertAndSendFile / getConvertedResource (PDF→ZPL via the helper).
 *     Most production webapps generate ZPL server-side and don't need
 *     helper-side PDF conversion.
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
    }

    // Send ZPL (or any printer-language string) to the device.
    // Resolves once the helper has accepted the bytes — NOT once the
    // printer has finished printing.
    async send(data) {
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
      opts = opts || {};
      const pollIntervalMs = opts.pollIntervalMs || 100;
      const idleQuietMs    = opts.idleQuietMs    || 150;
      const hardCapMs      = opts.hardCapMs      || 1500;

      await this.send(data);

      let buffer = '';
      let lastDataAt = Date.now();
      const startedAt = lastDataAt;
      while (true) {
        await new Promise(function (r) { setTimeout(r, pollIntervalMs); });
        const chunk = await this.read();
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
    getApplicationConfiguration: getApplicationConfiguration,
    getDefaultDevice: getDefaultDevice,
    getLocalDevices: getLocalDevices,
    setHelperBaseUrl: setHelperBaseUrl,
    getHelperBaseUrl: getHelperBaseUrl,
  };

  // Attach to globalThis (works in browsers as window.ZebraBrowserPrint
  // and in Node for testing). Also export as CommonJS / ESM if those
  // environments are present.
  if (typeof globalThis !== 'undefined') globalThis.ZebraBrowserPrint = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
