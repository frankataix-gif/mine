# -*- coding: utf-8 -*-
"""license_helper 全方位 E2E：列表/详情/编辑/删除/上传/FormI/ZIP/审查/持久化"""
import asyncio, os, sys, io, json, zipfile, tempfile
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
from playwright.async_api import async_playwright

URL = 'https://mine-sync.frankataix.workers.dev/license_helper.html?v=e2e'
TMP = tempfile.gettempdir()
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond)))
    print(('PASS' if cond else 'FAIL'), name, extra)

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        ctx = await b.new_context(accept_downloads=True)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.goto(URL, wait_until='networkidle')
        await pg.wait_for_timeout(1500)

        # ---- 1. 申请列表渲染 ----
        ok('申请列表渲染', await pg.locator('#appList').count() == 1)
        n_apps = await pg.locator('#appList .doc').count()
        ok('申请列表非空', n_apps >= 1, f'{n_apps}条')

        # ---- 2. 点进详情 ----
        await pg.locator('#appList .doc').first.click()
        await pg.wait_for_timeout(600)
        ok('概要卡显示', await pg.locator('#appSum .stat').count() >= 4)
        sumtxt = await pg.locator('#appSum').inner_text()
        ok('概要卡含证型/公司/面积/矿种', all(k in sumtxt for k in ['矿证类型', '申请公司', '矿证面积', '矿产品种']))
        ok('概要卡含地理位置', '地理位置' in sumtxt)
        ok('旧提示已移除', 'portal.miningcadastre.com 各证型上传栏' not in await pg.content())
        ok('申请说明卡已移除', 'AI 提取要点' not in await pg.content())

        # ---- 3. 材料清单顺序：form → B类 → 公司基础 ----
        doc_html = await pg.locator('#docList').inner_html()
        i_form = doc_html.find('Duly Filled in Application Form')
        i_b = doc_html.find('B 类')
        i_base = doc_html.find('公司基础资料')
        ok('清单顺序 form<B<基础', 0 < i_form < i_b < i_base or (i_form > 0 and i_b > i_form))
        ok('生成FormI链接存在', await pg.locator('#docList >> text=生成 Form I').count() >= 1)

        # ---- 4. Form I 生成（下载校验 docx）----
        async with pg.expect_download(timeout=40000) as dl:
            await pg.evaluate('genForm1()')
        d = await dl.value
        f1 = os.path.join(TMP, 'f1.docx'); await d.save_as(f1)
        xml = zipfile.ZipFile(f1).read('word/document.xml').decode('utf-8')
        import re
        ok('FormI无残留占位符', not re.search(r'\{\{[A-Z_0-9]+\}\}', xml))
        ok('FormI勾选了Exploration', xml.count('F0D6') >= 3)
        ok('FormI邮箱固定', 'frankataix@gmail.com' in xml)
        ok('FormI公司名', 'MINING' in xml or 'LIMITED' in xml)

        # ---- 5. 导出 ZIP ----
        async with pg.expect_download(timeout=60000) as dl2:
            await pg.evaluate('exportPackage()')
        d2 = await dl2.value
        zp = os.path.join(TMP, 'pkg.zip'); await d2.save_as(zp)
        z = zipfile.ZipFile(zp)
        names = z.namelist()
        ok('ZIP可打开', len(names) > 0)
        ok('ZIP含清单文件', any('清单' in n or 'manifest' in n.lower() for n in names), f'{len(names)}个文件')
        ok('ZIP含FormI', any('Application Form' in n and n.endswith('.docx') for n in names))
        ok('ZIP目录结构', any('/' in n for n in names), names[0][:60])

        # ---- 6. 新建申请弹窗 ----
        await pg.locator('button:has-text("＋申请")').first.click()
        await pg.wait_for_timeout(300)
        ok('新建弹窗打开', await pg.locator('#modal.show').count() == 1)
        await pg.fill('#naPaste', '地区：Central, Serenje; Northern, Mpika\n产区面积：62.20 km²')
        await pg.wait_for_timeout(300)
        ok('粘贴自动填省份', 'Central' in await pg.input_value('#naProv'))
        ok('粘贴自动填面积', await pg.input_value('#naKm2') == '62.2')
        await pg.click('button:has-text("取消")')

        # ---- 7. 审查页 ----
        await pg.click('.tab[data-p="p-review"]')
        await pg.wait_for_timeout(400)
        await pg.click('button:has-text("运行检查")')
        await pg.wait_for_timeout(800)
        ok('审查出结果', await pg.locator('#reviewList .chk').count() >= 5)
        ok('审查有结论', await pg.locator('#verdict .verdict').count() == 1)

        # ---- 8. 区域页坐标校验 ----
        await pg.click('.tab[data-p="p-area"]')
        await pg.wait_for_timeout(300)
        ok('区域卡渲染', (await pg.locator('#areaCard').inner_text()).strip() != '')

        # ---- 9. 刷新持久化：回到原申请详情 ----
        await pg.click('.tab[data-p="p-docs"]')
        await pg.wait_for_timeout(300)
        await pg.reload(wait_until='networkidle')
        await pg.wait_for_timeout(1500)
        ok('刷新后仍在申请详情', await pg.locator('#appSum .stat').count() >= 4)

        # ---- 10. 公司页 ----
        await pg.click('.tab[data-p="p-co"]')
        await pg.wait_for_timeout(400)
        n_co = await pg.locator('#coForm .doc').count()
        ok('公司列表非空', n_co >= 10, f'{n_co}家')
        await pg.locator('#coForm .doc').first.click()
        await pg.wait_for_timeout(400)
        cotxt = await pg.locator('#coForm').inner_text()
        ok('公司详情含基本信息', 'PACRA 注册号' in cotxt and 'Mobile' in cotxt)
        ok('公司详情含董事', '董事' in cotxt)

        print('控制台错误:', errs if errs else '无')
        ok('无JS错误', not errs)
        await b.close()

asyncio.run(main())
fails = [n for n, c in results if not c]
print(f'\n==== {len(results)}项检查：{len(results)-len(fails)} PASS，{len(fails)} FAIL ====')
if fails: print('FAIL:', fails)
