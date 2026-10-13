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
ROW = re.compile(r"([A-Z][A-Z'&.,\- ]{2,}?)\s+(" + NATIONS + r"|[A-Z]{3,}(?=\s+\S*\d))\s+(.+?)\s+Yes\s+Yes(?:\s+Yes)?(?:\s+([\d,]+(?:\.\d+)?)\s+([A-Za-z]+))?")
BO  = re.compile(r"([A-Z][A-Z'&.,\- ]{2,}?)\s*-\s*\S+\s+(" + NATIONS + r"|[A-Z]{3,})\s+\S+\s+Yes\s+.*?([\d,]+\.\d+)\s+(?:Ordinary|Preference|Common)")
STOP = re.compile(r'LIMITED|COMPANY|REGISTERED|ADDRESS|CERTIFICATE|PRINTED|FORENAMES|SURNAMES|BENEFICIARY|NATIONALITY|IDENTITY|MEMBER', re.I)

def parse(t):
    t = re.sub(r'(\d+\.\d)\s*\n\s*(\d{1,2}(?!\d))', r'\1\2', t)  # 拼接跨行金额
    shs, dirs = [], []
    tot = 0.0
    m = re.search(r'(?:ordinary|common|preference)[^\d]{0,10}([\d,]+(?:\.\d+)?)\s+[\d.]+', t, re.I)
    if m: tot = float(m.group(1).replace(',', ''))
    for r in ROW.finditer(t):
        nm = re.sub(r'\s+', ' ', r.group(1)).strip()
        if STOP.search(nm): continue
        nat = r.group(2)
        amt = float(r.group(4).replace(',', '')) if r.group(4) and re.search(r'ordinary|preference|common', r.group(5) or '', re.I) else 0.0
        (shs if amt else dirs).append({'name': nm, 'nationality': nat, **({'amount': amt} if amt else {})})
    # Beneficial Owners 表校正：Individuals 合计对不上核定股本时以 BO 为准
    bi = t.find('Beneficial Owners')
    if bi >= 0 and shs:
        bo = {re.sub(r'\s+', ' ', b.group(1)).strip(): float(b.group(3).replace(',', '')) for b in BO.finditer(t[bi:bi+4000])}
        si = sum(x['amount'] for x in shs)
        if tot and abs(si - tot) > 1 and bo:
            fx = [dict(x, amount=bo.get(x['name'], x['amount'])) for x in shs]
            if abs(sum(x['amount'] for x in fx) - tot) < abs(si - tot):
                shs = fx
    tot = tot or sum(x['amount'] for x in shs)
    if tot:
        for x in shs: x['pct'] = round(x['amount'] * 100 / tot, 1)
    return shs

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
        shs = parse(t)
        if shs: c['shareholders'] = shs
        zm = round(sum(x.get('pct') or 0 for x in shs if 'ZAMBIA' in x['nationality'].upper()), 1)
        print(f'股东{len(shs)}人 赞方{zm}% | ' + '; '.join(f"{x['name']}({x['nationality'][:3]}){x.get('pct','')}%" for x in shs))
    except Exception as e:
        print('失败', e)

S['updatedAt'] = datetime.datetime.now().isoformat()
print(api({'action': 'save', 'path': 'data/license_apps.json',
           'content': json.dumps(S, ensure_ascii=False), 'message': 'batch parse shareholders (BO-corrected)'}))
