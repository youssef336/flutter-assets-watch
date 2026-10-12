#!/usr/bin/env python3
"""End-to-end check in real headless Chrome, stdlib only (no puppeteer, no pip).

Serves the project, opens the page through the Chrome DevTools Protocol, runs
a scan of a real public repo (and optionally loads the sample --analyze-size
JSON), waits for the report, prints what rendered, and fails on any console
error or uncaught exception.

    python3 tool/e2e.py youssef336/Fruits_Hub
    python3 tool/e2e.py flutter/samples --path animations
    python3 tool/e2e.py youssef336/Fruits_Hub --width 390 --screenshot _shot-mobile.png --size-sample
"""

import argparse
import base64
import functools
import http.server
import json
import os
import shutil
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROMES = [
    os.environ.get('CHROME', ''),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'google-chrome', 'chromium', 'chromium-browser',
]


class WS:
    """Just enough RFC 6455 for CDP: masked text frames out, unmasked frames in."""

    def __init__(self, url):
        host_port, path = url[len('ws://'):].split('/', 1)
        host, port = host_port.split(':')
        self.sock = socket.create_connection((host, int(port)))
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f'GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\n'
                           f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            buf += self.sock.recv(1)
        if b' 101 ' not in buf.split(b'\r\n')[0]:
            raise RuntimeError(buf.decode(errors='replace'))

    def send(self, text):
        data = text.encode()
        head = bytearray([0x81])
        n = len(data)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack('>H', n)
        else:
            head += bytes([0x80 | 127]) + struct.pack('>Q', n)
        mask = os.urandom(4)
        self.sock.sendall(bytes(head) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _read(self, n):
        out = b''
        while len(out) < n:
            chunk = self.sock.recv(n - len(out))
            if not chunk:
                raise ConnectionError('socket closed')
            out += chunk
        return out

    def recv(self):
        message = b''
        while True:
            b1, b2 = self._read(2)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack('>H', self._read(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self._read(8))[0]
            payload = self._read(n)
            if b1 & 0x0F == 0x8:
                raise ConnectionError('closed by peer')
            message += payload
            if b1 & 0x80:
                return message.decode(errors='replace')


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.next_id = 0
        self.events = []
        self.lock = threading.Lock()
        self.replies = {}
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        try:
            while True:
                msg = json.loads(self.ws.recv())
                with self.lock:
                    if 'id' in msg:
                        self.replies[msg['id']] = msg
                    else:
                        self.events.append(msg)
        except Exception:
            pass

    def call(self, method, timeout=60, **params):
        self.next_id += 1
        i = self.next_id
        self.ws.send(json.dumps({'id': i, 'method': method, 'params': params}))
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                if i in self.replies:
                    reply = self.replies.pop(i)
                    if 'error' in reply:
                        raise RuntimeError(f'{method}: {reply["error"]}')
                    return reply.get('result', {})
            time.sleep(0.02)
        raise TimeoutError(method)

    def eval(self, expr):
        r = self.call('Runtime.evaluate', expression=expr, returnByValue=True, awaitPromise=True)
        if 'exceptionDetails' in r:
            raise RuntimeError(json.dumps(r['exceptionDetails'])[:500])
        return r['result'].get('value')


def serve():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=ROOT)
    httpd = socketserver.ThreadingTCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def wait_for(cdp, expr, timeout, label):
    end = time.time() + timeout
    while time.time() < end:
        if cdp.eval(expr):
            return True
        time.sleep(0.5)
    raise TimeoutError(label)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('repo')
    ap.add_argument('--path', default=None, help='sub-project inside a monorepo')
    ap.add_argument('--width', type=int, default=1280)
    ap.add_argument('--screenshot', default=None)
    ap.add_argument('--size-sample', action='store_true', help='also load the sample --analyze-size JSON')
    ap.add_argument('--timeout', type=int, default=240)
    a = ap.parse_args()

    chrome = next((c for c in CHROMES if c and (shutil.which(c) or os.path.exists(c))), None)
    if not chrome:
        sys.exit('Chrome not found (set CHROME=...)')
    httpd, port = serve()
    profile = tempfile.mkdtemp()
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        debug_port = probe.getsockname()[1]
    proc = subprocess.Popen([chrome, '--headless=new', '--disable-gpu', f'--user-data-dir={profile}',
                             f'--remote-debugging-port={debug_port}', f'--window-size={a.width},1000',
                             '--no-first-run', '--hide-scrollbars', 'about:blank'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                targets = json.load(urllib.request.urlopen(f'http://127.0.0.1:{debug_port}/json'))
                page = next(t for t in targets if t['type'] == 'page')
                break
            except Exception:
                time.sleep(0.1)
        cdp = CDP(WS(page['webSocketDebuggerUrl']))
        cdp.call('Runtime.enable')
        cdp.call('Log.enable')
        cdp.call('Page.enable')
        cdp.call('Emulation.setDeviceMetricsOverride', width=a.width, height=1000, deviceScaleFactor=1,
                 mobile=a.width < 600)

        url = f'http://127.0.0.1:{port}/?repo={a.repo}' + (f'&path={a.path}' if a.path else '')
        print(f'== {url}  (width {a.width})')
        t0 = time.time()
        cdp.call('Page.navigate', url=url)
        wait_for(cdp, "document.readyState === 'complete'", 30, 'load')
        wait_for(cdp, "!document.getElementById('report').hidden || !document.getElementById('error').hidden"
                      " || !document.getElementById('picker').hidden", a.timeout, 'scan')
        took = time.time() - t0
        picker = cdp.eval("document.getElementById('picker').hidden ? '' : document.getElementById('picker-list').innerText")
        error = cdp.eval("document.getElementById('error').hidden ? '' : document.getElementById('error').innerText")
        if picker:
            print('picker shown (monorepo):', ' | '.join(picker.split('\n'))[:600])
        if error:
            print('ERROR shown:', error)
        if not picker and not error:
            info = cdp.eval("""(() => {
              const t = (s) => [...document.querySelectorAll(s)].map((e) => e.innerText.replace(/\\s+/g, ' ').trim());
              return {
                score: t('#score b')[0],
                tiles: t('#strip .tile'),
                meta: t('.project-meta span'),
                images: t('#images-summary')[0],
                imageCards: document.querySelectorAll('#images .img').length,
                firstImages: t('#images .img .path').slice(0, 5),
                flags: t('#images .img .flags').slice(0, 5),
                assets: t('#assets h3'),
                deps: t('#deps h3'),
                depRows: t('#deps .rows li').slice(0, 12),
                assetRows: t('#assets .rows li').slice(0, 8),
                overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
              };
            })()""")
            print(f'scan finished in {took:.1f}s')
            for k, v in info.items():
                print(f'{k}: {json.dumps(v, ensure_ascii=False)}')
            if info['overflow']:
                print('FAIL: horizontal overflow at this width')
                return 1
            # Real WebP conversion on the first image card.
            if info['imageCards']:
                cdp.eval("document.querySelector('#images .img [data-act=\"webp\"]')?.click()")
                try:
                    wait_for(cdp, "!!document.querySelector('#images .convert .compare') || "
                                  "/مقدرتش/.test(document.querySelector('#images .convert')?.innerText || '')", 60, 'webp')
                    print('webp:', cdp.eval("document.querySelector('#images .convert').innerText.replace(/\\s+/g, ' ').slice(0, 220)"))
                except TimeoutError:
                    print('webp: timed out')
            md = cdp.eval("(async () => { const r = await import('./js/report.js'); return 'ok'; })()")
            print('report module:', md)
        if a.size_sample:
            cdp.eval("document.getElementById('size-sample').click()")
            wait_for(cdp, "!!document.querySelector('#size .treemap .tm')", 30, 'size sample')
            print('size:', cdp.eval("""(() => ({
              total: document.querySelector('.size-total').innerText,
              tiles: document.querySelectorAll('#tm .tm').length,
              rows: document.querySelectorAll('table.top tbody tr').length,
              legend: document.querySelector('.legend').innerText.replace(/\\s+/g, ' '),
            }))()"""))
            cdp.eval("document.querySelector('#tm .tm.drill')?.click()")
            time.sleep(0.4)
            print('drill-down crumbs:', cdp.eval("document.getElementById('tm-crumbs').innerText.replace(/\\s+/g, ' ')"))
        if a.screenshot:
            h = cdp.eval('document.documentElement.scrollHeight')
            cdp.call('Emulation.setDeviceMetricsOverride', width=a.width, height=min(h, 7000), deviceScaleFactor=1,
                     mobile=a.width < 600)
            time.sleep(0.6)
            shot = cdp.call('Page.captureScreenshot', format='png')
            with open(a.screenshot, 'wb') as f:
                f.write(base64.b64decode(shot['data']))
            print('screenshot:', a.screenshot)

        time.sleep(0.5)
        problems = []
        with cdp.lock:
            for e in cdp.events:
                m, p = e.get('method'), e.get('params', {})
                if m == 'Runtime.exceptionThrown':
                    problems.append('exception: ' + json.dumps(p.get('exceptionDetails', {}))[:400])
                elif m == 'Runtime.consoleAPICalled' and p.get('type') == 'error':
                    problems.append('console.error: ' + ' '.join(str(x.get('value', x.get('description', ''))) for x in p.get('args', []))[:400])
                elif m == 'Log.entryAdded' and p.get('entry', {}).get('level') == 'error':
                    problems.append('log: ' + p['entry'].get('text', '')[:300] + ' ' + p['entry'].get('url', ''))
        if problems:
            print('== console errors')
            print('\n'.join(problems))
            return 1
        if error:
            return 1
        print('== OK (no console errors)')
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        httpd.shutdown()
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())
