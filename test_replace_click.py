# -*- coding: utf-8 -*-
"""实测复现:点击'替换'是否真的没反应"""
import sys, io, asyncio
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        pg = await b.new_page()
        errs = []
        pg.on('console', lambda m: errs.append(m.type + ':' + m.text) if m.type in ('error','warning') else None)
        pg.on('pageerror', lambda e: errs.append('PAGEERROR:' + str(e)))
        await pg.goto('https://mine-sync.frankataix.workers.dev/license_helper.html?v=' + str(id(pg)), wait_until='networkidle')
        # 点进公司页签
        await pg.click('.tab[data-p="p-co"]')
        await pg.wait_for_timeout(600)
        # 点第一家有股东的公司（Fumbo 在"有赞方"组）—— 直接点列表第一行
        rows = pg.locator('#coForm .doc')
        print('公司行数:', await rows.count())
        # 找 FUMBO
        cnt = await rows.count()
        for i in range(cnt):
            t = await rows.nth(i).inner_text()
            if 'FUMBO' in t.upper():
                await rows.nth(i).click(); break
        else:
            await rows.first.click()
        await pg.wait_for_timeout(600)
        # 找 pacra 行的 替换 链接
        rep = pg.locator('label[for="filePick"]:has-text("上传"), label[for="filePick"]:has-text("缺")')
        print('label 上传控件数:', await rep.count())
        # 监听文件选择框是否弹出
        try:
            async with pg.expect_file_chooser(timeout=5000) as fc:
                await rep.first.click()
            ch = await fc.value
            print('✅ 文件选择框弹出! accept:', await ch.element.get_attribute('accept'))
        except Exception as e:
            print('❌ 文件选择框未弹出:', type(e).__name__)
        # 同时测文件名链接(viewFile)
        try:
            await pg.locator('#coDocs a', has_text='.pdf').first.click(timeout=3000)
            await pg.wait_for_timeout(1500)
            vis = await pg.locator('#viewer.show').count()
            print('viewer 打开:', vis > 0)
        except Exception as e:
            print('viewer 测试失败:', e)
        print('控制台错误:', errs[:10] if errs else '无')
        await b.close()

asyncio.run(main())
