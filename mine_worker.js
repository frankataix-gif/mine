// ============================================
// 钽铌矿生产统计 Cloudflare Worker
// 功能：托管应用页面 + 数据读写代理（写入 GitHub 私有仓库 data/ 目录）
//
// 部署步骤：
// 1. GitHub 建私有仓库：tantalum-mine（上传 mine_production.html 和 mine_sw.js）
// 2. Cloudflare → Workers & Pages → Create Worker → 粘贴本文件 → Deploy
// 3. Worker → Settings → Variables and Secrets 添加：
//    - GITHUB_TOKEN  = 与 cathy worker 同一个 GitHub PAT
//      （注意：若是 fine-grained token 且只授权了 cathy-fencing，
//        需在 GitHub 编辑该 token，把 tantalum-mine 加进授权仓库）
//    - GITHUB_REPO   = frankataix-gif/tantalum-mine
//    - ACCESS_CODE   = 自定义访问密码（如 TK2026zambia），不设置则任何人可写
// 4. 把 Worker URL 填进 mine_production.html 设置页 + 访问密码
// ============================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const APP_PATH = 'mine_production.html';
const SW_PATH = 'mine_sw.js';
const DATA_PREFIX = 'data/';           // 只允许读写 data/ 目录
const DATA_FILE = 'data/production_log.json';

const LOGIN_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 钽铌矿生产统计</title>
<style>body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.c{background:#fff;border-radius:12px;padding:28px;width:min(90%,340px);box-shadow:0 2px 8px rgba(0,0,0,.08)}
h1{font-size:17px;margin:0 0 18px;color:#1e293b}input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #e2e8f0;border-radius:8px;font-size:16px}
button{width:100%;margin-top:12px;padding:11px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:16px;min-height:44px}
.e{color:#ef4444;font-size:13px;margin-top:10px;min-height:18px}</style></head>
<body><div class="c"><h1>钽铌矿生产统计</h1>
<input type="password" id="pw" placeholder="访问密码" autocomplete="current-password">
<button id="go">进入</button><div class="e" id="err"></div></div>
<script>
document.getElementById('go').onclick = async () => {
  const code = document.getElementById('pw').value.trim();
  if (!code) return;
  const r = await fetch(location.pathname, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'auth',code})});
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

function authed(request, env) {
  if (!env.ACCESS_CODE) return true;
  return getCookie(request, 'mine_auth') === env.ACCESS_CODE;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

async function ghApi(env, path, method = 'GET', body = null) {
  const repo = env.GITHUB_REPO || 'frankataix-gif/tantalum-mine';
  const branch = env.GITHUB_BRANCH || 'main';
  const url = `https://api.github.com/repos/${repo}/contents/${path}` + (method === 'GET' ? `?ref=${branch}` : '');
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'mine-worker',
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
  // GitHub API base64 解码（含 UTF-8）
  const bin = atob(data.content.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return { sha: data.sha, content: new TextDecoder().decode(bytes) };
}

async function writeFile(env, path, content, message, sha) {
  const bytes = new TextEncoder().encode(content);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const body = { message: message || 'Mine data update', content: btoa(bin), branch: env.GITHUB_BRANCH || 'main' };
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

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

      const url = new URL(request.url);

      // ---- 静态文件：托管应用页面（需登录） ----
      if (request.method === 'GET') {
        if (url.pathname === '/' || url.pathname === '/' + APP_PATH) {
          if (!authed(request, env)) {
            return new Response(LOGIN_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
          }
          return serveRepoFile(env, APP_PATH, 'text/html');
        }
        if (url.pathname === '/' + SW_PATH) {
          if (!authed(request, env)) return new Response('unauthorized', { status: 401, headers: CORS });
          return serveRepoFile(env, SW_PATH, 'application/javascript');
        }
        if (url.pathname === '/manifest.webmanifest') {
          return serveRepoFile(env, 'manifest.webmanifest', 'application/manifest+json');
        }
        if (url.pathname === '/icon-192.png' || url.pathname === '/icon-512.png') {
          return serveRepoBinary(env, url.pathname.slice(1), 'image/png');
        }
        if (url.pathname.startsWith('/photos/')) {
          return serveRepoBinary(env, url.pathname.slice(1), 'image/jpeg');
        }
        return new Response('OK', { headers: CORS });
      }

      if (request.method !== 'POST') return new Response('Only GET/POST', { status: 405, headers: CORS });

      // ---- 访问密码校验 ----
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'invalid body' }, 400); }

      // 登录：验证密码并种 Cookie
      if (body.action === 'auth') {
        if (env.ACCESS_CODE && body.code === env.ACCESS_CODE) {
          return new Response(JSON.stringify({ ok: true }), {
            headers: { ...CORS, 'Content-Type': 'application/json', 'Set-Cookie': `mine_auth=${encodeURIComponent(env.ACCESS_CODE)}; Path=/; Max-Age=31536000; SameSite=Lax` }
          });
        }
        return json({ error: '访问密码错误' }, 401);
      }

      // XRF照片识别：AI视觉优先读屏（不预设元素清单，屏上有什么读什么），OCR.space兜底
      if (body.action === 'ocr') {
        const img = body.images && body.images[0];
        if (!img) return json({ error: 'no image' }, 400);
        // 元素符号全集（周期表+Bal），用于规范化大小写；清单外的大写两字母符号也接受
        const ELEMS = new Set('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Ru Rh Pd Ag Cd In Sn Sb Te I Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Th Pa U Bal'.split(' ').map(s => s.toLowerCase()));
        const canon = s => {
          const t = s.toLowerCase();
          if (!ELEMS.has(t) && !/^[a-z][a-z]$/.test(t)) return null;
          return t === 'bal' ? 'Bal' : t[0].toUpperCase() + t.slice(1);
        };
        const parseAiText = atext => {
          const els = {};
          for (const ln of atext.split('\n')) {
            for (const m of ln.matchAll(/\b([A-Za-z]{1,3})\b[^0-9]*([0-9]+(?:\.[0-9]+)?)/g)) {
              const el = canon(m[1]);
              if (el && els[el] == null) els[el] = +m[2];
            }
          }
          return els;
        };
        try {
          // ---- 第一通道：Workers AI 视觉模型直接读图 ----
          if (env.AI) {
            const b64 = img.includes(',') ? img.split(',')[1] : img;
            const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const PROMPT = 'This photo may show an XRF analyzer screen with a table. If it is NOT an analyzer screen (e.g. it is a photo of ore/material/equipment), output only the word NOSCREEN. Otherwise: first column is a chemical element symbol — copy it EXACTLY as shown, whatever element it is. Second column is content in percent; ignore the third +/- column. Read EVERY row top to bottom, do not skip any row — IMPORTANT: the first row may be highlighted with inverted/dark colors (usually Ta), still read it. Output ONLY lines "Symbol value". No other text.';
            const dataUrl = 'data:image/jpeg;base64,' + b64;
            const llamaArgs = { messages: [{ role: 'user', content: [
              { type: 'text', text: PROMPT },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]}] };
            // llama读两遍（高亮行有漏读率，第二次常能补上），llava兜底
            const calls = [
              ['@cf/meta/llama-3.2-11b-vision-instruct', llamaArgs],
              ['@cf/meta/llama-3.2-11b-vision-instruct', llamaArgs],
              ['@cf/llava-hf/llava-1.5-7b-hf', { image: [...bytes], prompt: PROMPT }]
            ];
            let merged = {}, rawAll = '', noscreen = 0;
            for (const [model, args] of calls) {
              let atext = '';
              try {
                const ai = await env.AI.run(model, args);
                atext = (ai && (ai.response || ai.description)) || '';
              } catch (e3) { rawAll += 'ERR ' + model + ': ' + e3.message + '\n'; continue; }
              if (/noscreen/i.test(atext)) { noscreen++; continue; }
              rawAll += atext + '\n';
              const els = parseAiText(atext);
              for (const [k, v] of Object.entries(els)) if (merged[k] == null) merged[k] = v;   // 双模型互补：前一个漏的行后一个补
              if (merged.Ta != null) break;   // Ta（首行高亮）读到了就停
            }
            const vals = Object.values(merged);
            const uniform = vals.length > 3 && new Set(vals).size === 1;
            // 物料照瞎编特征：无Bal行 且 一半以上数值相同（如20个0.01）；真屏Bal必为大数
            const halfSame = vals.length > 6 && (vals.length - new Set(vals).size) > vals.length / 2;
            const badBal = merged.Bal != null && merged.Bal < 20;
            const noBal = merged.Bal == null;
            if (vals.length >= 3 && !uniform && !badBal && !(noBal && halfSame)) {
              return json({ ok: true, elements: merged, raw: rawAll.trim(), via: 'ai' });
            }
            // 模型正常运行且判定非化验屏 → 直接拒；模型报错/空输出 → 落OCR.space兜底
            const aiErr = /ERR /.test(rawAll);
            if (noscreen && vals.length < 3 && !aiErr) {
              return json({ error: 'not an assay screen', elements: null });
            }
          }
          // ---- 第二通道：OCR.space 文字识别 + 行解析 ----
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
          // 屏幕行序：Ta, Nb, Bal, Mo, Zr, Bi, As, Fe, Mn, Ti（第4行是Mo钼，不是Hf）
          const ROWS = ['Ta', 'Nb', 'Bal', 'Mo', 'Zr', 'Bi', 'As', 'Fe', 'Mn', 'Ti'];
          // 修正 OCR 常见错：0_967 → 0.967
          text = text.replace(/(\d)[_](\d)/g, '$1.$2');
          // 数值区在 '+/-' 或 'sec' 标记之后
          const parts = text.split(/\+\/-|\bsec\b/i);
          const tail = parts.length > 1 ? parts.slice(-1)[0] : text;
          // 令牌流：元素标签 / 数值行，逐个走——标签后的第一个数=值，第二个数=误差跳过
          const elements = {};
          let ptr = 0, pending = null, skipNext = false;
          for (const line of tail.split('\n').map(l => l.trim()).filter(Boolean)) {
            const nums = (line.match(/\d+(\.\d+)?/g) || []).map(Number).filter(n => n <= 150);
            const tok = (line.match(/\b([A-Za-z]{2,4})\b/) || [])[1];
            const lab = tok && canon(tok);
            if (lab && !nums.length) {
              pending = lab;
              const ti = ROWS.indexOf(pending);
              if (ti > ptr) ptr = ti;
              skipNext = false;   // 新标签=新行，清掉误差跳过标记
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
          // 校验：真屏必有 Bal 余量且为大数；错位/瞎读的一律拒收，宁缺勿错
          if (Object.keys(elements).length < 3 || !(elements.Bal >= 20)) {
            return json({ error: 'ocr low-confidence (rows misaligned)', elements: null });
          }
          return json({ ok: true, elements, raw: text });
        } catch (e) { return json({ error: 'ocr failed: ' + e.message }, 500); }
      }

      if (env.ACCESS_CODE && body.code !== env.ACCESS_CODE) {
        return json({ error: '访问密码错误' }, 401);
      }

      // ---- 照片上传：存为仓库独立文件，记录里只存 ph:路径 ----
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

      // ---- 数据读写（只允许 data/ 目录）----
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
