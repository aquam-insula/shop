# Shop Back/Forward navigation tests

Playwright (Python) checks for the in-shop browser history: every category, subcategory,
search, product, basket and quote-preview step is a browser Back step, scroll positions are
restored, deep links and reloads work, and Forward replays the steps.

```bash
pip install playwright && python -m playwright install chromium
# serve the repository so the shop is reachable at /shop/
mkdir -p /tmp/www && ln -sfn "$PWD" /tmp/www/shop && (cd /tmp/www && python -m http.server 8765 --bind 127.0.0.1 &)
python tests/back-navigation/test_back_navigation.py http://127.0.0.1:8765/shop/
python tests/back-navigation/test_back_navigation_extra.py http://127.0.0.1:8765/shop/
```

The tests run on a phone viewport (390x844) and a desktop viewport (1280x800). Quote, AI and
search endpoints are stubbed, so running them never sends a real quote request.
