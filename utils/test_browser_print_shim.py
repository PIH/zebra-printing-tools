"""Tests for utils/browser-print-shim.py.

Stdlib-only — run with:
    python3 -m unittest utils.test_browser_print_shim
    python3 utils/test_browser_print_shim.py

The shim's filename has a hyphen so we load it via importlib by path.
Each test spins up a ThreadingHTTPServer on port 0 (kernel picks a
free port; never collides with a running shim), registers a MockDevice
in the shim's existing registry, and exercises the HTTP API via
urllib.request.

First committed shim tests; harness is set up to be extended.

SPDX-License-Identifier: MPL-2.0
"""
import importlib.util
import io
import json
import os
import sys
import threading
import unittest
import urllib.request
import urllib.error
import uuid
from http.server import ThreadingHTTPServer

# --- Load the shim as a module ('browser-print-shim.py' has a hyphen) ---

_HERE = os.path.dirname(os.path.abspath(__file__))
_SHIM_PATH = os.path.join(_HERE, 'browser-print-shim.py')
_spec = importlib.util.spec_from_file_location('browser_print_shim', _SHIM_PATH)
shim = importlib.util.module_from_spec(_spec)
sys.modules['browser_print_shim'] = shim
_spec.loader.exec_module(shim)


# --- Mock device that captures writes without touching real hardware ---

class MockDevice(shim.Device):
    """Captures write() calls; reads return pre-seeded bytes."""
    def __init__(self, uid='mock:test:1', name='Mock Zebra', connection='usb'):
        super().__init__(name=name, uid=uid, connection=connection,
                         manufacturer='MockMfr', model='MockModel', serial='S/N-0')
        self.written = []
        self.to_read = b''

    def write(self, data: bytes):
        self.written.append(bytes(data))

    def read(self, max_bytes=8192, timeout=1.0) -> bytes:
        return self.to_read


# --- Base test case: start the shim's HTTP server on port 0 per test ---

class ShimTestCase(unittest.TestCase):
    def setUp(self):
        self.device = MockDevice(uid=f'mock:{uuid.uuid4()}')
        shim.registry.replace([self.device])
        # Port 0 → kernel picks a free port; safe to run alongside a real shim.
        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), shim.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()   # close the listening socket (silences ResourceWarning)
        self.thread.join(timeout=2.0)
        shim.registry.replace([])  # close all and clear

    def url(self, path):
        return f'http://127.0.0.1:{self.port}{path}'

    def get(self, path):
        with urllib.request.urlopen(self.url(path), timeout=5) as r:
            return r.status, r.read()

    def post_json(self, path, payload):
        body = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            self.url(path), data=body, method='POST',
            headers={'Content-Type': 'text/plain;charset=UTF-8'})
        return self._do(req)

    def post_multipart(self, path, parts):
        """parts: list of (name, content_bytes, content_type_or_None).

        Builds a multipart/form-data body by hand — stdlib's
        email.mime.multipart is for emails, not HTTP multipart, and produces
        the wrong header style. Hand-rolling is ~15 lines and matches what
        fetch() emits in the browser.
        """
        boundary = '----test-' + uuid.uuid4().hex
        buf = io.BytesIO()
        for (name, content, ctype) in parts:
            buf.write(b'--' + boundary.encode('ascii') + b'\r\n')
            disp = f'form-data; name="{name}"'
            if ctype:
                disp += f'; filename="{name}.bin"'
            buf.write(b'Content-Disposition: ' + disp.encode('ascii') + b'\r\n')
            if ctype:
                buf.write(b'Content-Type: ' + ctype.encode('ascii') + b'\r\n')
            buf.write(b'\r\n')
            buf.write(content if isinstance(content, bytes) else content.encode('utf-8'))
            buf.write(b'\r\n')
        buf.write(b'--' + boundary.encode('ascii') + b'--\r\n')
        req = urllib.request.Request(
            self.url(path), data=buf.getvalue(), method='POST',
            headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
        return self._do(req)

    def _do(self, req):
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()


# --- Tests: /write JSON regression (existing behavior must keep working) ---

class WriteJsonTests(ShimTestCase):
    def test_write_json_string(self):
        status, _ = self.post_json('/write',
            {'device': {'uid': self.device.uid}, 'data': '^XA^XZ'})
        self.assertEqual(status, 200)
        self.assertEqual(self.device.written, [b'^XA^XZ'])

    def test_write_json_byte_list(self):
        status, _ = self.post_json('/write',
            {'device': {'uid': self.device.uid}, 'data': [126, 72, 83]})
        self.assertEqual(status, 200)
        self.assertEqual(self.device.written, [b'~HS'])


# --- Tests: /write multipart (new path for sendFile / PDF Direct) ---

class WriteMultipartTests(ShimTestCase):
    def test_multipart_writes_raw_bytes(self):
        # Include high bytes (0x80-0xFF) — must NOT be UTF-8-mangled.
        blob = bytes(range(256)) * 4   # 1024 bytes covering full byte range
        meta = json.dumps({'device': {'uid': self.device.uid}}).encode('utf-8')
        status, _ = self.post_multipart('/write', [
            ('json', meta, 'application/json'),
            ('blob', blob, 'application/pdf'),
        ])
        self.assertEqual(status, 200)
        self.assertEqual(self.device.written, [blob])

    def test_multipart_missing_json_part(self):
        status, body = self.post_multipart('/write', [
            ('blob', b'%PDF-1.4 x', 'application/pdf'),
        ])
        self.assertEqual(status, 400)
        self.assertIn(b'json', body.lower())   # error mentions the missing part

    def test_multipart_missing_blob_part(self):
        meta = json.dumps({'device': {'uid': self.device.uid}}).encode('utf-8')
        status, body = self.post_multipart('/write', [
            ('json', meta, 'application/json'),
        ])
        self.assertEqual(status, 400)
        self.assertIn(b'blob', body.lower())

    def test_multipart_unknown_device(self):
        meta = json.dumps({'device': {'uid': 'not:in:registry'}}).encode('utf-8')
        status, _ = self.post_multipart('/write', [
            ('json', meta, 'application/json'),
            ('blob', b'%PDF-1.4', 'application/pdf'),
        ])
        self.assertEqual(status, 404)

    def test_multipart_bad_json(self):
        status, body = self.post_multipart('/write', [
            ('json', b'{not valid json', 'application/json'),
            ('blob', b'%PDF-1.4', 'application/pdf'),
        ])
        self.assertEqual(status, 400)
        self.assertIn(b'json', body.lower())


# --- Tests: adjacent endpoint smoke (proves the harness is wired correctly) ---

class EndpointSmokeTests(ShimTestCase):
    def test_config_returns_shape(self):
        status, body = self.get('/config')
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertIn('version', payload)
        self.assertIn('api_level', payload)
        self.assertIn('supportedConversions', payload)

    def test_available_lists_mock_device(self):
        status, body = self.get('/available')
        self.assertEqual(status, 200)
        payload = json.loads(body)
        # Helper groups by deviceType — 'printer' is a key.
        self.assertIn('printer', payload)
        uids = [d.get('uid') for d in payload['printer']]
        self.assertIn(self.device.uid, uids)


if __name__ == '__main__':
    unittest.main()
