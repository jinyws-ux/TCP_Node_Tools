"""Build with build-onefile.cmd first. Publish to a NAS directory you control."""
import argparse
import json
import os
from pathlib import Path
import shutil
import tempfile
from main import APP_VERSION
from nas_update import sha256, version_tuple


def publish(exe, destination, version, notes):
    version_tuple(version)
    exe, destination = Path(exe), Path(destination)
    with exe.open('rb') as stream:
        if stream.read(2) != b'MZ':
            raise ValueError('Not a Windows EXE')
    destination.mkdir(parents=True, exist_ok=True)
    name = 'TicketMonitor-v%s.exe' % version
    target = destination / name
    if target.exists():
        raise FileExistsError('Version already exists; publish a new version number.')
    # Version must match APP_VERSION in the binary source. Use onefile builds only.
    with tempfile.TemporaryDirectory(prefix='.publish-', dir=destination) as temp:
        stage = Path(temp) / name
        shutil.copyfile(exe, stage)
        digest = sha256(stage)
        if digest != sha256(exe):
            raise ValueError('Copy verification failed')
        os.replace(stage, target)
        manifest = Path(temp) / 'version.json'
        manifest.write_text(json.dumps(dict(version=version, file=name, sha256=digest,
                                            packageType='onefile', notes=notes), ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(manifest, destination / 'version.json')
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Publish a TicketMonitor onefile EXE to NAS')
    parser.add_argument('exe')
    parser.add_argument('destination')
    parser.add_argument('--notes', default='客户端更新')
    args = parser.parse_args()
    print(publish(args.exe, args.destination, APP_VERSION, args.notes))
