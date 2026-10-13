# 从 Company Administration Files 批量导入公司基础资料到矿权申请助手
# 用法：python import_company_docs.py          # 实际执行
#       python import_company_docs.py --dry    # 只扫描打印清单，不上传
import json, re, sys, urllib.request, mimetypes
from pathlib import Path

BASE = Path(r"G:\我的云端硬盘\01 Zambia Company Admin Files\01 Group Companies\1 Company Administration Files")
API = 'https://mine-sync.frankataix.workers.dev'
DATA_PATH = 'data/license_apps.json'
DRY = '--dry' in sys.argv

# 门户槽位 -> 文件名匹配规则（先搜 Mining* 子目录，再搜公司根目录）
SLOTS = [
    ('inc',   'Certificate of Incorporation', [r'certificate of incorporation.*\.pdf$']),
    ('cap',   'Certificate of Share Capital', [r'certificate of share capital.*\.pdf$']),
    ('art',   'Articles of Association',      [r'articles of association.*\.pdf$']),
    ('pacra', 'PACRA Print Out OR Form 2 or 3',
        [r'pacra print out.*\.pdf$', r'beneficial ownership printout.*\.pdf$', r'pacra.*printout.*\.pdf$',
         r'pacra.*\.png$']),
    ('iddir', 'Identity of Directors',        [r'identity of director.*\.(pdf|docx)$',
         r'directors? ids?.*\.(docx|pdf)$', r'company director and shareholders.*\.pdf$']),
    ('idsh',  'Identity of Directors and Shareholders', [r'identity of director.*\.(pdf|docx)$',
         r'directors? ids?.*\.(docx|pdf)$', r'company director and shareholders.*\.pdf$']),
    ('tax',   'Valid Tax Clearance Certificate', [r'2026.*tax clearance.*\.pdf$', r'tax clearance.*\.(pdf|jpe?g)$']),
]

def api(body):
    req = urllib.request.Request(API + '/', data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'User-Agent': 'importer'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8', errors='replace'))

def upload(path: Path):
    boundary = 'importerboundary'
    mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
    data = path.read_bytes()
    payload = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
               f'Content-Type: {mime}\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
    req = urllib.request.Request(API + '/upload', data=payload, method='POST',
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}', 'User-Agent': 'importer'})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode('utf-8', errors='replace'))

def find_file(cdir: Path, patterns):
    # 按模式优先级找文件；每个模式依次搜 Mining* 子目录 → 公司根目录 → 全目录递归
    subs = [p for p in cdir.iterdir() if p.is_dir() and re.search(r'mining|mine|矿证', p.name, re.I)]
    pools = [sorted(s.iterdir()) for s in subs]
    pools.append(sorted(p for p in cdir.iterdir() if p.is_file()))
    pools.append(sorted(cdir.rglob('*')))
    for pat in patterns:
        for pool in pools:
            for f in pool:
                if not f.is_file() or f.name.startswith('~$') or f.name == 'desktop.ini':
                    continue
                if re.search(pat, f.name, re.I):
                    return f
    return None

def uid():
    import time, random
    return hex(int(time.time()*1000))[2:] + ''.join(random.choice('abcdefghijklmnopqrstuvwxyz0123456789') for _ in range(4))

# 现有数据
try:
    res = api({'action': 'read', 'path': DATA_PATH})
    S = json.loads(res['content']) if res.get('content') else {'v': 1, 'companies': [], 'apps': []}
except Exception:
    S = {'v': 1, 'companies': [], 'apps': []}
S.setdefault('companies', [])
existing = {c.get('name','').upper() for c in S['companies']}

companies = [d for d in BASE.iterdir() if d.is_dir() and re.match(r'^\d+\s', d.name)]
for cdir in sorted(companies, key=lambda p: p.name):
    cname = re.sub(r'^\d+\s*', '', cdir.name).strip()
    print(f'\n=== {cname} ===')
    if cname.upper() in existing:
        print('  已存在，跳过')
        continue
    docs = {}
    licnos = set()
    for f in cdir.rglob('*'):
        for m in re.findall(r'(\d{5})-HQ-(LEL|SEL|SML|LML|AMR)', f.name, re.I):
            licnos.add(m[0] + '-HQ-' + m[1].upper())
    for key, label, pats in SLOTS:
        f = find_file(cdir, pats)
        if not f:
            print(f'  [缺] {label}')
            continue
        if DRY:
            print(f'  [ok] {label} <- {f.name}')
            docs[key] = {'fileName': f.name, 'mediaKey': '(dry)', 'status': 1}
            continue
        try:
            up = upload(f)
            docs[key] = {'fileName': f.name, 'mediaKey': up['key'], 'status': 1, 'expiry': '', 'srcPath': str(f)}
            print(f'  [传] {label} <- {f.name} -> {up["key"]}')
        except Exception as e:
            print(f'  [败] {label} <- {f.name}: {e}')
    co = {'id': uid(), 'name': cname.upper(), 'regNo': '', 'regDate': '', 'address': '',
          'shareCapital': '', 'directors': [], 'shareholders': [], 'heldLicences': 0,
          'docs': docs,
          'note': '历史证号线索: ' + ', '.join(sorted(licnos)) if licnos else ''}
    S['companies'].append(co)

if not DRY:
    S['updatedAt'] = __import__('datetime').datetime.now().isoformat()
    wr = api({'action': 'save', 'path': DATA_PATH, 'content': json.dumps(S, ensure_ascii=False),
              'message': 'import company docs'})
    print('\n保存结果:', wr)
print(f'\n完成，共 {len(companies)} 家公司')
