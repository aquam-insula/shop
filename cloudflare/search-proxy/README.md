# AQUAM INSULA Search Protection Worker

This Cloudflare Worker protects the expensive Apps Script search endpoints.

Live Worker URL:

```text
https://aqiml-search.t-98d.workers.dev
```

It:
- reads the visitor IP from Cloudflare's `CF-Connecting-IP` header
- allows up to 10 protected requests per IP per minute
- blocks repeat offenders with escalating lockouts: 5, 15, 30, then 60 minutes
- logs blocked IPs and recent request counters in KV
- forwards only allowlisted Apps Script actions

## Setup

1. Install Wrangler:

```powershell
npm install -g wrangler
```

2. Log in:

```powershell
wrangler login
```

3. Create the KV namespace:

```powershell
wrangler kv namespace create RATE_LIMIT
```

4. Copy the returned `id` into `wrangler.toml`.

5. Deploy:

```powershell
wrangler deploy
```

6. Update the shop front end to send protected search calls to the deployed Worker URL.

For full website request protection, put a custom domain such as `shop.aquam-insula.com` behind Cloudflare and route it through a Worker or Cloudflare WAF rule. The current `aquam-insula.github.io` URL cannot be IP-rate-limited by our own front-end JavaScript.
