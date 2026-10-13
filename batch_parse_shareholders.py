# -*- coding: utf-8 -*-
"""批量从各公司 PACRA Beneficial Ownership Printout 解析股东，写回 license_apps.json
用法: python batch_parse_shareholders.py"""
import json, re, urllib.request, io, datetime, sys
import pypdf
API = 'https://mine-sync.frankataix.workers.dev'
UA = {'User-Agent': 'Mozilla/5.0'}

def api(b):
    r = urllib.request.urlopen(urllib.request.Request(API + '/', data=json.dumps(b).encode(),
        headers={'Content-Type': 'application/json', 'User-Agent': 'x'}), timeout=60)
    return json.loads(r.read().decode())

NATIONS = 'ZAMBIA|ZAMBIAN|CHINA|CHINESE|GRENADA|INDIA|INDIAN|CONGO|CONGOLESE|DRC|TANZANIA|KENYA|ZIMBABWE|BOTSWANA|NAMIBIA|ANGOLA|MOZAMBIQUE|MALAWI|SOUTH AFRICA|BRITISH|BRITAIN|USA|AMERICAN|LEBANON|LEBANESE|UAE|RUSSIA|RUSSIAN|KOREA|JAPAN|CANADA|AUSTRALIA|SWITZERLAND|SWISS|CYPRUS|MAURITIUS|SEYCHELLES|HONG KONG|NIGERIA|GHANA|EGYPT|PAKISTAN|TURKEY|BELGIUM|FRANCE|FRENCH|GERMANY|ITALY|SPAIN|PORTUGAL|NETHERLANDS|IRELAND|BRITISH VIRGIN'
ROW = re.compile(r"([A-Z][A-Z'&.,\- ]{2,}?)\s+(" + NATIONS + r"|[A-Z]{3,}(?=\s+\S*\d))\s+(.+?)\s+((?:Yes|No)(?:\s+(?:Yes|No)){1,2})(?:\s+([\d,]+(?:\.\d+)?)\s+([A-Za-z]+))?")
IDTYPE = re.compile(r'^(?:Passport|National\s+ID|ID\s+Card|NRC|Driving\s+Licen[cs]e)\s+', re.I)
BO  = re.compile(r"([A-Z][A-Z'&.,\- ]{2,}?)\s*-\s*\S+\s+(" + NATIONS + r"|[A-Z]{3,})\s+\S+\s+Yes\s+.*?([\d,]+\.\d+)\s+(?:Ordinary|Preference|Common)")
STOP = re.compile(r'LIMITED|COMPANY|REGISTERED|ADDRESS|CERTIFICATE|PRINTED|FORENAMES|SURNAMES|BENEFICIARY|NATIONALITY|IDENTITY|MEMBER', re.I)

def parse(t):
    """解析 PACRA printout → {shareholders(含证件号), directors, secretary, regNo, regDate, address, phone, email, capital}"""
    t = re.sub(r'(\d+\.\d)\s*\n\s*(\d{1,2}(?!\d))', r'\1\2', t)  # 拼接跨行金额
    shs, dirs = [], []
    info = {}
    tot = 0.0
    m = re.search(r'(?:ordinary|common|preference)[^\d]{0,10}([\d,]+(?:\.\d+)?)\s+[\d.]+', t, re.I)
    if m: tot = float(m.group(1).replace(',', ''))
    m = re.search(r'Registration Number\s+(\d{6,})', t, re.I)
    if m: info['regNo'] = m.group(1)
    m = re.search(r'Date of Incorporation\s+(\d{1,2})\s*day of\s*(\w+)\s*(\d{4})', t, re.I)
    if m: info['regDate'] = f'{m.group(1)} {m.group(2)} {m.group(3)}'
    m = re.search(r'Registered Office\s+([^\n]{10,150})', t, re.I)
    if m: info['address'] = re.sub(r'\s+', ' ', m.group(1)).strip()
    m = re.search(r'Phone\s+(\+?\d[\d\s\-]{5,}\d)', t)
    if m: info['phone'] = m.group(1).replace(' ', '')
    m = re.search(r'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}', t)
    if m: info['email'] = m.group(0)
    m = re.search(r'Ordinary\s+([\d,]+\.\d+)\s+[\d.]+', t, re.I)
    if m: info['capital'] = m.group(1)
    for r in ROW.finditer(t):
        nm = re.sub(r'\s+', ' ', r.group(1)).strip()
        if STOP.search(nm): continue
        nat = r.group(2)
        idno = IDTYPE.sub('', re.sub(r'\s{2,}', ' ', r.group(3)).strip())
        flags = r.group(4).split()
        amt = float(r.group(5).replace(',', '')) if r.group(5) and re.search(r'ordinary|preference|common', r.group(6) or '', re.I) else 0.0
        ent = {'name': nm, 'nationality': nat, 'idNo': idno}
        if amt:
            ent['amount'] = amt
            shs.append(ent)
        if flags.count('Yes') >= 3:
            info['secretary'] = nm; info['secNat'] = nat
        dirs.append(ent)
    # Beneficial Owners 表校正：Individuals 合计对不上核定股本时以 BO 为准
    bi = t.find('Beneficial Owners')
    if bi >= 0 and shs:
        bo = {re.sub(r'\s+', ' ', b.group(1)).strip().upper(): float(b.group(3).replace(',', '')) for b in BO.finditer(t[bi:bi+4000])}
        si = sum(x['amount'] for x in shs)
        if tot and abs(si - tot) > 1 and bo:
            fx = [dict(x, amount=bo.get(x['name'].upper(), x['amount'])) for x in shs]
            if abs(sum(x['amount'] for x in fx) - tot) < abs(si - tot):
                shs = fx
    tot = tot or sum(x['amount'] for x in shs)
    if tot:
        for x in shs: x['pct'] = round(x['amount'] * 100 / tot, 1)
    info['shareholders'] = shs
    info['directors'] = dirs
    return info

r = api({'action': 'read', 'path': 'data/license_apps.json'})
S = json.loads(r['content'])
only = sys.argv[1] if len(sys.argv) > 1 else None
for c in S['companies']:
    if only and only.upper() not in c['name'].upper(): continue
    d = (c.get('docs') or {}).get('pacra') or {}
    key = d.get('mediaKey', '')
    print(c['name'][:45].ljust(46), end=' ')
    if not key or 'pdf' not in (d.get('fileName') or '').lower():
        print('无PACRA PDF'); continue
    try:
        pdf = urllib.request.urlopen(urllib.request.Request(API + '/media?key=' + key, headers=UA), timeout=60).read()
        t = '\n'.join((p.extract_text() or '') for p in pypdf.PdfReader(io.BytesIO(pdf)).pages)
        info = parse(t)
        shs = info['shareholders']
        if shs: c['shareholders'] = shs
        for k in ('regNo','regDate','address','phone','email','capital','secretary','secNat'):
            if info.get(k): c[k] = info[k]  # 以 PACRA 为准刷新
        if info.get('directors'): c['directors'] = info['directors']
        zm = round(sum(x.get('pct') or 0 for x in shs if 'ZAMBIA' in x['nationality'].upper()), 1)
        print(f"股东{len(shs)}人 赞方{zm}% 注册号{info.get('regNo','-')} | " + '; '.join(f"{x['name']}({x['nationality'][:3]}){x.get('pct','')}%" for x in shs))
    except Exception as e:
        print('失败', e)

S['updatedAt'] = datetime.datetime.now().isoformat()
print(api({'action': 'save', 'path': 'data/license_apps.json',
           'content': json.dumps(S, ensure_ascii=False), 'message': 'batch parse shareholders (BO-corrected)'}))
