"""Stream an authorized deployment snapshot; exclude local test installations without deleting them."""
import sys, os, json, hashlib, zipfile, time
from pathlib import Path
root = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
if root.name != 'FastLaneNEWSproject' or out.parent != root.parent or out.name != 'FastLaneNEWSproject.zip':
    raise SystemExit('Unexpected deployment destination')
excluded = ['app/.local', 'app/.env', 'app/node_modules', 'app/runtime/mediacrawler-env', 'app/runtime/asr-env', 'app/runtime/rsshub', 'app/runtime/rsshub-store/v10/projects', 'app/runtime/rsshub-store/v10/tmp', 'services']
def skip(name):
    return name == 'SHA256SUMS.json' or name.endswith('.wrapper.log') or any(name == p or name.startswith(p + '/') for p in excluded)
entries = []
for directory, dirs, names in os.walk(root, followlinks=False):
    current = Path(directory)
    dirs[:] = sorted(d for d in dirs if not skip((current/d).relative_to(root).as_posix()))
    for name in sorted(names):
        p = current/name
        rel = p.relative_to(root).as_posix()
        if skip(rel): continue
        if p.is_symlink(): raise SystemExit('Unexpected link: ' + rel)
        with p.open('rb') as f: digest = hashlib.file_digest(f, 'sha256').hexdigest()
        entries.append({'path':rel, 'size':p.stat().st_size, 'sha256':digest})
manifest = {'createdUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'excludedLocalValidationPaths':excluded, 'files':entries, 'fileCount':len(entries), 'uncompressedBytes':sum(e['size'] for e in entries)}
(root/'SHA256SUMS.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps({'phase':'inventory', 'files':len(entries), 'bytes':manifest['uncompressedBytes']}), flush=True)
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=3, allowZip64=True) as z:
    for e in entries: z.write(root/e['path'], root.name+'/'+e['path'])
    z.write(root/'SHA256SUMS.json', root.name+'/SHA256SUMS.json')
print('Archive written; checking every entry CRC', flush=True)
with zipfile.ZipFile(out) as z:
    bad=z.testzip()
    if bad: raise SystemExit('CRC failure '+bad)
    if len(z.infolist()) != len(entries)+1: raise SystemExit('Inventory mismatch')
with out.open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
out.with_suffix('.zip.sha256').write_text(digest+'  '+out.name+'\n',encoding='ascii')
print(json.dumps({'ok':True, 'zipBytes':out.stat().st_size,'files':len(entries)+1, 'uncompressedBytes':manifest['uncompressedBytes'], 'sha256':digest}), flush=True)
