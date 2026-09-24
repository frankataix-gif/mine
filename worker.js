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
// 部署步骤：
// 1. GitHub 仓库 frankataix-gif/mine 上传：index.html、sw.js、manifest.webmanifest、
//    mine_production.html、sampling_helper.html、icon-192.png、icon-512.png、icon.svg
//    （build_deploy.py 已把这些收集到 repo_bundle/）
// 2. Cloudflare → Workers & Pages → 打开现在生产统计用的 Worker → Edit code →
//    粘贴本文件 → Deploy
// 3. Worker → Settings → Bindings → Add binding → D1 database：
//      Variable name = DB，选现有 field_samples 库（数据无缝衔接）
// 4. Worker → Settings → Variables and Secrets 确认/添加：
//      GITHUB_TOKEN = 原 GitHub PAT（已有）
//      GITHUB_REPO  = frankataix-gif/mine（已有）
//      ACCESS_CODE  = 门户统一访问密码（已有）
//      APP_TOKEN    = 取样工具旧令牌（可选，兼容旧部署；留空也行——登录 Cookie 即可）
//      OPENAI_KEY   = 取样工具 AI 识别用（可选，从旧 Worker 复制）
//      OCR_KEY      = OCR.space key（可选，原有逻辑）
// 5. 手机打开 Worker 地址 → 登录 → 浏览器菜单"添加到主屏幕"，只装这一个图标
// ============================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-App-Token'
};

const HTML_PAGES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/mine_production.html': 'mine_production.html',
  '/sampling_helper.html': 'sampling_helper.html'
};

const DATA_PREFIX = 'data/';           // 只允许读写 data/ 目录
const DATA_FILE = 'data/production_log.json';

const LOGIN_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · ECOBOX 现场工具箱</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{background:#fff;border-radius:12px;padding:28px;width:min(90%,340px);box-shadow:0 2px 8px rgba(0,0,0,.08)}
h1{font-size:17px;margin:0 0 18px;color:#1e293b}input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #e2e8f0;border-radius:8px;font-size:16px}
button{width:100%;margin-top:12px;padding:11px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:16px;min-height:44px}
.e{color:#ef4444;font-size:13px;margin-top:10px;min-height:18px}</style></head>
<body><div class="c"><h1>ECOBOX 现场工具箱</h1>
<input type="password" id="pw" placeholder="访问密码" autocomplete="current-password">
<button id="go">进入</button><div class="e" id="err"></div></div>
<script>
document.getElementById('go').onclick = async () => {
  const code = document.getElementById('pw').value.trim();
  if (!code) return;
  const r = await fetch('/', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'auth',code})});
  if (r.ok) { localStorage.setItem('mine_access_code', code); location.reload(); }
  else document.getElementById('err').textContent = '密码错误';
};
document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('go').click(); });
</script></body></html>`;

function getCookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

// 门户登录态（Cookie）
function authed(request, env) {
  if (!env.ACCESS_CODE) return true;
  return getCookie(request, 'app_auth') === env.ACCESS_CODE;
}

// 取样工具接口鉴权：门户 Cookie 或旧 APP_TOKEN 二选一
function samplingAuthed(request, env) {
  if (authed(request, env)) return true;
  if (env.APP_TOKEN && request.headers.get('X-App-Token') === env.APP_TOKEN) return true;
  return !env.ACCESS_CODE && !env.APP_TOKEN;
}

// 生产统计接口鉴权：body.code 或门户 Cookie 二选一
function mineAuthed(request, env, body) {
  if (authed(request, env)) return true;
  if (env.ACCESS_CODE && body && body.code === env.ACCESS_CODE) return true;
  return !env.ACCESS_CODE;
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
      headers: { ...CORS, 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-cache' }
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

/** GPT-4o 识别 XRF 屏幕读数 → [{element, value, unit}] */
async function ocrAssay(imageB64, env) {
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
          { type: 'text', text:
            '这是一张手持式XRF光谱仪屏幕的照片（矿石/土壤元素含量检测）。请读出屏幕上所有元素含量读数。' +
            '只返回JSON数组，不要任何其他文字：[{"element":"Cu","value":1.23,"unit":"%"}]。' +
            'unit 只取 %、ppm、g/t、ppb；读数带 <LOD 或 nd 的跳过；没有读数返回 []。' },
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

        // 页面
        if (HTML_PAGES[p]) {
          if (!authed(request, env)) {
            return new Response(LOGIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
          }
          return serveRepoFile(env, HTML_PAGES[p], 'text/html');
        }

        // Service Worker（登录后才允许注册，避免缓存登录页）
        if (p === '/sw.js') {
          if (!authed(request, env)) return new Response('unauthorized', { status: 401, headers: CORS });
          return serveRepoFile(env, 'sw.js', 'application/javascript');
        }

        // PWA 清单与图标
        if (p === '/manifest.webmanifest') return serveRepoFile(env, 'manifest.webmanifest', 'application/manifest+json');
        if (p === '/icon-192.png' || p === '/icon-512.png') return serveRepoBinary(env, p.slice(1), 'image/png');
        if (p === '/icon.svg') return serveRepoFile(env, 'icon.svg', 'image/svg+xml');

        // 生产统计已同步照片
        if (p.startsWith('/photos/')) {
          if (!authed(request, env)) return new Response('unauthorized', { status: 401, headers: CORS });
          return serveRepoBinary(env, p.slice(1), 'image/jpeg');
        }

        return new Response('OK', { headers: CORS });
      }

      // ---- 取样工具 API（POST/DELETE）----
      if (p === '/sample' || p === '/ocr' || p.startsWith('/sample/')) {
        if (!samplingAuthed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
        return await handleSampling(request, env, url);
      }

      if (request.method !== 'POST') return new Response('Only GET/POST', { status: 405, headers: CORS });

      // ---- 生产统计 / 门户 API：POST / ----
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid body' }, 400); }

      // 登录：验证密码并种 Cookie
      if (body.action === 'auth') {
        if (env.ACCESS_CODE && body.code === env.ACCESS_CODE) {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { ...CORS, 'Content-Type': 'application/json', 'Set-Cookie': `app_auth=${encodeURIComponent(env.ACCESS_CODE)}; Path=/; Max-Age=31536000; SameSite=Lax` }
          });
        }
        if (!env.ACCESS_CODE) return json({ ok: true });
        return json({ error: '访问密码错误' }, 401);
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
  }
};
