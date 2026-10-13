#!/usr/bin/env python3
import json, urllib.request, base64, sys, time, re

BASE = 'https://mine-sync.frankataix.workers.dev'

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'

def get(path):
    for i in range(3):
        try:
            req = urllib.request.Request(BASE + path, method='GET', headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.status, r.read().decode('utf-8', errors='replace')
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode('utf-8', errors='replace')
        except Exception:
            if i == 2: return 0, ''
            time.sleep(2)

def post_json(payload):
    for i in range(3):
        try:
            req = urllib.request.Request(BASE + '/', data=json.dumps(payload).encode(), method='POST', headers={'Content-Type':'application/json','User-Agent':UA,'Accept':'application/json'})
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.status, json.loads(r.read().decode('utf-8', errors='replace'))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode('utf-8', errors='replace') or '{}')
        except Exception:
            if i == 2: return 0, {}
            time.sleep(2)

def put(url, body, ct):
    for i in range(3):
        try:
            req = urllib.request.Request(url, data=body, method='PUT', headers={'Content-Type':ct,'User-Agent':UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, r.read().decode('utf-8', errors='replace')
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode('utf-8', errors='replace')
        except Exception:
            if i == 2: return 0, ''
            time.sleep(2)

def check(name, ok):
    print(f'[{"PASS" if ok else "FAIL"}] {name}')
    return ok

all_ok = True

# 1. 主页
code, html = get('/field_album.html')
all_ok &= check('field_album.html 可访问', code == 200)
all_ok &= check('包含页面标题', code == 200 and 'Ecobox' in html)
all_ok &= check('包含发布脚本', code == 200 and 'uSubmit' in html)

# 2. 数据读取 + stat 缓存校验接口
code, body = post_json({'action':'stat','path':'data/field_log.json'})
all_ok &= check('stat 接口返回 sha', code == 200 and bool(body.get('sha')))
code, body = post_json({'action':'read','path':'data/field_log.json'})
all_ok &= check('读取 field_log.json', code == 200 and 'content' in body)
if code == 200 and 'content' in body:
    try:
        log = json.loads(body['content'])
        for key in ['projects','tasks','production','posts','todos']:
            all_ok &= check(f'log 字段 {key}', isinstance(log.get(key), list))
        for i, p in enumerate(log.get('posts',[])[:3]):
            all_ok &= check(f'post {i} 有 id', 'id' in p)
            all_ok &= check(f'post {i} 有 media', isinstance(p.get('media'), list))
    except Exception as e:
        all_ok &= check('解析 field_log.json', False)

# 3. 视频 presign + 直传 + 播放
code, body = post_json({'action':'presign','type':'video','ext':'mp4','contentType':'video/mp4'})
all_ok &= check('视频 presign', code == 200 and isinstance(body.get('url'), str))
if code == 200 and body.get('url'):
    code2, _ = put(body['url'], b'fake video', 'video/mp4')
    all_ok &= check('视频 PUT R2', code2 == 200)
    code3, _ = get('/media?key=' + body['key'])
    all_ok &= check('视频 GET /media', code3 == 200)

# 4. 图片 presign + 直传 + 播放
code, body = post_json({'action':'presign','type':'image','ext':'jpg','contentType':'image/jpeg'})
all_ok &= check('图片 presign', code == 200 and isinstance(body.get('url'), str))
if code == 200 and body.get('url'):
    code2, _ = put(body['url'], b'\xff\xd8\xff\xe0fake', 'image/jpeg')
    all_ok &= check('图片 PUT R2', code2 == 200)
    code3, _ = get('/media?key=' + body['key'])
    all_ok &= check('图片 GET /media', code3 == 200)

# 4.5 通用文件 presign（任务附件/PDF）
code, body = post_json({'action':'presign','type':'file','ext':'pdf','contentType':'application/pdf'})
all_ok &= check('文件 presign', code == 200 and isinstance(body.get('url'), str))
if code == 200 and body.get('url'):
    code2, _ = put(body['url'], b'%PDF-fake', 'application/pdf')
    all_ok &= check('文件 PUT R2', code2 == 200)
    code3, _ = get('/media?key=' + body['key'])
    all_ok &= check('文件 GET /media', code3 == 200)

# 5. 市场日报数据
code, body = post_json({'action':'read','path':'data/market_daily.json'})
all_ok &= check('读取 market_daily.json', code == 200 and 'content' in body)
if code == 200 and 'content' in body:
    try:
        mk = json.loads(body['content'])
        all_ok &= check('日报有播报稿', bool(mk.get('spoken')))
        all_ok &= check('日报有音频链接', bool(mk.get('audio')))
        all_ok &= check('日报有价格', isinstance(mk.get('prices'), list))
        if mk.get('audio'):
            code2, _ = get(mk['audio'])
            all_ok &= check('日报音频可下载', code2 == 200)
    except Exception:
        all_ok &= check('解析 market_daily.json', False)

# 6. SMM 价格与历史
code, body = post_json({'action':'read','path':'data/smm_prices.json'})
all_ok &= check('读取 smm_prices.json', code == 200 and 'content' in body)
if code == 200 and 'content' in body:
    try:
        smm = json.loads(body['content'])
        all_ok &= check('smm_prices 有行', len(smm.get('prices', [])) > 0)
    except Exception:
        all_ok &= check('解析 smm_prices.json', False)
code, body = post_json({'action':'read','path':'data/smm_history.json'})
all_ok &= check('读取 smm_history.json', code == 200 and 'content' in body)

# 7. 前端关键功能存在性（防止改动时弄丢函数）
code, html = get('/field_album.html')
for fn in ['toggleMiniMenu', 'editPostComment', 'delPostComment', 'toggleMarketBody',
           'renderUserChip', 'syncBusy', 'openImg', 'editPost', 'deletePost',
           'likePost', 'submitPostComment', 'editTask', 'deleteTask', 'deleteProject',
           'renderTodos', 'openTaskModal', 'pickAttach', 'toggleTodo', 'renderMyItems',
           'editProd', 'delProd', 'pullStartY']:
    all_ok &= check(f'前端函数 {fn}', code == 200 and fn in html)

# 7.4 矿权申请助手页面可达 + 裸域名落地现场相册（两个产品分开） + 关键前端函数存在
code, html = get('/')
all_ok &= check('根路径落回现场相册', code == 200 and ('Ecobox' in html or 'field_album' in html))
code, html = get('/license_helper.html')
all_ok &= check('license_helper.html 可访问', code == 200)
for fn in ['DOC_DEFS', 'runReview', 'genFromAI', 'genFromTemplate', 'parseCoord', 'syncPull', 'pickFile', 'effDoc', 'printDraft', 'renderCoDocs', 'renderTl', 'statusSet', 'exportPackage', 'textToPdfBlob', 'analyzeCo', 'analyzeText', 'extractPdfText', 'mergeProfile', 'delCo', 'normDate', 'docDate', 'openSrcDir', 'jsq', 'viewFile', 'closeViewer', 'renderCoExtra', 'addExtraDoc', 'coSrcDir', 'delCoDoc', 'shSet', 'shAdd', 'shDel', 'docDrop', 'saveBrief', 'parseBrief', 'genAllDocs', 'genAI', 'jumpWrite', 'autoFillApp', 'renderAppList', 'appMenu', 'editApp', 'saveAppEdit', 'delApp', 'renderAppSum', 'makeZip', 'crc32', 'genForm1', 'unzipDocx', 'form1Values', 'form1Checks', 'dmsParts', 'parseBriefFields', 'cSet', 'renderDirs', 'dirAdd', 'dirSet', 'dirDel', 'dirsEnsure']:
    all_ok &= check(f'license 前端 {fn}', code == 200 and fn in html)

# license 脚本括号/字符串配平（防"一个 } 丢了整页白屏"：2026-10 runReview 事故）
def js_balance(src):
    s = re.search(r'<script>([\s\S]*)</script>', src).group(1)
    BS = chr(92); ins = None; inclass = False; stack = []; last = ''
    i = 0
    while i < len(s):
        c = s[i]
        if c == '\n':
            if ins == 'lc': ins = None
            elif ins in ("'", '"'): return 'string newline'
            elif ins == 're': ins = None
            i += 1; continue
        if ins == 'lc': i += 1; continue
        if ins == 'bc':
            if c == '*' and s[i+1:i+2] == '/': ins = None; i += 2; continue
            i += 1; continue
        if ins == 're':
            if c == BS: i += 2; continue
            if c == '[': inclass = True; i += 1; continue
            if c == ']': inclass = False; i += 1; continue
            if c == '/' and not inclass: ins = None; last = '/'
            i += 1; continue
        if ins in ("'", '"', '`'):
            if c == BS: i += 2; continue
            if ins == '`' and c == '$' and s[i+1:i+2] == '{':
                stack.append('${'); i += 2; ins = None; continue
            if c == ins: ins = None
            i += 1; continue
        if c == '/' and s[i+1:i+2] == '/': ins = 'lc'; i += 2; continue
        if c == '/' and s[i+1:i+2] == '*': ins = 'bc'; i += 2; continue
        if c == '/' and last not in ')]}' and not (last.isalnum() or last in '_$'):
            ins = 're'; inclass = False; i += 1; continue
        if c in ('"', "'", '`'): ins = c; i += 1; continue
        if c in '([{': stack.append(c); last = c; i += 1; continue
        if c in ')]}':
            if not stack: return 'extra ' + c
            op = stack.pop()
            if c == '}' and op == '${': ins = '`'
            elif op != '${' and '([{'.index(op) != ')]}'.index(c): return 'mismatch ' + op + c
            last = c; i += 1; continue
        if not c.isspace(): last = c
        i += 1
    return ins or (stack[-1] if stack else '') or 'ok'
all_ok &= check('license JS 括号配平', code == 200 and js_balance(html) == 'ok')

# 7.5 矿权申请助手：数据文件读写 + AI 起草端点
code, body = post_json({'action':'read','path':'data/license_apps.json'})
all_ok &= check('license_apps.json 读取接口', code == 200 and 'content' in body)
code, body = post_json({'action':'draft','prompt':'Write one short English sentence about copper mining in Zambia.','system':'Answer briefly.'})
all_ok &= check('draft AI 起草端点', code == 200 and isinstance(body.get('text'), str) and len(body.get('text','')) > 0)

# 7.6 Worker /upload 代传通道（矿权申请助手 file:// 页面上传用）
try:
    boundary = 'smoketestboundary'
    payload = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="smoke.txt"\r\n'
               f'Content-Type: text/plain\r\n\r\nsmoke\r\n--{boundary}--\r\n').encode()
    req = urllib.request.Request(BASE + '/upload', data=payload, method='POST',
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}', 'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=25) as r:
        up = json.loads(r.read().decode('utf-8', errors='replace'))
    all_ok &= check('Worker /upload 代传', bool(up.get('key')))
    if up.get('key'):
        code2, _ = get('/media?key=' + up['key'])
        all_ok &= check('upload 文件可取回', code2 == 200)
except Exception:
    all_ok &= check('Worker /upload 代传', False)

# 8. 矿证台账（前端直连 franksync 的 cadastre_status.json）
req = urllib.request.Request('https://franksync.frankataix.workers.dev/',
    data=json.dumps({'action':'read','path':'frank_data/cadastre_status.json'}).encode(),
    method='POST', headers={'Content-Type':'application/json','User-Agent':UA})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        cad = json.loads(r.read().decode('utf-8', errors='replace'))
    ok = bool(cad.get('content'))
    all_ok &= check('矿证台账可读取', ok)
    if ok:
        try:
            d = json.loads(cad['content'])
            act = sum(1 for a in d.get('accounts',[]) for co in a.get('companies',[]) for l in co.get('licenses',[]) if (l.get('status') or '') == 'Active')
            all_ok &= check('矿证 Active 有数据', act > 0)
        except Exception:
            all_ok &= check('解析矿证台账', False)
except Exception:
    all_ok &= check('矿证台账可读取', False)

# 8.5 新域名（国内可访问）短链检查
try:
    req = urllib.request.Request('https://mine.ecoboxmine.com/u/test', headers={'User-Agent': UA})
    code = urllib.request.urlopen(req, timeout=25).status
    all_ok &= check('新域名 mine.ecoboxmine.com 可达', code in (200, 302))
except Exception:
    all_ok &= check('新域名 mine.ecoboxmine.com 可达', False)

# 9. 写路径端到端：建待办 → 读回验证 → 删除 → 再验证
def read_log():
    code, body = post_json({'action':'read','path':'data/field_log.json'})
    if code != 200 or 'content' not in body: return None
    return json.loads(body['content'])

test_id = 'smoke_test_todo'
try:
    log = read_log()
    if log is None:
        all_ok &= check('E2E 读日志', False)
    else:
        log.setdefault('todos', []).append({'id': test_id, 'title': '回测自检', 'createdBy': 'smoke_test', 'createdAt': '2026-01-01', 'done': False, 'comments': [], 'files': []})
        code, body = post_json({'action':'save','path':'data/field_log.json','content':json.dumps(log, ensure_ascii=False),'message':'smoke test todo'})
        all_ok &= check('E2E 写入待办', code == 200 and body.get('ok'))
        log2 = read_log()
        all_ok &= check('E2E 读回含待办', log2 is not None and any(t.get('id') == test_id for t in log2.get('todos', [])))
        log2['todos'] = [t for t in log2.get('todos', []) if t.get('id') != test_id]
        code, body = post_json({'action':'save','path':'data/field_log.json','content':json.dumps(log2, ensure_ascii=False),'message':'smoke test cleanup'})
        all_ok &= check('E2E 删除待办', code == 200 and body.get('ok'))
        log3 = read_log()
        all_ok &= check('E2E 删除已生效', log3 is not None and not any(t.get('id') == test_id for t in log3.get('todos', [])))
except Exception as e:
    all_ok &= check('E2E 写路径', False)
    print('E2E error:', e)

print('\n' + ('全部通过' if all_ok else '存在失败'))
sys.exit(0 if all_ok else 1)
