# -*- coding: utf-8 -*-
"""端到端：label点击弹框 + docDrop拖拽上传 两条通路都验证"""
import sys, io, asyncio, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
from playwright.async_api import async_playwright

tmp = os.path.join(os.environ['TEMP'], 'e2e_drop.pdf')
with open(tmp, 'wb') as f:
    f.write(b'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        pg = await b.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERROR:' + str(e)))
        pg.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' else None)
        pg.on('dialog', lambda d: asyncio.ensure_future(d.accept()))  # confirm() 一律确认
        await pg.goto('https://mine-sync.frankataix.workers.dev/license_helper.html?v=t', wait_until='networkidle')
        await pg.click('.tab[data-p="p-co"]')
        await pg.wait_for_timeout(500)
        rows = pg.locator('#coForm .doc')
        for i in range(await rows.count()):
            if 'FUMBO' in (await rows.nth(i).inner_text()).upper():
                await rows.nth(i).click(); break
        await pg.wait_for_timeout(500)

        # 1) label 通路：点 上传/缺 → 应弹文件框
        ups = pg.locator('label[for="filePick"]')
        n = await ups.count()
        print('上传控件数:', n)
        if n:
            async with pg.expect_file_chooser(timeout=8000) as fc:
                await ups.first.click()
            await (await fc.value).set_files(tmp)
            await pg.wait_for_timeout(5000)
            print('label 上传后 toast:', await pg.locator('#toast').inner_text() if await pg.locator('#toast').is_visible() else '(隐藏/已消失)')
            # 该槽位已收 → 删掉恢复原状
            await pg.evaluate("delCoDoc('pacra')")
            await pg.wait_for_timeout(1500)

        # 2) 拖拽通路：合成 DataTransfer 直接调 docDrop
        await pg.evaluate("""(async ()=>{
            const buf = await fetch('file:///dev/null').catch(()=>null); // 占位
        })()""")
        # 用页面内构造 File 测 docDrop
        r = await pg.evaluate("""(async ()=>{
            const f = new File([new Uint8Array([37,80,68,70])], 'e2e_drop.pdf', {type:'application/pdf'});
            const dt = new DataTransfer(); dt.items.add(f);
            docDrop({preventDefault(){},stopPropagation(){},dataTransfer:dt}, 'pacra', 'co');
            return 'called';
        })()""")
        print('docDrop 调用:', r)
        await pg.wait_for_timeout(6000)
        toast = await pg.locator('#toast').inner_text() if await pg.locator('#toast').is_visible() else '(隐藏)'
        print('拖拽上传后 toast:', toast)
        chips = await pg.locator('#coDocs .chip').all_inner_texts()
        print('槽位状态:', chips)
        # 清理
        await pg.evaluate("delCoDoc('pacra')")
        await pg.wait_for_timeout(1500)
        print('JS错误:', errs if errs else '无')
        await b.close()

asyncio.run(main())
