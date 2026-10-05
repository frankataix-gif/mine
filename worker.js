// ============================================
// ECOBOX 现场工具箱 — 统一 Cloudflare Worker
// 功能：托管门户 + 各子应用页面，统一登录，代理各 app 后端
//
// 路由：
//   GET  / 或 /index.html        → 门户首页（需登录）
//   GET  /mine_production.html   → 钽铌矿生产统计（需登录）
//   GET  /sampling_helper.html   → 矿区考察记录本（需登录）
//   GET  /sw.js /manifest /icon* → PWA 资源
//   GET  /photos/*               → 生产统计已同步照片（需登录）
//   POST /  {action:auth}        → 登录种 Cookie
//   POST /  {action:read/save}   → GitHub data/ 读写（生产统计）
//   POST /  {action:up_photo}    → GitHub photos/ 上传（生产统计）
//   POST /  {action:ocr}         → OCR.space XRF 读数（生产统计）
//   GET  /ping                   → 取样工具连通测试
//   POST /sample                 → D1 存样品（取样工具）
//   GET  /samples  /sample/<id>  → D1 样品列表 / 详情
//   DELETE /sample/<id>          → 删除样品
//   POST /ocr                    → OpenAI GPT-4o XRF 识别（取样工具）
//
// 部署方式（已配置好，改代码后一条 curl 即可）：
//   CF=$(cat "G:\我的云端硬盘\1 New 7-8\AgentAI\W\cloudflare_api_token.txt")
//   ACC=dff446b2b98a38ac2b82263e3ff14da9
//   curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACC/workers/scripts/mine-sync" \
//     -H "Authorization: Bearer $CF" \
//     -F 'metadata={"main_module":"worker.js","compatibility_date":"2026-09-19","bindings":[{"name":"AI","type":"ai"},{"name":"DB","type":"d1","id":"78e80331-66f2-486d-8d7a-d7cf906bc7a7"},{"name":"GITHUB_REPO","type":"plain_text","text":"frankataix-gif/mine"},{"name":"MEDIA_BUCKET","type":"r2_bucket","bucket_name":"ecobox-media"}]};type=application/json' \
//     -F 'worker.js=@worker.js;type=application/javascript+module'
//   （secret 类绑定 GITHUB_TOKEN / ACCESS_CODE 不传也会保留）
//
// 当前绑定/变量：
//   AI          = Workers AI 绑定（XRF 识别回退用）
//   DB          = D1 field_samples（考察记录本）
//   GITHUB_REPO = frankataix-gif/mine
//   GITHUB_TOKEN= secret，GitHub PAT（数据读写）
//   ACCESS_CODE = secret，万能密码（管理员，所有 app 通进）
//   USERS_JSON  = secret，用户表 [{"u":"用户名","p":"密码","apps":["mine","sampling"]}]
//                 apps:["*"] = 全部应用。加人/改密码 = 更新这个 secret
//   APP_TOKEN   = 可选，取样工具旧令牌兼容（未设）
//   OPENAI_KEY  = 可选，配了就用 GPT-4o，没配自动走 Workers AI
//
// 权限模型：门户 / 公开；进具体 app 才要登录（用户名+密码，或只用万能密码）。
// 新 app 在 HTML_PAGES 里声明 app key，然后给用户的 apps 数组加上该 key。
// ============================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Token'
};

// 路径 → 仓库文件 + 所需应用权限（app key；null = 门户公开页）
const HTML_PAGES = {
  '/':                { file: 'index.html',            app: null },
  '/index.html':      { file: 'index.html',            app: null },
  '/mine_production.html': { file: 'mine_production.html', app: 'mine' },
  '/sampling_helper.html': { file: 'sampling_helper.html', app: 'sampling' },
  '/field_album.html': { file: 'field_album.html', app: 'field' }
};

const DATA_PREFIX = 'data/';           // 只允许读写 data/ 目录
const DATA_FILE = 'data/production_log.json';

const LOGIN_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · Ecobox赞比亚</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{background:#fff;border-radius:12px;padding:28px;width:min(90%,340px);box-shadow:0 2px 8px rgba(0,0,0,.08)}
h1{font-size:17px;margin:0 0 18px;color:#1e293b}input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #e2e8f0;border-radius:8px;font-size:16px;margin-bottom:10px}
button{width:100%;margin-top:4px;padding:11px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:16px;min-height:44px}
.e{color:#ef4444;font-size:13px;margin-top:10px;min-height:18px}
.h{font-size:12px;color:#64748b;margin-top:12px}</style></head>
<body><div class="c"><h1>Ecobox赞比亚</h1>
<input type="text" id="un" placeholder="用户名（管理员可留空）" autocomplete="username">
<input type="password" id="pw" placeholder="密码" autocomplete="current-password">
<button id="go">进入</button><div class="e" id="err"></div>
<div class="h">账号密码错误或没有此应用权限时，会回到本页</div></div>
<script>
document.getElementById('go').onclick = async () => {
  const user = document.getElementById('un').value.trim();
  const pass = document.getElementById('pw').value.trim();
  if (!pass) return;
  const r = await fetch(location.pathname, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'auth',user,pass})});
  if (r.ok) { localStorage.setItem('mine_access_code', pass); location.reload(); }
  else document.getElementById('err').textContent = '密码错误';
};
document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('go').click(); });
</script></body></html>`;

function getCookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// 用户表：env.USERS_JSON = [{"u":"hxj","p":"xxx","apps":["mine","sampling"]}]
// apps 里 "*" 表示全部应用。ACCESS_CODE 为万能密码（Cookie 直接存它 = 管理员）。
function parseUsers(env) {
  try { return JSON.parse(env.USERS_JSON || '[]'); } catch { return []; }
}

// 返回 'admin' / 用户记录 / null
function authUser(request, env) {
  const c = getCookie(request, 'app_auth');
  if (!c) return null;
  if (env.ACCESS_CODE && c === env.ACCESS_CODE) return 'admin';
  const i = c.indexOf(':');
  if (i < 0) return null;
  const u = c.slice(0, i), p = c.slice(i + 1);
  return parseUsers(env).find(x => x.u === u && x.p === p) || null;
}

// 是否有任何有效登录（ACCESS_CODE 和用户表都没配 → 视为全开放）
function authed(request, env) {
  if (!env.ACCESS_CODE && !parseUsers(env).length) return true;
  return !!authUser(request, env);
}

// 某应用权限：admin / 用户 apps 含该 app 或 '*'
function canAccess(request, env, app) {
  if (!env.ACCESS_CODE && !parseUsers(env).length) return true;
  const a = authUser(request, env);
  if (a === 'admin') return true;
  if (!a) return false;
  return a.apps.includes('*') || a.apps.includes(app);
}

// 取样工具接口鉴权：该应用权限 或 旧 APP_TOKEN
function samplingAuthed(request, env) {
  if (canAccess(request, env, 'sampling')) return true;
  if (env.APP_TOKEN && request.headers.get('X-App-Token') === env.APP_TOKEN) return true;
  return !env.ACCESS_CODE && !env.APP_TOKEN && !parseUsers(env).length;
}

// 生产统计 / 现场相册 接口鉴权：该应用权限 或 body.code=ACCESS_CODE（旧 app 设置兼容）
function mineAuthed(request, env, body) {
  if (canAccess(request, env, 'mine')) return true;
  if (canAccess(request, env, 'field')) return true;
  if (env.ACCESS_CODE && body && (body.code === env.ACCESS_CODE || body.pass === env.ACCESS_CODE)) return true;
  return !env.ACCESS_CODE && !parseUsers(env).length;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

/* ================= GitHub 文件读写 ================= */

async function ghApi(env, path, method = 'GET', body = null) {
  const repo = env.GITHUB_REPO || 'frankataix-gif/mine';
  const branch = env.GITHUB_BRANCH || 'main';
  const url = `https://api.github.com/repos/${repo}/contents/${path}` + (method === 'GET' ? `?ref=${branch}` : '');
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'ecobox-tools-worker',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return res;
}

async function readFile(env, path) {
  const res = await ghApi(env, path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('GitHub read ' + res.status);
  const data = await res.json();
  const bin = atob(data.content.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return { sha: data.sha, content: new TextDecoder().decode(bytes) };
}

async function writeFile(env, path, content, message, sha) {
  const bytes = new TextEncoder().encode(content);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const body = { message: message || 'Data update', content: btoa(bin), branch: env.GITHUB_BRANCH || 'main' };
  if (sha) body.sha = sha;
  const res = await ghApi(env, path, 'PUT', body);
  const data = await res.json();
  if (!res.ok) return { error: data.message || 'GitHub ' + res.status };
  return { ok: true };
}

async function serveRepoFile(env, path, mime) {
  try {
    const f = await readFile(env, path);
    if (!f) return new Response('应用文件未部署到仓库：' + path, { status: 404, headers: CORS });
    return new Response(f.content, {
      headers: { ...CORS, 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate', 'Pragma': 'no-cache' }
    });
  } catch (e) {
    return new Response('读取失败: ' + e.message, { status: 502, headers: CORS });
  }
}

async function serveRepoBinary(env, path, mime) {
  try {
    const res = await ghApi(env, path);
    if (res.status === 404) return new Response('not found', { status: 404, headers: CORS });
    const data = await res.json();
    const bin = atob(data.content.replace(/\s+/g, ''));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    return new Response(bytes, {
      headers: { ...CORS, 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }
    });
  } catch (e) {
    return new Response('读取失败: ' + e.message, { status: 502, headers: CORS });
  }
}

/* ================= 取样工具 D1 ================= */

async function ensureSchema(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS samples(
      sample_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    )`
  ).run();
}

async function handleSampling(request, env, url) {
  if (!env.DB) return json({ ok: false, error: 'D1 未绑定（Settings→Bindings 加 DB→field_samples）' }, 500);
  await ensureSchema(env);

  if (url.pathname === '/ping') return json({ ok: true });

  // 存样品（upsert：同编号覆盖）
  if (url.pathname === '/sample' && request.method === 'POST') {
    const s = await request.json();
    if (!s.sample_id) return json({ ok: false, error: '缺 sample_id' }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO samples(sample_id,data,created_at,updated_at) VALUES(?,?,?,?)
       ON CONFLICT(sample_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`
    ).bind(s.sample_id, JSON.stringify(s), s.created_at || now, now).run();
    return json({ ok: true, name: s.sample_id });
  }

  // 样品列表（含完整数据）
  if (url.pathname === '/samples' && request.method === 'GET') {
    const r = await env.DB.prepare(
      `SELECT sample_id,data,created_at,updated_at FROM samples ORDER BY created_at DESC`
    ).all();
    return json({ ok: true, count: r.results.length, samples: r.results.map(x => ({ ...JSON.parse(x.data), _synced_at: x.updated_at })) });
  }

  // 单条 / 删除
  const m = url.pathname.match(/^\/sample\/(.+)$/);
  if (m) {
    const sid = decodeURIComponent(m[1]);
    if (request.method === 'GET') {
      const r = await env.DB.prepare(`SELECT data FROM samples WHERE sample_id=?`).bind(sid).first();
      return r ? json({ ok: true, sample: JSON.parse(r.data) }) : json({ ok: false, error: 'not found' }, 404);
    }
    if (request.method === 'DELETE') {
      await env.DB.prepare(`DELETE FROM samples WHERE sample_id=?`).bind(sid).run();
      return json({ ok: true });
    }
  }

  // GPT-4o 识别 XRF 屏幕读数
  if (url.pathname === '/ocr' && request.method === 'POST') {
    const { image } = await request.json();
    return await ocrAssay(image, env);
  }

  return json({ ok: false, error: 'not found' }, 404);
}

/** 识别 XRF 屏幕读数 → [{element, value, unit}]：优先 OpenAI，无 key 时回退 Workers AI */
async function ocrAssay(imageB64, env) {
  const PROMPT =
    '这是一张手持式XRF光谱仪屏幕的照片（矿石/土壤元素含量检测）。请读出屏幕上所有元素含量读数。' +
    '只返回JSON数组，不要任何其他文字：[{"element":"Cu","value":1.23,"unit":"%"}]。' +
    'unit 只取 %、ppm、g/t、ppb；读数带 <LOD 或 nd 的跳过；没有读数返回 []。';
  if (!env.OPENAI_KEY && env.AI) {
    try {
      const res = await env.AI.run('@cf/meta/llama-3.2-11b-vision-instruct', {
        messages: [{ role: 'user', content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } },
        ]}],
        max_tokens: 500,
      });
      const text = res?.response || res?.description || '[]';
      const m = String(text).match(/\[[\s\S]*\]/);
      const assays = JSON.parse(m ? m[0] : '[]');
      return json({ ok: true, assays, via: 'workers-ai' });
    } catch (e) {
      return json({ ok: false, error: 'Workers AI 识别失败: ' + e.message });
    }
  }
  if (!env.OPENAI_KEY) return json({ ok: false, error: 'OPENAI_KEY 未配置' }, 500);
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: PROMPT },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageB64}` } },
        ],
      }],
      max_tokens: 500,
    }),
  });
  const j = await r.json();
  if (!r.ok) return json({ ok: false, error: j }, r.status);
  const text = j.choices?.[0]?.message?.content || '[]';
  try {
    const m = text.match(/\[[\s\S]*\]/);
    const assays = JSON.parse(m ? m[0] : '[]');
    return json({ ok: true, assays });
  } catch {
    return json({ ok: false, error: 'AI 返回无法解析: ' + text.slice(0, 200) });
  }
}

/* ================= 生产统计 OCR.space XRF 识别 ================= */

async function ocrSpace(img, env) {
  const fd = new URLSearchParams({
    apikey: env.OCR_KEY || 'helloworld',
    base64Image: img,
    isOverlayRequired: 'false',
    detectOrientation: 'true',
    scale: 'true',
    isTable: 'true',
    OCREngine: '2'
  });
  const r = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
    body: fd.toString()
  });
  const j = await r.json();
  let text = (j.ParsedResults && j.ParsedResults[0] && j.ParsedResults[0].ParsedText) || '';
  if (!text) return json({ error: (j.ErrorMessage || 'ocr empty'), elements: null });
  // 屏幕行序固定：Ta, Nb, Bal, Hf, Zr, Bi, As, Fe, Mn, Ti
  const ROWS = ['Ta', 'Nb', 'Bal', 'Hf', 'Zr', 'Bi', 'As', 'Fe', 'Mn', 'Ti'];
  text = text.replace(/(\d)[_](\d)/g, '$1.$2');
  const parts = text.split(/\+\/-|\bsec\b/i);
  const tail = parts.length > 1 ? parts.slice(-1)[0] : text;
  const elements = {};
  let ptr = 0, pending = null, skipNext = false;
  for (const line of tail.split('\n').map(l => l.trim()).filter(Boolean)) {
    const nums = (line.match(/\d+(\.\d+)?/g) || []).map(Number).filter(n => n <= 150);
    const tok = (line.match(/\b([A-Za-z]{2,4})\b/) || [])[1];
    const isLabel = tok && ROWS.some(e => e.toLowerCase() === tok.toLowerCase());
    if (isLabel && !nums.length) {
      pending = ROWS.find(e => e.toLowerCase() === tok.toLowerCase());
      const ti = ROWS.indexOf(pending);
      if (ti > ptr) ptr = ti;
      skipNext = false;
      continue;
    }
    for (const n of nums) {
      if (skipNext) { skipNext = false; continue; }
      let el = null;
      if (pending && elements[pending] == null) el = pending;
      else { while (ptr < ROWS.length && elements[ROWS[ptr]] != null) ptr++; el = ROWS[ptr] || null; }
      if (!el) break;
      elements[el] = n; pending = null; skipNext = true; ptr++;
    }
  }
  return json({ ok: true, elements, raw: text });
}

/* ================= Telegram Bot ================= */

async function tgApi(token, path) {
  const r = await fetch('https://api.telegram.org/bot' + token + path);
  return await r.json();
}

async function addTelegramPost(env, text, media, uploader) {
  const path = 'data/field_log.json';
  const existing = await readFile(env, path);
  const log = existing ? JSON.parse(existing.content) : { projects: [], tasks: [], production: [], posts: [], updatedAt: '' };
  if (!log.projects) log.projects = [];
  if (!log.tasks) log.tasks = [];
  if (!log.production) log.production = [];
  if (!log.posts) log.posts = [];
  log.posts.unshift({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    note: text || '',
    uploader,
    createdAt: new Date().toISOString(),
    media,
    likes: [],
    comments: []
  });
  log.updatedAt = new Date().toISOString();
  await writeFile(env, path, JSON.stringify(log, null, 2), 'telegram post', existing?.sha);
}

async function handleTelegram(request, env) {
  if (!env.TG_BOT_TOKEN) return new Response('no token', { status: 500 });
  const upd = await request.json().catch(() => ({}));
  const msg = upd.message;
  if (!msg) return new Response('ok');
  const chatId = msg.chat.id;
  const from = msg.from || {};
  const uploader = (from.first_name || '') + (from.last_name ? ' ' + from.last_name : '') || from.username || 'Telegram';
  const caption = msg.caption || '';
  if (msg.video) {
    await addTelegramPost(env, caption, [{ type: 'tgVideo', fileId: msg.video.file_id }], uploader);
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage?chat_id=' + chatId + '&text=' + encodeURIComponent('视频已发布到动态'));
    return new Response('ok');
  }
  if (msg.photo && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    await addTelegramPost(env, caption, [{ type: 'tgPhoto', fileId: largest.file_id }], uploader);
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage?chat_id=' + chatId + '&text=' + encodeURIComponent('照片已发布到动态'));
    return new Response('ok');
  }
  if (msg.text) {
    await addTelegramPost(env, msg.text, [], uploader);
    await fetch('https://api.telegram.org/bot' + env.TG_BOT_TOKEN + '/sendMessage?chat_id=' + chatId + '&text=' + encodeURIComponent('消息已发布到动态'));
    return new Response('ok');
  }
  return new Response('ok');
}

async function proxyTelegramFile(request, env, kind) {
  if (!env.TG_BOT_TOKEN) return new Response('no token', { status: 500 });
  const url = new URL(request.url);
  const fid = url.searchParams.get('fid');
  if (!fid) return new Response('no fid', { status: 400 });
  const info = await tgApi(env.TG_BOT_TOKEN, '/getFile?file_id=' + encodeURIComponent(fid));
  if (!info.ok || !info.result?.file_path) return new Response('file not found', { status: 404 });
  const fileUrl = 'https://api.telegram.org/file/bot' + env.TG_BOT_TOKEN + '/' + info.result.file_path;
  const r = await fetch(fileUrl);
  if (!r.ok) return new Response('telegram error', { status: 502 });
  const type = kind === 'photo' ? 'image/jpeg' : 'video/mp4';
  return new Response(r.body, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' } });
}

/* ================= R2 媒体上传/播放 ================= */

async function handleUpload(request, env) {
  if (!env.MEDIA_BUCKET) return new Response('no bucket', { status: 500 });
  let form;
  try { form = await request.formData(); } catch (e) { return json({ error: 'invalid form' }, 400); }
  const file = form.get('file');
  if (!file) return json({ error: 'no file' }, 400);
  const now = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const isVideo = (file.type || '').startsWith('video/');
  const ext = (file.name || '').split('.').pop() || 'bin';
  const key = `media/${now}_${rand}.${isVideo ? 'mp4' : ext}`;
  const contentType = isVideo ? 'video/mp4' : (file.type || 'application/octet-stream');
  await env.MEDIA_BUCKET.put(key, file, { httpMetadata: { contentType } });
  return json({ ok: true, key });
}

async function serveMedia(request, env) {
  if (!env.MEDIA_BUCKET) return new Response('no bucket', { status: 500 });
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return new Response('no key', { status: 400 });
  if (!canAccess(request, env, 'field') && !canAccess(request, env, 'mine')) return new Response('unauthorized', { status: 401, headers: CORS });
  const obj = await env.MEDIA_BUCKET.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata.contentType || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' } });
}

/* ================= R2 直传签名 ================= */

const R2_ACCOUNT = 'dff446b2b98a38ac2b82263e3ff14da9';
const R2_BUCKET = 'ecobox-media';
const R2_REGION = 'auto';
const R2_SERVICE = 's3';
const R2_HOST = `${R2_ACCOUNT}.r2.cloudflarestorage.com`;
const R2_EXPIRES = '900';

function hexBytes(b) { return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''); }
async function sha256Text(message) {
  const enc = new TextEncoder();
  return crypto.subtle.digest('SHA-256', enc.encode(message));
}
async function hmacSha256(key, message) {
  const k = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const c = await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', c, new TextEncoder().encode(message));
}
async function getSignatureKey(secret, date, region, service) {
  const k1 = await hmacSha256('AWS4' + secret, date);
  const k2 = await hmacSha256(k1, region);
  const k3 = await hmacSha256(k2, service);
  return hmacSha256(k3, 'aws4_request');
}
async function r2Presign(env, method, key, contentType) {
  const access = env.R2_ACCESS_KEY_ID;
  const secret = env.R2_SECRET_ACCESS_KEY;
  if (!access || !secret) throw new Error('no r2 keys');
  const now = new Date();
  const pad = n => n.toString().padStart(2, '0');
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const ts = `${date}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const credential = encodeURIComponent(`${access}/${date}/${R2_REGION}/${R2_SERVICE}/aws4_request`);
  const signedHeaders = 'content-type;host';
  const params = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', ts],
    ['X-Amz-Expires', R2_EXPIRES],
    ['X-Amz-SignedHeaders', encodeURIComponent(signedHeaders)]
  ];
  const query = params.map(([k, v]) => `${encodeURIComponent(k)}=${v}`).join('&');
  const headers = `content-type:${contentType}\nhost:${R2_HOST}\n`;
  const canonical = `${method}\n/${R2_BUCKET}/${key}\n${query}\n${headers}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const canonicalHash = hexBytes(await sha256Text(canonical));
  const skey = await getSignatureKey(secret, date, R2_REGION, R2_SERVICE);
  const str = `AWS4-HMAC-SHA256\n${ts}\n${date}/${R2_REGION}/${R2_SERVICE}/aws4_request\n${canonicalHash}`;
  const sig = hexBytes(await hmacSha256(skey, str));
  return `https://${R2_HOST}/${R2_BUCKET}/${key}?${query}&X-Amz-Signature=${sig}`;
}

// ---- SMM 行情：由用户本机脚本抓取后 POST 到 market_smm，存 data/smm_prices.json ----
async function smmPrices(env) {
  try {
    const f = await readFile(env, 'data/smm_prices.json');
    if (!f || !f.content) return [];
    const d = JSON.parse(f.content);
    if (Date.now() - new Date(d.fetchedAt).getTime() > 72 * 3600e3) return [];
    return d.prices || [];
  } catch (e) { return []; }
}

// ---- 钽铌市场日报：存 data/market_daily.json ----
// 有 OPENAI_KEY → GPT-4o 联网搜索（含价格摘要）；否则 → Google News RSS + Workers AI 翻译摘要
async function marketRefresh(env) {
  try {
    const smmRows = await smmPrices(env);
    let parsed = null;
    if (env.OPENAI_KEY) {
      const prompt = `你是钽铌市场分析助手。请联网搜索今天（北京时间）钽铌市场公开信息，输出严格 JSON（不要 markdown 围栏，不要多余文字）：
{"prices":[{"name":"品名","value":"价格区间","unit":"单位","note":"涨跌/来源"}],"news":[{"title":"标题","summary":"一句话摘要","impact":"利多/利空/中性"}],"advice":"一句话操作建议","spoken":"80-120字中文口播稿，口语化，把最重要的行情和新闻串成一段话，适合直接朗读"}
要求：
- prices 覆盖：钽精矿 Ta2O5 30%（CIF 中国，美元/磅 或 人民币元/吨度）、铌精矿 Nb2O5 50%、氧化钽 Ta2O5 99.5% 出厂价、氧化铌 Nb2O5 99.5% 出厂价；找不到确切报价就写"暂无公开报价"并在 note 注明最近参考价与日期
- news 覆盖：刚果（金）Rubaya 及东部矿区、卢旺达、尼日利亚供给动态；国内冶炼厂（宁夏东方钽业、九江有色等）开工/招标；ITSCI/RMAP 合规动态；关税/物流/宏观对矿价影响；最多 6 条按影响力排序
- advice 针对非洲矿山直供的钽铌精矿生产商（伴生锡）：当前适合现货快出货、锁长单、还是观望惜售
- 不确定的价格标注"约"，并尽量注明来源与时间`;
      const res = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.OPENAI_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', tools: [{ type: 'web_search_preview' }], input: prompt })
      });
      const data = await res.json();
      if (!res.ok) return { error: 'openai: ' + ((data.error && data.error.message) || res.status) };
      let text = '';
      for (const item of data.output || []) {
        if (item.type === 'message') for (const c of item.content || []) if (c.type === 'output_text') text += c.text;
      }
      const m = text.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }

    // 免费路径：Bing News RSS + Workers AI 翻译摘要
    if (!parsed) {
      const arts = [];
      const rssUrls = [
        'https://www.bing.com/news/search?q=' + encodeURIComponent('钽 铌 钽铌矿 价格') + '&format=rss&setlang=zh-CN',
        'https://www.bing.com/news/search?q=' + encodeURIComponent('钽铌矿 刚果 卢旺达 非洲 供应') + '&format=rss&setlang=zh-CN',
        'https://www.bing.com/news/search?q=' + encodeURIComponent('东方钽业 铌铁 钽电容 需求') + '&format=rss&setlang=zh-CN',
        'https://www.bing.com/news/search?q=' + encodeURIComponent('tantalum niobium coltan mining price') + '&format=rss&setlang=en-US',
        'https://www.bing.com/news/search?q=' + encodeURIComponent('coltan tantalum DRC Rwanda Congo mining export') + '&format=rss&setlang=en-US',
        'https://www.bing.com/news/search?q=' + encodeURIComponent('tantalum capacitor demand semiconductor supply') + '&format=rss&setlang=en-US'
      ];
      for (const ru of rssUrls) {
        try {
          const rss = await (await fetch(ru, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
          for (const m of rss.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
            const it = m[1];
            const grab = tag => ((it.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>')) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
            const clean = s => s.replace(/[ -"\\]/g, ' ').slice(0, 160);
            const title = clean(grab('title')), pub = grab('pubDate'), src = grab('News:Source'), desc = clean(grab('description')), link = grab('link');
            if (title) arts.push({ title, date: pub, src, desc, url: link });
          }
        } catch (e) {}
      }
      const seenT = new Set();
      for (let i = arts.length - 1; i >= 0; i--) {
        if (seenT.has(arts[i].title)) arts.splice(i, 1); else seenT.add(arts[i].title);
      }
      parsed = { prices: [], news: arts.slice(0, 6).map(a => ({ title: a.title, summary: a.desc || a.src, impact: '中性', url: a.url })), advice: '' };
      // AI 把素材整理成一段播报稿（纯文本，不要 JSON）
      if (env.AI && arts.length) {
        const list = arts.slice(0, 24).map((a, i) => `${i + 1}. ${a.title} — ${a.desc}（${a.src}）`).join('\n');
        const smmText = smmRows && smmRows.length ? '\n今日上海有色网(SMM)实时行情：' + smmRows.map(p => `${p.name} ${p.value}${p.unit}（${p.note}）`).join('；') + '。\n' : '';
        const today = new Date(Date.now() + 8 * 3600e3);
        const dateStr = `${today.getUTCMonth() + 1}月${today.getUTCDate()}日`;
        const aiPrompt = `你是行业新闻播音员。根据以下钽铌（tantalum/niobium/coltan）实时行情和最新新闻素材，写一段今日行业播报稿。
要求：
- 开头："各位好，今天是${dateStr}，为您播报钽铌行业动态。"
- 先报今日行情（钽矿到岸价、五氧化二钽、五氧化二铌、铌铁等真实价格）
- 再讲新闻，分三个层面归纳：上游矿山供应（重点非洲：刚果金、卢旺达、尼日利亚等矿区的停复产、出口、政策）、下游冶炼生产（东方钽业等国内厂商动态）、行业需求（电子、半导体、AI、高温合金等对钽铌的拉动）
- 只采用最新的素材，过期旧闻忽略；不要逐条念标题，要归纳成连贯的新闻语言
- 英文素材翻成中文
- 结尾加一句对非洲钽铌精矿生产商的操作建议
- 总长300-400字，可直接朗读，不要任何标题、列表符号或多余说明
${smmText}新闻素材：
${list}`;
        const MODELS = ['@cf/meta/llama-4-scout-17b-16e-instruct', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', '@cf/meta/llama-3.2-3b-instruct'];
        let lastErr = '';
        for (const mdl of MODELS) {
          try {
            const ar = await env.AI.run(mdl, { messages: [{ role: 'user', content: aiPrompt }], max_tokens: 900 });
            const t = ((ar && (ar.response || ar.result)) || '').trim();
            if (t.length > 80) {
              parsed.spoken = t.replace(/\*\*|#+|\n\s*[-•*]/g, '').replace(/\n{2,}/g, '。').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ').replace(/。{2,}/g, '。').trim();
              parsed.aiModel = mdl;
              break;
            } else lastErr = mdl + ' 输出过短';
          } catch (e) { lastErr = mdl + ': ' + e.message; }
        }
        if (!parsed.spoken) parsed.aiError = lastErr;
      }
    }

    // 价格：SMM 真实行情优先；没有则只留 AI 给的真实报价，否则空数组（前端不显示）
    if (smmRows.length) parsed.prices = smmRows;
    if (parsed.prices && parsed.prices.length) {
      parsed.prices = parsed.prices.filter(p => p.value && !/暂无|未知|NA/i.test(p.value));
    }
    if (!parsed.prices) parsed.prices = [];

    // 口播稿：AI 已给就用，没有就从新闻拼
    if (!parsed.spoken) {
      const n = (parsed.news || []).slice(0, 5);
      parsed.spoken = '钽铌市场简报。' + n.map((x, i) => `第${i + 1}条，${x.title}。`).join('') +
        (parsed.advice ? '操作建议：' + parsed.advice : '');
    }
    // 语音播报：MeloTTS 生成真人感 MP3 → 存 R2，前端 <audio> 播放
    if (parsed.spoken && env.MEDIA_BUCKET) {
      try {
        const audio = await env.AI.run('@cf/myshell-ai/melotts', { prompt: parsed.spoken, lang: 'zh' });
        let buf = null;
        if (audio instanceof Response) buf = await audio.arrayBuffer();
        else if (audio instanceof ArrayBuffer || audio instanceof Uint8Array) buf = audio;
        else if (audio && typeof audio.audio === 'string') {
          // base64 返回
          const b64 = audio.audio.replace(/^data:[^,]*,/, '');
          buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
        } else if (audio && audio.audio && audio.audio instanceof ArrayBuffer) buf = audio.audio;
        else parsed.audioError = 'unknown resp: ' + (typeof audio) + ' ' + JSON.stringify(audio).slice(0, 120);
        if (buf && (buf.byteLength || buf.length) > 2000) {
          await env.MEDIA_BUCKET.put('market/daily.wav', buf, { httpMetadata: { contentType: 'audio/wav' } });
          parsed.audio = '/media?key=market/daily.wav';
        } else if (!parsed.audioError) parsed.audioError = 'empty audio';
      } catch (e) { parsed.audioError = String(e).slice(0, 200); }
    }
    parsed.updatedAt = new Date().toISOString();
    const path = 'data/market_daily.json';
    const existing = await readFile(env, path);
    const wr = await writeFile(env, path, JSON.stringify(parsed, null, 2), 'market daily', existing && existing.sha);
    if (!wr.ok) return { error: wr.error || 'save failed' };
    return { ok: true, updatedAt: parsed.updatedAt };
  } catch (e) { return { error: e.message }; }
}

/* ================= 主入口 ================= */

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

      const url = new URL(request.url);
      const p = url.pathname;

      // ---- GET ----
      if (request.method === 'GET') {
        // 取样工具 API
        if (p === '/ping' || p === '/samples' || p.startsWith('/sample/')) {
          if (!samplingAuthed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
          return await handleSampling(request, env, url);
        }

        // 根路径直接进动态页（门户首页仍可从 /index.html 访问）
        if (p === '/') {
          const u = new URL(request.url);
          u.pathname = '/field_album.html';
          u.searchParams.set('v', Date.now().toString());
          return Response.redirect(u.toString(), 302);
        }

        // 页面：门户公开，各 app 按权限拦截
        if (HTML_PAGES[p]) {
          const pg = HTML_PAGES[p];
          if (pg.app && !canAccess(request, env, pg.app)) {
            return new Response(LOGIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
          }
          // field_album 强制去缓存：无 v 参数时重定向到 ?v=时间戳（保留 user 等参数）
          if (p === '/field_album.html' && !url.searchParams.has('v')) {
            const u = new URL(request.url);
            u.searchParams.set('v', Date.now().toString());
            return Response.redirect(u.toString(), 302);
          }
          return serveRepoFile(env, pg.file, 'text/html');
        }

        // Service Worker（公开，登录页不会被误存为 app——网络优先策略会纠正）
        if (p === '/sw.js') {
          return serveRepoFile(env, 'sw.js', 'application/javascript');
        }

        // PWA 清单与图标
        if (p === '/manifest.webmanifest') return serveRepoFile(env, 'manifest.webmanifest', 'application/manifest+json');
        if (p === '/icon-192.png' || p === '/icon-512.png') return serveRepoBinary(env, p.slice(1), 'image/png');
        if (p === '/icon.svg') return serveRepoFile(env, 'icon.svg', 'image/svg+xml');

        // 生产统计 / 现场相册 已同步照片（需 mine 或 field 权限）
        if (p.startsWith('/photos/')) {
          if (!canAccess(request, env, 'mine') && !canAccess(request, env, 'field')) return new Response('unauthorized', { status: 401, headers: CORS });
          return serveRepoBinary(env, p.slice(1), 'image/jpeg');
        }

        // Telegram 媒体代理
        if (p === '/tgvideo') return proxyTelegramFile(request, env, 'video');
        if (p === '/tgphoto') return proxyTelegramFile(request, env, 'photo');

        // R2 媒体代理
        if (p === '/media') return serveMedia(request, env);

        return new Response('OK', { headers: CORS });
      }

      // ---- R2 媒体上传 ----
      if (p === '/upload' && request.method === 'POST') return handleUpload(request, env);

      // ---- Telegram 机器人 Webhook ----
      if (p === '/telegram' && request.method === 'POST') return handleTelegram(request, env);

      // ---- 取样工具 API（POST/DELETE）----
      if (p === '/sample' || p === '/ocr' || p.startsWith('/sample/')) {
        if (!samplingAuthed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
        return await handleSampling(request, env, url);
      }

      if (request.method !== 'POST') return new Response('Only GET/POST', { status: 405, headers: CORS });

      // ---- 生产统计 / 门户 API：POST / ----
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid body' }, 400); }

      // 登录：管理员密码（body.pass 或旧 body.code）或 用户名+密码 → 种 Cookie
      if (body.action === 'auth') {
        const pass = body.pass || body.code || '';
        const user = (body.user || '').trim();
        // 万能密码：只看密码，用户名为空也行
        if (env.ACCESS_CODE && pass === env.ACCESS_CODE) {
          return new Response(JSON.stringify({ ok: true, admin: true }), {
            headers: { ...CORS, 'Content-Type': 'application/json', 'Set-Cookie': `app_auth=${encodeURIComponent(env.ACCESS_CODE)}; Path=/; Max-Age=31536000; SameSite=Lax` }
          });
        }
        const rec = parseUsers(env).find(x => x.u === user && x.p === pass);
        if (rec) {
          return new Response(JSON.stringify({ ok: true, user: rec.u, apps: rec.apps }), {
            headers: { ...CORS, 'Content-Type': 'application/json', 'Set-Cookie': `app_auth=${encodeURIComponent(rec.u + ':' + rec.p)}; Path=/; Max-Age=31536000; SameSite=Lax` }
          });
        }
        if (!env.ACCESS_CODE && !parseUsers(env).length) return json({ ok: true });
        return json({ error: '账号或密码错误' }, 401);
      }

      // 微信小程序登录：code → openid
      if (body.action === 'login') {
        const code = body.code || '';
        const appid = env.WEAPP_APPID || '';
        const secret = env.WEAPP_SECRET || '';
        if (!appid || !secret || !code) return json({ error: 'login not configured' }, 400);
        const res = await fetch(`https://api.weixin.qq.com/sns/jscode2session?appid=${appid}&secret=${secret}&js_code=${code}&grant_type=authorization_code`);
        const data = await res.json();
        if (data.openid) return json({ ok: true, openid: data.openid });
        return json({ error: data.errmsg || 'login failed' }, 400);
      }

      if (!mineAuthed(request, env, body)) return json({ error: '访问密码错误' }, 401);

      // XRF照片识别：OCR.space
      if (body.action === 'ocr') {
        const img = body.images && body.images[0];
        if (!img) return json({ error: 'no image' }, 400);
        try {
          return await ocrSpace(img, env);
        } catch (e) { return json({ error: 'ocr failed: ' + e.message }, 500); }
      }

      // 照片上传：存为仓库独立文件，记录里只存 ph:路径
      if (body.action === 'up_photo') {
        const name = (body.name || '').replace(/[^\w.-]/g, '');
        if (!name || !body.b64 || typeof body.b64 !== 'string' || body.b64.length > 4000000) {
          return json({ error: 'bad photo' }, 400);
        }
        const existing = await readFile(env, 'photos/' + name);
        if (existing) return json({ ok: true, path: 'photos/' + name });
        const res = await ghApi(env, 'photos/' + name, 'PUT', {
          message: 'photo ' + name, content: body.b64, branch: env.GITHUB_BRANCH || 'main'
        });
        if (!res.ok) { const d = await res.json(); return json({ error: d.message || 'GitHub ' + res.status }); }
        return json({ ok: true, path: 'photos/' + name });
      }

      // 直传 R2 预签名 URL
      if (body.action === 'presign') {
        const type = body.type === 'image' ? 'image' : 'video';
        const ext = type === 'image' ? 'jpg' : 'mp4';
        const contentType = type === 'image' ? 'image/jpeg' : 'video/mp4';
        const now = Date.now();
        const rand = Math.random().toString(36).slice(2, 8);
        const key = `media/${now}_${rand}.${ext}`;
        const url = await r2Presign(env, 'PUT', key, contentType);
        return json({ ok: true, key, url });
      }

      // 钽铌市场日报（手动刷新；cron 每天定时自动跑）
      if (body.action === 'market_refresh') {
        return json(await marketRefresh(env));
      }

      // 本机脚本上传 Edge-TTS MP3 → 覆盖 market_daily.json 的 audio 字段
      if (body.action === 'market_audio') {
        if (!env.MEDIA_BUCKET) return json({ error: 'no bucket' });
        const b64 = (body.audio || '').replace(/^data:[^,]*,/, '');
        if (!b64) return json({ error: 'no audio' });
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        await env.MEDIA_BUCKET.put('market/daily.mp3', bytes, { httpMetadata: { contentType: 'audio/mpeg' } });
        const path = 'data/market_daily.json';
        const existing = await readFile(env, path);
        if (existing && existing.content) {
          const d = JSON.parse(existing.content);
          d.audio = '/media?key=market/daily.mp3';
          await writeFile(env, path, JSON.stringify(d, null, 2), 'market audio', existing.sha);
        }
        return json({ ok: true });
      }

      // SMM 行情（本机脚本 POST 上来，存 data/smm_prices.json + 追加历史）
      if (body.action === 'market_smm') {
        const path = 'data/smm_prices.json';
        const existing = await readFile(env, path);
        const wr = await writeFile(env, path, JSON.stringify({ fetchedAt: new Date().toISOString(), prices: body.prices || [] }, null, 2), 'smm prices', existing && existing.sha);
        try {
          const hp = 'data/smm_history.json';
          const hf = await readFile(env, hp);
          let hist = [];
          try { hist = hf && hf.content ? JSON.parse(hf.content) : []; } catch (e) {}
          if (!Array.isArray(hist)) hist = [];
          const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
          hist = hist.filter(r => r.date !== day);
          hist.push({ date: day, prices: body.prices || [] });
          if (hist.length > 500) hist = hist.slice(-500);
          await writeFile(env, hp, JSON.stringify(hist, null, 1), 'smm history', hf && hf.sha);
        } catch (e) {}
        return json(wr.ok ? { ok: true } : { error: wr.error || 'save failed' });
      }

      // 数据读写（只允许 data/ 目录）
      const path = body.path || DATA_FILE;
      if (!path.startsWith(DATA_PREFIX)) return json({ error: 'forbidden path' }, 403);

      if (body.action === 'read') {
        const f = await readFile(env, path);
        return json({ content: f ? f.content : null });
      }

      if (body.action === 'save') {
        const existing = await readFile(env, path);
        const result = await writeFile(env, path, body.content || '', body.message, existing?.sha);
        return json(result);
      }

      return json({ error: 'unknown action' }, 400);
    } catch (e) {
      return json({ error: e.message || 'internal error' }, 500);
    }
  },

  // 每天北京时间 18:00（UTC 10:00）自动生成市场日报
  async scheduled(event, env, ctx) {
    ctx.waitUntil(marketRefresh(env));
  }
};
