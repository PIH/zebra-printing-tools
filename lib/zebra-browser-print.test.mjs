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
  ZBP.setHelperBaseUrl('http://test-helper:9100');  // restore for following tests if any
});

// ---------- summary ----------

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
