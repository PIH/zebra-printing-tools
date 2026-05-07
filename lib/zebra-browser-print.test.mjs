/*
 * Node tests for zebra-browser-print.js. Run with:
 *
 *     node lib/zebra-browser-print.test.mjs
 *
 * No deps — uses Node's built-in test reporter via console.log + a
 * tiny assert wrapper. Mocks `globalThis.fetch` so each test verifies
 * the wire format directly (URL, method, body) without needing a
 * running Browser Print helper or our shim.
 *
 * SPDX-License-Identifier: MPL-2.0
 */

import './zebra-browser-print.js';

const ZBP = globalThis.ZebraBrowserPrint;
ZBP.setHelperBaseUrl('http://test-helper:9100');

// ---------- tiny test harness ----------

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error('assert failed: ' + msg);
}
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error((msg || 'mismatch') + ': expected ' + e + ', got ' + a);
}
async function test(name, fn) {
  try {
    await fn();
    console.log('  PASS  ' + name);
    passed++;
  } catch (e) {
    console.log('  FAIL  ' + name + ' — ' + e.message);
    failed++;
  }
}

// ---------- fetch mock ----------

let fetchCalls = [];

function mockFetch(responseFn) {
  fetchCalls = [];
  globalThis.fetch = async function (url, opts) {
    const call = { url, method: (opts && opts.method) || 'GET', headers: (opts && opts.headers) || {}, body: opts && opts.body };
    fetchCalls.push(call);
    const r = await responseFn(call);
    return {
      ok: (r.status >= 200 && r.status < 300),
      status: r.status,
      text: async () => r.body || '',
    };
  };
}

// ---------- tests ----------

console.log('zebra-browser-print.js tests');

await test('getApplicationConfiguration → GET /config', async () => {
  mockFetch(() => ({ status: 200, body: JSON.stringify({ version: '1.2.3', api_level: 4 }) }));
  const cfg = await ZBP.getApplicationConfiguration();
  assertEqual(cfg, { version: '1.2.3', api_level: 4 }, 'parsed config');
  assertEqual(fetchCalls.length, 1);
  assertEqual(fetchCalls[0].url, 'http://test-helper:9100/config');
  assertEqual(fetchCalls[0].method, 'GET');
  assert(!fetchCalls[0].body, 'no body on GET');
});

await test('getDefaultDevice("printer") → GET /default?type=printer', async () => {
  mockFetch(() => ({ status: 200, body: JSON.stringify({
    uid: 'usb:GX430t-12345', name: 'Lab GX430t', deviceType: 'printer',
    connection: 'usb', manufacturer: 'Zebra Technologies',
  }) }));
  const d = await ZBP.getDefaultDevice('printer');
  assertEqual(fetchCalls[0].url, 'http://test-helper:9100/default?type=printer');
  assert(d instanceof ZBP.Device, 'returns a Device');
  assertEqual(d.uid, 'usb:GX430t-12345');
  assertEqual(d.name, 'Lab GX430t');
  assertEqual(d.connection, 'usb');
});

await test('getDefaultDevice → null when helper returns empty body', async () => {
  mockFetch(() => ({ status: 200, body: '' }));
  const d = await ZBP.getDefaultDevice('printer');
  assertEqual(d, null);
});

await test('getDefaultDevice → null when uid missing (Windows non-Zebra default)', async () => {
  // Helper on Windows can return {name: 'HP DeskJet'} with no uid when
  // the OS default printer is non-Zebra. SDK can't address it.
  mockFetch(() => ({ status: 200, body: JSON.stringify({ name: 'HP DeskJet' }) }));
  const d = await ZBP.getDefaultDevice('printer');
  assertEqual(d, null);
});

await test('getLocalDevices → GET /available, returns Device[]', async () => {
  mockFetch(() => ({ status: 200, body: JSON.stringify({
    printer: [
      { uid: 'usb:A', name: 'Printer A', deviceType: 'printer', connection: 'usb' },
      { uid: 'net:1.2.3.4:9100', name: 'Net B', deviceType: 'printer', connection: 'network' },
      { name: 'no-uid' },  // dropped
    ],
    scale: [{ uid: 'scale:X', deviceType: 'scale' }],  // filtered out by type='printer'
  }) }));
  const devices = await ZBP.getLocalDevices('printer');
  assertEqual(fetchCalls[0].url, 'http://test-helper:9100/available');
  assertEqual(devices.length, 2);
  assertEqual(devices[0].uid, 'usb:A');
  assertEqual(devices[1].uid, 'net:1.2.3.4:9100');
});

await test('getLocalDevices() with no type returns all groups', async () => {
  mockFetch(() => ({ status: 200, body: JSON.stringify({
    printer: [{ uid: 'usb:A' }],
    scale:   [{ uid: 'scale:X' }],
  }) }));
  const devices = await ZBP.getLocalDevices();
  assertEqual(devices.length, 2);
});

await test('device.send(zpl) → POST /write with {device, data}', async () => {
  let postBody = null;
  mockFetch((call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'usb:A', name: 'A', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/write')) {
      postBody = JSON.parse(call.body);
      return { status: 200, body: '' };
    }
    return { status: 404, body: '' };
  });
  const d = await ZBP.getDefaultDevice('printer');
  await d.send('^XA^FDhi^FS^XZ');
  const write = fetchCalls[fetchCalls.length - 1];
  assertEqual(write.url, 'http://test-helper:9100/write');
  assertEqual(write.method, 'POST');
  assertEqual(write.headers['Content-Type'], 'application/json');
  assertEqual(postBody.data, '^XA^FDhi^FS^XZ');
  assertEqual(postBody.device.uid, 'usb:A');
  // Echoes full device JSON (helper distinguishes wire variants by full record).
  assert(postBody.device.deviceType === 'printer');
});

await test('device.send(non-string) throws', async () => {
  mockFetch(() => ({ status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) }));
  const d = await ZBP.getDefaultDevice('printer');
  let threw = false;
  try { await d.send(new Uint8Array([0x5e, 0x58, 0x41])); } catch (e) { threw = true; }
  assert(threw, 'should reject non-string data');
});

await test('device.read() → POST /read, returns body text', async () => {
  mockFetch((call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/read')) {
      return { status: 200, body: '\x02PRINTER READY\x03' };
    }
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  const reply = await d.read();
  assertEqual(reply, '\x02PRINTER READY\x03');
});

await test('non-2xx response throws with status + body in message', async () => {
  mockFetch(() => ({ status: 500, body: 'something went wrong' }));
  let threw;
  try { await ZBP.getApplicationConfiguration(); }
  catch (e) { threw = e; }
  assert(threw, 'should throw');
  assert(/500/.test(threw.message), 'message includes status');
  assert(/something went wrong/.test(threw.message), 'message includes body');
});

await test('sendAndRead drains multi-frame reply until quiet', async () => {
  // Simulate a ~hs-style three-frame reply: helper buffers chunks
  // arriving over ~50 ms each, with subsequent /read calls returning
  // empty until idleQuietMs elapses.
  let readCallCount = 0;
  mockFetch((call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/write')) return { status: 200, body: '' };
    if (call.url.endsWith('/read')) {
      readCallCount++;
      if (readCallCount === 1) return { status: 200, body: '\x02FRAME1\x03' };
      if (readCallCount === 2) return { status: 200, body: '\x02FRAME2\x03' };
      if (readCallCount === 3) return { status: 200, body: '\x02FRAME3\x03' };
      return { status: 200, body: '' };  // printer's gone quiet
    }
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  const reply = await d.sendAndRead('~hs', { pollIntervalMs: 20, idleQuietMs: 50, hardCapMs: 1000 });
  assertEqual(reply, '\x02FRAME1\x03\x02FRAME2\x03\x02FRAME3\x03');
  // 3 reads with content + at least 1 empty-read to confirm quiet.
  assert(readCallCount >= 4, 'expected at least 4 reads, got ' + readCallCount);
});

await test('sendAndRead hard-caps when printer never replies', async () => {
  mockFetch((call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/write')) return { status: 200, body: '' };
    if (call.url.endsWith('/read'))  return { status: 200, body: '' };  // forever empty
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  const t0 = Date.now();
  const reply = await d.sendAndRead('~hs', { pollIntervalMs: 30, idleQuietMs: 100, hardCapMs: 200 });
  const dt = Date.now() - t0;
  assertEqual(reply, '');
  assert(dt >= 200 && dt < 500, 'should hard-cap around 200ms, got ' + dt);
});

await test('setHelperBaseUrl strips trailing slashes', async () => {
  ZBP.setHelperBaseUrl('https://other-helper:9999/');
  assertEqual(ZBP.getHelperBaseUrl(), 'https://other-helper:9999');
  ZBP.setHelperBaseUrl('http://test-helper:9100');  // restore for following tests
});

// =====================================================================
// Phase 2: convertAndSendFile, Printer wrapper, parsers
// =====================================================================

console.log('');
console.log('Phase 2 — convertAndSendFile');

await test('convertAndSendFile posts multipart/form-data to /convert', async () => {
  let convertCall = null;
  mockFetch((call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', name: 'A', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/convert')) {
      convertCall = call;
      return { status: 200, body: '' };
    }
    return { status: 404, body: '' };
  });
  const d = await ZBP.getDefaultDevice('printer');
  const blob = new Blob(['%PDF-1.4 fake'], { type: 'application/pdf' });
  await d.convertAndSendFile(blob, { keys: { pdf: 'AbsQ-key' } });
  assert(convertCall, 'helper /convert must be called');
  assertEqual(convertCall.method, 'POST');
  assert(convertCall.body instanceof FormData, 'body should be FormData');
  const json = JSON.parse(convertCall.body.get('json'));
  assertEqual(json.options.action, 'print');
  assertEqual(json.options.fromFormat, 'pdf');
  assertEqual(json.options.keys, { pdf: 'AbsQ-key' });
  assertEqual(json.device.uid, 'u');
  const blobOut = convertCall.body.get('blob');
  assert(blobOut instanceof Blob, 'blob should be a Blob');
  assertEqual(blobOut.type, 'application/pdf');
});

await test('convertAndSendFile derives fromFormat from MIME (image/x-ms-bmp → bmp)', async () => {
  let convertCall = null;
  mockFetch((call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/convert')) {
      convertCall = call;
      return { status: 200, body: '' };
    }
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  await d.convertAndSendFile(new Blob([new Uint8Array([0x42, 0x4D])], { type: 'image/x-ms-bmp' }));
  const json = JSON.parse(convertCall.body.get('json'));
  assertEqual(json.options.fromFormat, 'bmp');
});

await test('convertAndSendFile preserves explicit options.fromFormat', async () => {
  let convertCall = null;
  mockFetch((call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/convert')) {
      convertCall = call;
      return { status: 200, body: '' };
    }
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  // Untyped blob — caller forces fromFormat manually.
  await d.convertAndSendFile(new Blob(['stuff']), { fromFormat: 'pdf', action: 'return' });
  const json = JSON.parse(convertCall.body.get('json'));
  assertEqual(json.options.fromFormat, 'pdf');
  assertEqual(json.options.action, 'return');
});

await test('convertAndSendFile parses JSON response when helper returns one', async () => {
  mockFetch((call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/convert')) {
      return { status: 200, body: JSON.stringify({ data: '^XA...^XZ' }) };
    }
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  const result = await d.convertAndSendFile(new Blob(['x'], { type: 'application/pdf' }),
    { action: 'return' });
  assertEqual(result, { data: '^XA...^XZ' });
});

await test('convertAndSendFile rejects non-Blob argument', async () => {
  mockFetch(() => ({ status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) }));
  const d = await ZBP.getDefaultDevice('printer');
  let threw = false;
  try { await d.convertAndSendFile('not a blob'); } catch (e) { threw = true; }
  assert(threw, 'should reject non-Blob');
});

console.log('');
console.log('Phase 2 — status parser');

await test('parseStatusResponse: ready printer (3 valid frames)', () => {
  // frame1: aaa,b,c,dddd,eee,f,g,h,iii,j,k,l → all OK
  //   commIfc=000, paperOut=0, paused=0, labelLength=1240, ...
  // frame2: mmm,n,o,p,q,r,s,t,uuuuuuuu,v,w
  //   funcSet=001, _, headOpen=0, ribbonOut=0, thermal=0, printMode=0, ...
  const raw = '\x02000,0,0,1240,000,0,0,0,000,0,0,0\x03'
            + '\x02001,0,0,0,0,0,0,0,00000000,0,002\x03'
            + '\x020000,0\x03';
  const st = ZBP._parseStatusResponse(raw);
  assert(!st.offline);
  assert(st.isPrinterReady());
  assertEqual(st.getMessage(), 'Ready');
  assertEqual(st.labelLength, 1240);
  assertEqual(st.fontsInGraphicMemory, 2);
});

await test('parseStatusResponse: paper out → not ready, message says Paper out', () => {
  const raw = '\x02000,1,0,1240,000,0,0,0,000,0,0,0\x03'
            + '\x02001,0,0,0,0,0,0,0,00000000,0,002\x03'
            + '\x020000,0\x03';
  const st = ZBP._parseStatusResponse(raw);
  assert(!st.isPrinterReady());
  assert(st.paperOut);
  assertEqual(st.getMessage(), 'Paper out');
});

await test('parseStatusResponse: head open → not ready (frame 2 flag)', () => {
  const raw = '\x02000,0,0,1240,000,0,0,0,000,0,0,0\x03'
            + '\x02001,0,1,0,0,0,0,0,00000000,0,002\x03'
            + '\x020000,0\x03';
  const st = ZBP._parseStatusResponse(raw);
  assert(!st.isPrinterReady());
  assert(st.headOpen);
  assertEqual(st.getMessage(), 'Print head open');
});

await test('parseStatusResponse: short read (<3 frames) → offline=true', () => {
  // Common cause: read returned only the first frame before the others
  // arrived. The page treats this as transient and retries.
  const raw = '\x02000,0,0,1240\x03';
  const st = ZBP._parseStatusResponse(raw);
  assert(st.offline);
  assert(!st.isPrinterReady());
  assert(/malformed/.test(st.getMessage()));
});

await test('parseStatusResponse: empty input → offline', () => {
  const st = ZBP._parseStatusResponse('');
  assert(st.offline);
});

console.log('');
console.log('Phase 2 — config parser');

await test('parseConfigResponse: real ^HH dump → printWidth/labelLength/firmware/settings', () => {
  // Excerpted real GX430t output. Right-aligned label, value to the left.
  const raw =
      '\r\n   PRINTER CONFIGURATION\r\n'
    + '+10.0                  DARKNESS\r\n'
    + '4 IPS                  PRINT SPEED\r\n'
    + ' 832                   PRINT WIDTH\r\n'
    + '1240                   LABEL LENGTH\r\n'
    + ' 832 8/MM FULL         RESOLUTION\r\n'
    + '6.0  6.0.5 <-          FIRMWARE\r\n'
    + '6.0  6.0.5 <-          LINK-OS VERSION\r\n';
  const cfg = ZBP._parseConfigResponse(raw);
  assertEqual(cfg.printWidth, 832);
  assertEqual(cfg.labelLength, 1240);
  // Trailing ` <-` is Zebra's "currently in use" marker — kept verbatim.
  assertEqual(cfg.firmwareVersion, '6.0  6.0.5 <-');
  assertEqual(cfg.linkOSVersion,   '6.0  6.0.5 <-');
  assertEqual(cfg.settings['RESOLUTION'], '832 8/MM FULL');
  assertEqual(cfg.settings['DARKNESS'], '+10.0');
});

await test('parseConfigResponse: skips lines without label-on-right pattern', () => {
  const raw = 'PRINTER CONFIGURATION\r\n'
            + 'no big spacing here just one\r\n'  // no >=2-space gap
            + ' 832                   PRINT WIDTH\r\n';
  const cfg = ZBP._parseConfigResponse(raw);
  assertEqual(cfg.printWidth, 832);
  assert(!('PRINTER CONFIGURATION' in cfg.settings));
});

console.log('');
console.log('Phase 2 — info parser');

await test('parseInfoResponse: STX-framed CSV → model + firmware + dpm', () => {
  // Real shape from a GX430t. The model field carries the dpi suffix
  // used as a final dpi-detection fallback by the prototype.
  const raw = '\x02ZTC GX430t-300dpi-ZPL,V41.16.5,12,1024KB,XML,N,0\x03';
  const info = ZBP._parseInfoResponse(raw);
  assertEqual(info.model, 'ZTC GX430t-300dpi-ZPL');
  assertEqual(info.firmware, 'V41.16.5');
  assertEqual(info.dpm, 12);
});

await test('parseInfoResponse: tolerates missing framing', () => {
  const info = ZBP._parseInfoResponse('ZTC ZD420T-203dpi,V72.20.0,8');
  assertEqual(info.model, 'ZTC ZD420T-203dpi');
  assertEqual(info.dpm, 8);
});

console.log('');
console.log('Phase 2 — SGD parser');

await test('parseSGDResponse: STX-framed quoted → unwrapped', () => {
  assertEqual(ZBP._parseSGDResponse('\x02"300"\x03'), '300');
});

await test('parseSGDResponse: bare quoted → unwrapped', () => {
  assertEqual(ZBP._parseSGDResponse('"300"'), '300');
});

await test('parseSGDResponse: unquoted → unchanged after trim', () => {
  assertEqual(ZBP._parseSGDResponse('300'), '300');
});

await test('parseSGDResponse: empty quotes → empty string', () => {
  assertEqual(ZBP._parseSGDResponse('""'), '');
});

console.log('');
console.log('Phase 2 — Printer wrapper');

await test('Printer.getStatus sends ~hs and parses', async () => {
  const writes = [];
  let readCall = 0;
  mockFetch((call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/write')) {
      writes.push(JSON.parse(call.body).data);
      return { status: 200, body: '' };
    }
    if (call.url.endsWith('/read')) {
      readCall++;
      if (readCall === 1) {
        return { status: 200, body:
          '\x02000,0,0,1240,000,0,0,0,000,0,0,0\x03'
        + '\x02001,0,0,0,0,0,0,0,00000000,0,002\x03'
        + '\x020000,0\x03' };
      }
      return { status: 200, body: '' };
    }
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  const printer = new ZBP.Printer(d);
  const status = await printer.getStatus();
  assertEqual(writes.length, 1);
  assertEqual(writes[0], '~hs\r\n');
  assert(status.isPrinterReady());
});

await test('Printer.getConfiguration sends ^XA^HH^XZ and parses', async () => {
  const writes = [];
  let readCall = 0;
  mockFetch((call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/write')) {
      writes.push(JSON.parse(call.body).data);
      return { status: 200, body: '' };
    }
    if (call.url.endsWith('/read')) {
      readCall++;
      if (readCall === 1) {
        return { status: 200, body:
            ' 832                   PRINT WIDTH\r\n'
          + '1240                   LABEL LENGTH\r\n'
          + '6.0  6.0.5 <-          FIRMWARE\r\n' };
      }
      return { status: 200, body: '' };
    }
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  const printer = new ZBP.Printer(d);
  const cfg = await printer.getConfiguration();
  assertEqual(writes[0], '^XA^HH^XZ');
  assertEqual(cfg.printWidth, 832);
  assertEqual(cfg.labelLength, 1240);
  assertEqual(cfg.firmwareVersion, '6.0  6.0.5 <-');
});

await test('Printer.getInfo sends ~hi and parses model', async () => {
  const writes = [];
  let readCall = 0;
  mockFetch((call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/write')) {
      writes.push(JSON.parse(call.body).data);
      return { status: 200, body: '' };
    }
    if (call.url.endsWith('/read')) {
      readCall++;
      if (readCall === 1) return { status: 200, body: '\x02ZTC GX430t-300dpi,V1.0,12\x03' };
      return { status: 200, body: '' };
    }
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  const info = await new ZBP.Printer(d).getInfo();
  assertEqual(writes[0], '~hi\r\n');
  assertEqual(info.model, 'ZTC GX430t-300dpi');
});

await test('Printer.getSGD sends `! U1 getvar "name"` and unwraps quoted reply', async () => {
  const writes = [];
  let readCall = 0;
  mockFetch((call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/write')) {
      writes.push(JSON.parse(call.body).data);
      return { status: 200, body: '' };
    }
    if (call.url.endsWith('/read')) {
      readCall++;
      if (readCall === 1) return { status: 200, body: '"300"' };
      return { status: 200, body: '' };
    }
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  const value = await new ZBP.Printer(d).getSGD('head.resolution.in_dpi');
  assertEqual(writes[0], '! U1 getvar "head.resolution.in_dpi"\r\n');
  assertEqual(value, '300');
});

await test('Printer constructor rejects non-Device', async () => {
  let threw = false;
  try { new ZBP.Printer({}); } catch (e) { threw = true; }
  assert(threw, 'should reject plain object');
});

// =====================================================================
// Per-Device queue (regression — see decision-log entry 42)
// =====================================================================

console.log('');
console.log('Per-Device queue');

await test('concurrent send/read calls serialise — bytes do not interleave', async () => {
  // Without the queue, two concurrent sendAndRead calls would each
  // /write and then /read, racing for the buffered reply. The shim's
  // ThreadingHTTPServer also lets two /read requests grab whichever
  // bytes happen to be in the buffer at that moment, splitting one
  // query's reply across the two callers. With the queue, op B can't
  // start before op A is fully done.
  //
  // We assert serialisation by tracking start/end timestamps of every
  // /write and /read on the wire and verifying every /write happens
  // strictly after the previous op's last /read.
  const events = [];   // [{op, t}, ...]
  let readCounter = 0;
  mockFetch(async (call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/write')) {
      events.push({ op: 'write', t: Date.now(), data: JSON.parse(call.body).data });
      // Slow /write to widen the window concurrent ops would interleave in.
      await new Promise(r => setTimeout(r, 30));
      return { status: 200, body: '' };
    }
    if (call.url.endsWith('/read')) {
      readCounter++;
      // Reply only on the first /read after each write; subsequent
      // reads return empty so sendAndRead drains and exits.
      const isFirstReadAfterWrite = events[events.length - 1] &&
        events[events.length - 1].op === 'write';
      events.push({ op: 'read', t: Date.now() });
      if (isFirstReadAfterWrite) return { status: 200, body: 'REPLY-' + readCounter };
      return { status: 200, body: '' };
    }
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  // Fire three concurrent queries — same shape as the prototype's
  // detectPrinterCapabilities does with Promise.allSettled.
  const results = await Promise.all([
    d.sendAndRead('CMD-A', { pollIntervalMs: 10, idleQuietMs: 30, hardCapMs: 500 }),
    d.sendAndRead('CMD-B', { pollIntervalMs: 10, idleQuietMs: 30, hardCapMs: 500 }),
    d.sendAndRead('CMD-C', { pollIntervalMs: 10, idleQuietMs: 30, hardCapMs: 500 }),
  ]);
  // Each call must have got SOME reply (not empty / not interleaved).
  for (let i = 0; i < results.length; i++) {
    assert(results[i].startsWith('REPLY-'),
      'result[' + i + '] = ' + JSON.stringify(results[i]) + ' does not look like a reply');
  }
  // Wire ordering must be: writeA, read*, writeB, read*, writeC, read*.
  // (Not: writeA, writeB, writeC, read*, read*, read*.)
  const writes = events.filter(e => e.op === 'write').map(e => e.data);
  assertEqual(writes, ['CMD-A', 'CMD-B', 'CMD-C']);
  const writeIndices = events
    .map((e, i) => ({ e, i }))
    .filter(x => x.e.op === 'write')
    .map(x => x.i);
  // Between writeA (index 0) and writeB there must be at least one /read,
  // and same between writeB and writeC. Otherwise the writes overlapped.
  assert(writeIndices[1] - writeIndices[0] >= 2, 'writes A and B were back-to-back');
  assert(writeIndices[2] - writeIndices[1] >= 2, 'writes B and C were back-to-back');
});

await test('queue keeps running after an op throws', async () => {
  // Op B must run even if op A throws — otherwise a single failed
  // query would freeze the queue for the rest of the page's lifetime.
  let writeBSeen = false;
  mockFetch(async (call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/write')) {
      const body = JSON.parse(call.body);
      if (body.data === 'WILL-FAIL') return { status: 500, body: 'simulated failure' };
      if (body.data === 'WILL-SUCCEED') {
        writeBSeen = true;
        return { status: 200, body: '' };
      }
    }
    if (call.url.endsWith('/read')) return { status: 200, body: '' };
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  const a = d.send('WILL-FAIL');
  const b = d.send('WILL-SUCCEED');
  let aThrew = false;
  try { await a; } catch (e) { aThrew = true; }
  await b;
  assert(aThrew, 'first op should have thrown');
  assert(writeBSeen, 'second op should have run despite first op failing');
});

await test('queue serialises across send/read/sendAndRead/convertAndSendFile', async () => {
  // The queue is op-level — every public method shares one slot.
  // Mixed concurrent calls (e.g. a sendAndRead followed by a raw
  // device.read in the diag panel) must still serialise.
  const order = [];
  mockFetch(async (call) => {
    if (call.url.endsWith('/default?type=printer')) {
      return { status: 200, body: JSON.stringify({ uid: 'u', deviceType: 'printer' }) };
    }
    if (call.url.endsWith('/write')) {
      const data = JSON.parse(call.body).data;
      order.push('write:' + data);
      await new Promise(r => setTimeout(r, 20));
      return { status: 200, body: '' };
    }
    if (call.url.endsWith('/read'))    { order.push('read');    return { status: 200, body: '' }; }
    if (call.url.endsWith('/convert')) { order.push('convert'); return { status: 200, body: '' }; }
    return { status: 404 };
  });
  const d = await ZBP.getDefaultDevice('printer');
  const blob = new Blob(['x'], { type: 'application/pdf' });
  await Promise.all([
    d.send('SEND'),
    d.read(),
    d.sendAndRead('SAR', { pollIntervalMs: 5, idleQuietMs: 15, hardCapMs: 200 }),
    d.convertAndSendFile(blob),
  ]);
  // Order should reflect issue order: write:SEND, read, write:SAR + reads, convert.
  // We only assert that no two ops' wire calls interleave — i.e. the
  // first 'write:SEND' is followed by exactly the next op's wire calls,
  // not by a different op's first call.
  assertEqual(order[0], 'write:SEND');
  assertEqual(order[1], 'read');
  assertEqual(order[2], 'write:SAR');
  // After SAR's write there are some reads (drain), then convert last.
  assertEqual(order[order.length - 1], 'convert');
});

// ---------- summary ----------

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
