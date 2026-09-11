#!/usr/bin/env python3
"""Initialize only this application's directories; never replace existing data or mount configuration."""
import json
import os
import pathlib
import secrets
import subprocess

os.umask(0o077)
root = pathlib.Path('/opt/infinite-canvas')
mount = pathlib.Path('/root/PDSDrive')
storage = mount / '团队空间' / 'huanxue' / 'infinite-canvas'
if not os.path.ismount(str(mount)):
    raise SystemExit('PDSDrive is not mounted; refusing to initialize storage')
if not storage.parent.is_dir():
    raise SystemExit('Expected team storage is unavailable')
for directory in (storage, storage / 'files', storage / 'backups', pathlib.Path('/var/lib/infinite-canvas'), pathlib.Path('/var/lib/infinite-canvas-acme')):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
sentinel = storage / '.canvas-storage'
if sentinel.exists():
    if sentinel.read_text().strip() != 'infinite-canvas-storage-v1':
        raise SystemExit('Different storage sentinel exists; refusing to overwrite')
else:
    with sentinel.open('x') as output:
        output.write('infinite-canvas-storage-v1\n')
environment = '\n'.join([
    'NODE_ENV=production', 'HOST=127.0.0.1', 'PORT=8787',
    'APP_ORIGIN=https://101.200.191.177', 'DATA_DIR=/data', 'FILES_DIR=/storage/files',
    'BACKUP_DIR=/storage/backups', 'STORAGE_SENTINEL=/storage/.canvas-storage',
    'MASTER_KEY_FILE=/data/master.key', 'STATIC_DIR=/app/public',
    'MAX_ROOM_CONNECTIONS=50', 'MAX_SYNC_BYTES=1048576', 'MAX_FILE_BYTES=524288000',
    'MAX_API_RESPONSE_BYTES=20971520',
    'API_TIMEOUT_MS=120000', 'SESSION_TTL_MS=86400000', 'SHARE_TTL_MS=604800000',
    'SYNC_BATCH_MS=150', 'AUTH_ATTEMPTS_PER_MINUTE=10', 'WRITES_PER_MINUTE=600',
    'API_CONCURRENCY=2', 'BACKUP_INTERVAL_MS=60000', 'API_ALLOWED_HOSTS=', '',
])
environment_path = root / 'deploy' / 'runtime.env'
if environment_path.exists():
    raise SystemExit('runtime.env already exists; refusing to replace it')
with environment_path.open('x') as output:
    output.write(environment)
credentials = {'username': 'huanxue', 'password': secrets.token_urlsafe(24)}
credentials_path = pathlib.Path('/var/lib/infinite-canvas/admin-access.json')
with credentials_path.open('x') as output:
    json.dump(credentials, output)
subprocess.run([
    'docker', 'run', '--rm', '-i', '--network', 'host', '--env-file', str(environment_path),
    '-v', '/var/lib/infinite-canvas:/data', '-v', str(storage) + ':/storage',
    'infinite-canvas-collaboration:local', 'npm', 'run', 'create-admin',
], input=json.dumps(credentials).encode(), check=True)
print('Application storage and administrator initialized. Credentials are in a root-only file.')
