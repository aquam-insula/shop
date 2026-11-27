import sys, re, json
sys.argv = sys.argv[:2]
exec(open('' + __import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)), 'test_back_navigation.py') + '').read().split("def run(")[0])
def run2(viewport, label, mobile):
    with sync_playwright() as p:
        b = p.chromium.launch(); ctx = b.new_context(viewport=viewport, is_mobile=mobile, has_touch=mobile)
        setup_routes(ctx); page = ctx.new_page(); errors = []
        posted = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('request', lambda r: posted.append(r.url) if 'shop-quotation' in r.url else None)
        page.goto(BASE); page.wait_for_function("() => document.querySelectorAll('#categoryGrid > article').length > 3", timeout=90000); settle(page, 800)
        # sidebar navigation (desktop has visible sidebar)
        tree = page.locator('#categoryTree button.bla-category-node')
        if tree.count() and tree.first.is_visible():
            name = tree.nth(0).inner_text().rsplit(' (', 1)[0]
            tree.nth(0).click(); settle(page)
            subbtn = page.locator('#categoryTree button.subcategory-node').first
            subname = subbtn.inner_text().rsplit(' (', 1)[0]
            subbtn.click(); settle(page)
            s = st(page)
            check(f'{label}: sidebar subcategory recorded', s['route'] == {'category': name, 'sub': subname}, s)
            page.locator('#backToCategories').click(); settle(page)
            s = st(page)
            check(f'{label}: in-app "Back to {name}" -> category', s['route'] == {'category': name}, s)
            page.go_back(); settle(page, 600)
            s = st(page)
            check(f'{label}: browser Back -> sidebar subcategory', s['route'] == {'category': name, 'sub': subname}, s)
        # direct product -> Back
        page.goto(BASE); page.wait_for_function("() => document.querySelectorAll('#categoryGrid > article').length > 3", timeout=90000); settle(page, 500)
        click_card(page, 'categoryGrid', index=0)
        if st(page)['route'].get('category') == 'Tools' or page.locator('#productGrid > article').count():
            pass
        else:
            click_card(page, 'categoryGrid', index=0)
        before = st(page)
        code = visible_product_click(page, 0)
        page.go_back(); page.wait_for_timeout(500)
        s = st(page)
        check(f'{label}: product -> Back closes it and stays on list', (not s['product']) and s['route'] == before['route'], (before['route'], s))
        # quote submit still works
        page.locator('#productGrid > article .primary-button').first.click(); page.wait_for_timeout(200)
        page.locator('#basketButton').click(); page.locator('#reviewQuote').click(); page.wait_for_timeout(200)
        page.fill('#quoteName', 'Nav Test'); page.fill('#quoteEmail', 'nav.test@example.com')
        page.locator('#validateQuote').click(); page.wait_for_timeout(800)
        status = page.locator('#quoteStatus').inner_text()
        check(f'{label}: quote submit unchanged (stubbed endpoint)', 'TEST' in status and posted, status)
        page.locator('#quoteModal [data-close-modal]').click(); page.wait_for_timeout(500)
        s = st(page)
        check(f'{label}: closing quote returns to list', (not s['quote']) and s['route'] == before['route'], s)
        check(f'{label}: no page errors', not errors, errors[:3])
        b.close()
run2({'width': 390, 'height': 844}, 'mobile', True)
run2({'width': 1280, 'height': 800}, 'desktop', False)
failed = [r for r in results if not r[1]]
print(f'\n{len(results)-len(failed)}/{len(results)} passed'); sys.exit(1 if failed else 0)
