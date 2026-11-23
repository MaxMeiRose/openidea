"""Real JDT cache regression checks; the production bundle is never modified.

python -X utf8 cache.py <jdtls home> [bundle.jar] [lru|owner|shared]
Requires the same Java runtime as JDT LS and its shipped compiler.
"""
import json
import os
import pathlib
import platform
import queue
import subprocess
import sys
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
import zipfile

home = pathlib.Path(sys.argv[1]).resolve()
root = pathlib.Path(__file__).resolve().parents[1]
bundle = pathlib.Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else root / 'openidea-java-usages.jar'
cases = [sys.argv[3]] if len(sys.argv) > 3 else ['lru', 'owner', 'shared', 'saved']
work = pathlib.Path(tempfile.mkdtemp(prefix='openidea-cache-check-'))
classes = work / 'classes'
classes.mkdir()
classpath = os.pathsep.join([str(bundle), *(str(p) for p in sorted((home / 'plugins').glob('*.jar')))])
subprocess.run(['java', '-cp', str(home / 'plugins' / '*'), 'org.eclipse.jdt.internal.compiler.batch.Main',
                '-21', '-proc:none', '-classpath', classpath, '-d', str(classes),
                str(root / 'tests/CacheProbe.java')], check=True)
test_bundle = work / 'cache-test.jar'
with zipfile.ZipFile(bundle) as original, zipfile.ZipFile(test_bundle, 'w') as output:
    plugin = ET.fromstring(original.read('plugin.xml'))
    extension = next(e for e in plugin.findall('extension') if e.get('point') == 'org.eclipse.jdt.ls.core.delegateCommandHandler')
    handler = ET.SubElement(extension, 'delegateCommandHandler', {'class': 'ai.openidea.usages.CacheProbe'})
    ET.SubElement(handler, 'command', {'id': 'openidea.test.cache'})
    for item in original.infolist():
        output.writestr(item, ET.tostring(plugin, encoding='utf-8') if item.filename == 'plugin.xml' else original.read(item))
    for file in classes.rglob('*.class'):
        output.write(file, str(file.relative_to(classes)))

config = work / 'config'
config.mkdir()
base = {'Windows': 'config_win', 'Darwin': 'config_mac'}.get(platform.system(), 'config_linux')
names = ([base + '_arm'] if platform.machine().lower() in ('arm64', 'aarch64') else []) + [base]
(config / 'config.ini').write_bytes(next((home / n / 'config.ini').read_bytes() for n in names if (home / n / 'config.ini').is_file()))
project = work / 'project'
(project / 'src').mkdir(parents=True)
(project / '.project').write_text('<projectDescription><name>cacheprobe</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>')
(project / '.classpath').write_text('<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>')
target = project / 'src/Target.java'
target.write_text('class Target { void used() {} }\n')
(project / 'src/Caller.java').write_text('class Caller { void call(Target t) { t.used(); } }\n')
log = (work / 'stderr.log').open('w')
proc = subprocess.Popen(['java', '-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4',
    '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Xmx1G', '--add-modules=ALL-SYSTEM',
    '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED',
    '-jar', str(next((home / 'plugins').glob('org.eclipse.equinox.launcher_*.jar'))),
    '-configuration', str(config), '-data', str(work / 'metadata')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log)
messages = queue.Queue()
lock = threading.Lock()

def send(message):
    data = json.dumps(message).encode()
    with lock:
        proc.stdin.write(f'Content-Length: {len(data)}\r\n\r\n'.encode() + data)
        proc.stdin.flush()

def read():
    while True:
        headers = {}
        while True:
            line = proc.stdout.readline()
            if not line:
                return
            if line == b'\r\n':
                break
            key, value = line.decode().split(':', 1)
            headers[key.lower()] = value.strip()
        message = json.loads(proc.stdout.read(int(headers['content-length'])))
        if 'method' in message and 'id' in message:
            send({'jsonrpc': '2.0', 'id': message['id'], 'result': [] if message['method'] == 'workspace/configuration' else None})
        else:
            messages.put(message)

threading.Thread(target=read, daemon=True).start()
seq = 0

def request(method, params):
    global seq
    seq += 1
    send({'jsonrpc': '2.0', 'id': seq, 'method': method, 'params': params})
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        message = messages.get(timeout=max(1, deadline - time.monotonic()))
        if message.get('id') == seq:
            if 'error' in message:
                raise RuntimeError(message['error'])
            return message.get('result')
    raise TimeoutError(method)

try:
    request('initialize', {'processId': None, 'rootUri': project.as_uri(), 'capabilities': {},
        'workspaceFolders': [{'uri': project.as_uri(), 'name': 'cacheprobe'}],
        'initializationOptions': {'bundles': [str(test_bundle)], 'settings': {'java': {'import': {'maven': {'enabled': False}, 'gradle': {'enabled': False}}}}}})
    send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
    send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {
        'uri': target.as_uri(), 'languageId': 'java', 'version': 1, 'text': target.read_text()}}})
    request('java/buildWorkspace', True)
    request('workspace/executeCommand', {'command': 'openidea.java.usages', 'arguments': [target.as_uri(), 0, 21, False, 'sources']})
    for case in cases:
        if case == 'saved':
            query = lambda: request('workspace/executeCommand', {'command': 'openidea.java.usages', 'arguments': [target.as_uri(), 0, 21, False, 'sources']})
            answer = query()
            for _ in range(8):
                if not isinstance(answer, dict) or not answer.get('stale'):
                    break
                answer = query()
            caller = project / 'src/Caller.java'
            caller.write_text('\n\n' + caller.read_text())
            send({'jsonrpc': '2.0', 'method': 'workspace/didChangeWatchedFiles', 'params': {'changes': [{'uri': caller.as_uri(), 'type': 2}]}})
            request('java/buildWorkspace', True)
            answer = query()
            for _ in range(8):
                if not isinstance(answer, dict) or not answer.get('stale'):
                    break
                answer = query()
            rows = answer['rows'] if isinstance(answer, dict) else answer
            assert any(r['location']['uri'].endswith('/Caller.java') and r['location']['range']['start']['line'] == 2 for r in rows), answer
            print(json.dumps({'test': case, 'savedPositionUpdated': True}), flush=True)
            continue
        result = request('workspace/executeCommand', {'command': 'openidea.test.cache', 'arguments': [case]})
        print(json.dumps(result), flush=True)
finally:
    try:
        request('shutdown', None)
        send({'jsonrpc': '2.0', 'method': 'exit', 'params': None})
    except Exception:
        pass
    proc.terminate()
    proc.wait(timeout=20)
    log.close()
    print('workspace:', work)
