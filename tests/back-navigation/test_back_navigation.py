import json, re, sys, time
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765/shop/'
LIVE = 'github.io' in BASE
import os
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''), flush=True)

def setup_routes(ctx):
    def stub_gas(route):
        url = route.request.url
        if 'getVatRate' in url:
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'rate': 0.125}))
        if 'getAiDescription' in url:
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'text': 'Test description.'}))
        if 'searchShopProductsAi' in url or 'action=' in url:
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'productNumbers': []}))
        return route.fulfill(status=200, content_type='application/json', body='{}')
    ctx.route(re.compile(r'https://script\.google(usercontent)?\.com/.*'), stub_gas)
    ctx.route(re.compile(r'https://aqiml-search\..*'), stub_gas)
    ctx.route(re.compile(r'https://fbm\.framesoft\.com/.*'), lambda r: r.fulfill(status=200, content_type='application/json', body='{"quotationNr":"TEST"}'))
    if not LIVE:
        ctx.route(re.compile(r'https://raw\.githubusercontent\.com/aquam-insula/shop/main/data/shop_products\.json.*'),
                  lambda r: r.fulfill(status=200, content_type='application/json', path=f'{REPO}/data/shop_products.json'))
    ctx.route(re.compile(r'.*\.(png|jpe?g|webp|gif)(\?.*)?$'), lambda r: r.abort() if r.request.resource_type == 'image' and 'drive.google' not in r.request.url and 'raw.githubusercontent' not in r.request.url and '127.0.0.1' not in r.request.url and 'github.io' not in r.request.url else r.continue_())
    ctx.route(re.compile(r'https://(drive|lh\d)\.google(usercontent)?\.com/.*'), lambda r: r.abort())

STATE_JS = """() => ({
  route: window.aqiShopNav ? window.aqiShopNav.route() : null,
  entry: window.aqiShopNav ? window.aqiShopNav.entry() : null,
  y: Math.round(window.scrollY),
  search: location.search,
  product: !document.getElementById('productModal').classList.contains('hidden'),
  basket: !document.getElementById('basketDrawer').classList.contains('hidden'),
  quote: !document.getElementById('quoteModal').classList.contains('hidden'),
  title: document.getElementById('resultTitle').textContent,
  detail: document.getElementById('detailCode').textContent,
  input: document.getElementById('searchInput').value,
  len: history.length
})"""

def st(page): return page.evaluate(STATE_JS)

def settle(page, ms=350):
    page.wait_for_timeout(ms)
    page.wait_for_function("() => document.getElementById('loadingPanel').classList.contains('hidden')", timeout=60000)
    page.wait_for_timeout(200)

def wait_search(page, expected):
    page.wait_for_function("(exp) => new URLSearchParams(location.search).toString() === exp", arg=expected, timeout=20000)
    settle(page)

def params(d):
    from urllib.parse import urlencode
    return urlencode(d)

def click_card(page, grid, index=0, largest=False):
    cards = page.locator(f'#{grid} > article')
    cards.first.wait_for(state='visible', timeout=60000)
    n = cards.count()
    if largest:
        counts = cards.evaluate_all("els => els.map(e => parseInt((e.querySelector('p')||{}).textContent||'0',10)||0)")
        index = max(range(n), key=lambda i: counts[i])
    title = cards.nth(index).locator('h3').inner_text()
    cards.nth(index).click()
    settle(page)
    return title

def visible_product_click(page, skip=0):
    # click a product card that is currently in the viewport (simulates a real tap after scrolling)
    idx = page.evaluate("""(skip) => {
      const cards = Array.from(document.querySelectorAll('#productGrid > article'));
      const vis = cards.map((c,i)=>[c,i]).filter(([c]) => { const r=c.getBoundingClientRect(); return r.top>120 && r.bottom < innerHeight; });
      return vis.length ? vis[Math.min(skip, vis.length-1)][1] : 0;
    }""", skip)
    card = page.locator('#productGrid > article').nth(idx)
    code = card.locator('.product-code').inner_text()
    card.locator('h3').click()
    page.wait_for_function("() => !document.getElementById('productModal').classList.contains('hidden')")
    page.wait_for_timeout(250)
    return code

def run(viewport, label, mobile):
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport=viewport, is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
        setup_routes(ctx)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto('about:blank')
        page.goto(BASE)
        page.wait_for_function("() => document.querySelectorAll('#categoryGrid > article').length > 3", timeout=90000)
        settle(page, 800)
        s0 = st(page)
        check(f'{label}: home loads with clean URL and history entry', s0['route'] == {} and s0['entry'] and s0['search'] == '', s0)

        # ---- Flow 1: Home -> Category -> Subcategory -> Product A -> Product B -> Basket and back
        cat = click_card(page, 'categoryGrid', index=1)
        s = st(page)
        check(f'{label}: category pushes ?category', s['route'].get('category') == cat and 'category=' in s['search'], s)
        page.mouse.wheel(0, 300); page.wait_for_timeout(500)
        cat_y = st(page)['y']
        sub = click_card(page, 'categoryGrid', largest=True)
        s = st(page)
        check(f'{label}: subcategory pushes ?sub and opens at top', s['route'].get('sub') == sub and s['y'] < 5, s)
        # scroll down the product list
        for _ in range(6): page.mouse.wheel(0, 400); page.wait_for_timeout(120)
        page.wait_for_timeout(600)
        sub_y = st(page)['y']
        check(f'{label}: product list scrolled', sub_y > 800, sub_y)
        code_a = visible_product_click(page, 0)
        s = st(page)
        check(f'{label}: product A opens with ?product', s['product'] and s['route'].get('product','').endswith(code_a), s)
        page.locator('#productModal [data-close-modal]').click(); page.wait_for_timeout(300)
        s = st(page)
        check(f'{label}: closing A keeps list scroll', (not s['product']) and abs(s['y'] - sub_y) < 5, s)
        code_b = visible_product_click(page, 2)
        if code_b == code_a:
            page.locator('#productModal [data-close-modal]').click(); page.wait_for_timeout(200)
            code_b = visible_product_click(page, 3)
        s = st(page)
        check(f'{label}: product B opens', s['product'] and s['detail'] == code_b and code_b != code_a, (code_a, code_b, s))
        page.locator('#productModal [data-close-modal]').click(); page.wait_for_timeout(300)
        page.locator('#basketButton').click(); page.wait_for_timeout(300)
        s = st(page)
        check(f'{label}: basket opens with ?open=basket', s['basket'] and s['route'].get('open') == 'basket', s)

        page.go_back(); page.wait_for_timeout(600)
        s = st(page)
        check(f'{label}: Back closes basket', not s['basket'] and not s['product'] and s['route'].get('sub') == sub, s)
        page.go_back(); page.wait_for_timeout(600)
        s = st(page)
        check(f'{label}: Back -> Product B', s['product'] and s['detail'] == code_b, s)
        page.go_back(); page.wait_for_timeout(600)
        s = st(page)
        check(f'{label}: Back -> Product A (previous product)', s['product'] and s['detail'] == code_a, s)
        page.go_back(); settle(page, 600)
        s = st(page)
        check(f'{label}: Back -> subcategory list, scroll restored', (not s['product']) and s['route'].get('sub') == sub and abs(s['y'] - sub_y) < 5 and s['title'] == sub, (sub_y, s))
        page.go_back(); settle(page, 600)
        s = st(page)
        check(f'{label}: Back -> category, scroll restored', s['route'] == {'category': cat} and abs(s['y'] - cat_y) < 5 and s['title'] == cat, (cat_y, s))
        page.go_back(); settle(page, 600)
        s = st(page)
        check(f'{label}: Back -> Home', s['route'] == {} and s['title'] == 'Categories' and s['search'] == '', s)
        # Forward
        page.go_forward(); settle(page, 600)
        s = st(page)
        check(f'{label}: Forward -> category', s['route'] == {'category': cat}, s)
        page.go_forward(); settle(page, 600)
        s = st(page)
        check(f'{label}: Forward -> subcategory with scroll', s['route'].get('sub') == sub and abs(s['y'] - sub_y) < 5, (sub_y, s))
        page.go_forward(); page.wait_for_timeout(600)
        s = st(page)
        check(f'{label}: Forward -> Product A', s['product'] and s['detail'] == code_a, s)

        # ---- Deep link reload: product stays open, Back still works
        page.reload(); page.wait_for_function("() => !document.getElementById('productModal').classList.contains('hidden')", timeout=90000); settle(page, 800)
        s = st(page)
        check(f'{label}: reload keeps deep-linked Product A open', s['product'] and s['detail'] == code_a and s['route'].get('sub') == sub, s)
        page.go_back(); settle(page, 800)
        s = st(page)
        check(f'{label}: Back after reload -> subcategory list', (not s['product']) and s['route'].get('sub') == sub and abs(s['y'] - sub_y) < 30, (sub_y, s))
        page.go_back(); settle(page, 600)
        page.go_back(); settle(page, 600)
        s = st(page)
        check(f'{label}: Back after reload -> Home', s['route'] == {}, s)

        # ---- Flow 2: Search -> Product -> Back keeps search
        page.locator('#searchInput').click()
        page.keyboard.type('an', delay=60); page.wait_for_timeout(900)
        page.keyboard.type('chor', delay=60)
        wait_search(page, 'q=anchor')
        s = st(page)
        check(f'{label}: search shows ?q=anchor', s['route'] == {'q': 'anchor'} and s['title'].startswith('Search results'), s)
        len_after_search = s['len']
        for _ in range(3): page.mouse.wheel(0, 400); page.wait_for_timeout(120)
        page.wait_for_timeout(600)
        search_y = st(page)['y']
        code_s = visible_product_click(page, 0)
        page.go_back(); page.wait_for_timeout(700)
        s = st(page)
        check(f'{label}: Back from product -> search results preserved', (not s['product']) and s['route'] == {'q': 'anchor'} and s['input'] == 'anchor' and abs(s['y'] - search_y) < 5, (search_y, s))
        page.go_back(); settle(page, 600)
        s = st(page)
        check(f'{label}: typing refinements form one Back step (an -> anchor)', s['route'] == {}, s)
        page.go_forward(); settle(page, 700)
        s = st(page)
        check(f'{label}: Forward restores search (from cache)', s['route'] == {'q': 'anchor'} and s['input'] == 'anchor' and s['title'].startswith('Search results'), s)

        # ---- Flow 3: Basket -> Quote preview -> Back
        page.locator('#productGrid > article .primary-button').first.click(); page.wait_for_timeout(200)
        page.locator('#basketButton').click(); page.wait_for_timeout(200)
        page.locator('#reviewQuote').click(); page.wait_for_timeout(300)
        s = st(page)
        check(f'{label}: quote preview ?open=quote', s['quote'] and not s['basket'] and s['route'].get('open') == 'quote', s)
        page.go_back(); page.wait_for_timeout(500)
        s = st(page)
        check(f'{label}: Back closes quote preview -> search', (not s['quote']) and (not s['basket']) and s['route'] == {'q': 'anchor'}, s)
        page.locator('#basketButton').click(); page.wait_for_timeout(200)
        page.locator('#closeBasket').click(); page.wait_for_timeout(500)
        s = st(page)
        check(f'{label}: basket X closes without adding a Back step', (not s['basket']) and s['route'] == {'q': 'anchor'} and s['len'] <= len_after_search + 3, s)
        page.locator('#basketButton').click(); page.wait_for_timeout(200)
        page.keyboard.press('Escape'); page.wait_for_timeout(500)
        s = st(page)
        check(f'{label}: Escape closes basket', not s['basket'] and s['route'] == {'q': 'anchor'}, s)

        # ---- Flow 4: Tools + in-app Back to Categories button
        page.goto(BASE + '?category=Tools'); page.wait_for_function("() => document.querySelectorAll('#productGrid > article').length > 0", timeout=90000); settle(page)
        s = st(page)
        check(f'{label}: deep link ?category=Tools', s['route'] == {'category': 'Tools'} and s['title'] == 'Tools', s)
        page.locator('#backToCategories').click(); settle(page)
        s = st(page)
        check(f'{label}: in-app Back to Categories -> Home', s['route'] == {} and s['title'] == 'Categories', s)
        page.go_back(); settle(page, 600)
        s = st(page)
        check(f'{label}: browser Back -> Tools again', s['route'] == {'category': 'Tools'}, s)

        # ---- Flow 5: deep link to a product inside a subcategory + Forward
        page.goto(BASE + '?' + params({'category': cat, 'sub': sub, 'product': 'stock:' + code_a.split(' ')[0]}) )
        page.wait_for_timeout(2500); settle(page)
        s = st(page)
        check(f'{label}: deep link category/sub loads list', s['route'].get('sub') == sub and s['title'] == sub, s)

        # ---- Flow 6: Lifestyle start keeps section param
        page.goto(BASE + '?section=lifestyle')
        page.wait_for_function("() => document.querySelectorAll('#categoryGrid > article').length > 1", timeout=90000); settle(page, 600)
        lcat = click_card(page, 'categoryGrid', index=0)
        s = st(page)
        check(f'{label}: lifestyle category keeps section=lifestyle', s['route'] == {'category': lcat} and 'section=lifestyle' in s['search'], s)
        code_l = visible_product_click(page, 0)
        page.go_back(); page.wait_for_timeout(500)
        page.go_back(); settle(page, 600)
        s = st(page)
        check(f'{label}: lifestyle Back -> lifestyle home', s['route'] == {} and s['search'] == '?section=lifestyle' and 'Lifestyle' in s['title'], s)
        page.reload(); page.wait_for_function("() => document.querySelectorAll('#categoryGrid > article').length > 1", timeout=90000); settle(page)
        page.go_forward(); settle(page, 600)
        s = st(page)
        check(f'{label}: lifestyle Forward after reload -> category', s['route'] == {'category': lcat}, s)

        # ---- leaves the shop only when shop history is exhausted
        page.goto('about:blank'); page.goto(BASE)
        page.wait_for_function("() => document.querySelectorAll('#categoryGrid > article').length > 3", timeout=90000); settle(page)
        click_card(page, 'categoryGrid', index=2)
        page.go_back(); settle(page)
        s = st(page)
        check(f'{label}: Back from first category stays in shop (home)', s['route'] == {} and 'shop' in page.url, page.url)

        check(f'{label}: no page errors', not errors, errors[:3])
        browser.close()

run({'width': 390, 'height': 844}, 'mobile', True)
run({'width': 1280, 'height': 800}, 'desktop', False)
failed = [r for r in results if not r[1]]
print(f'\n{len(results)-len(failed)}/{len(results)} passed')
sys.exit(1 if failed else 0)
