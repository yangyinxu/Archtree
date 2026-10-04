"""Extract bounded regular ZIP entries, rejecting links, path traversal and collisions before any writes."""
import os
from pathlib import Path
import shutil
import stat
import sys
import zipfile


def extract(archive, destination):
    root = Path(destination)
    if root.exists():
        raise ValueError('Extraction destination already exists.')
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if not entries or len(entries) > 20000 or sum(item.file_size for item in entries) > 1024 * 1024 * 1024:
            raise ValueError('Release archive exceeds extraction limits.')
        paths = {}
        for item in entries:
            name = item.filename.rstrip('/')
            parts = name.split('/')
            mode = item.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if (not name or '\\' in name or ':' in name or any(part in ('', '.', '..') for part in parts)
                    or any(ord(char) < 32 for char in name) or name in paths or item.flag_bits & 1
                    or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
                    or (kind == stat.S_IFDIR and not item.is_dir())):
                raise ValueError('Release archive contains an unsafe entry.')
            paths[name] = item.is_dir()
        for name in paths:
            parents = name.split('/')[:-1]
            for index in range(1, len(parents) + 1):
                parent = '/'.join(parents[:index])
                if parent in paths and not paths[parent]:
                    raise ValueError('Release archive contains conflicting entries.')
        root.mkdir(mode=0o700)
        for item in entries:
            target = root / item.filename
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(item) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                # Preserve executable hooks while dropping special or group/world-write permissions.
                os.chmod(target, 0o755 if (item.external_attr >> 16) & 0o111 else 0o644)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('Expected archive and destination.')
        extract(sys.argv[1], sys.argv[2])
    except Exception:
        print('Release archive extraction failed validation.', file=sys.stderr)
        sys.exit(1)
