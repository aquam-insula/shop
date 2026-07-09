const SHOP_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxpg0ptxrXsGXO6vmir-RxK5mHQ_I5XdFPxNeIp9uDgPumGxz9c9ATs_r51Mr4R4UpONA/exec';
const BLA_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxQxHW4iCUh7im8_Q6jXbx5aLAxglySAgXkE7tIDyI6Wx0iHP2OhIOdKhB29vHZoO8/exec';

const ALLOWED_ORIGINS = new Set([
  'https://aquam-insula.github.io',
]);

const ACTION_TARGETS = {
  searchShopProductsAi: SHOP_SCRIPT_URL,
  refineBlaCatalogueSearchAi: BLA_SCRIPT_URL,
  searchBlaCatalogueAi: BLA_SCRIPT_URL,
};

const LIMIT = 10;
const WINDOW_SECONDS = 60;
const BLOCK_SECONDS = [5 * 60, 15 * 60, 30 * 60, 60 * 60];
const UPSTREAM_TIMEOUT_MS = 25000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = buildCorsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || '';
    const targetBase = ACTION_TARGETS[action];
    if (!targetBase) {
      return jsonResponse({ error: 'Unknown or unprotected action' }, 400, corsHeaders);
    }

    const ip = clientIp(request);
    const rate = await checkRateLimit(env, ip, action);
    if (!rate.allowed) {
      await logBlockedRequest(env, ip, action, rate.retryAfter);
      return jsonResponse({
        error: 'Too many requests. Please try again later.',
        retryAfterSeconds: rate.retryAfter,
      }, 429, {
        ...corsHeaders,
        'Retry-After': String(rate.retryAfter),
      });
    }

    const body = await request.text();
    if (body.length > 250000) {
      return jsonResponse({ error: 'Search request is too large.' }, 413, corsHeaders);
    }

    const targetUrl = `${targetBase}?action=${encodeURIComponent(action)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': request.headers.get('Content-Type') || 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (error && error.name === 'AbortError') {
        return jsonResponse({ error: 'Search upstream timed out. Please try again shortly.' }, 504, corsHeaders);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const responseHeaders = new Headers(upstream.headers);
    Object.entries(corsHeaders).forEach(([key, value]) => responseHeaders.set(key, value));
    responseHeaders.set('Cache-Control', 'no-store');

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  },
};

function buildCorsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://aquam-insula.github.io';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown';
}

async function checkRateLimit(env, ip, action) {
  const now = Math.floor(Date.now() / 1000);
  const identity = `${ip}:${action}`;
  const stateKey = `rate:${identity}`;
  const blockKey = `block:${identity}`;

  const blocked = await env.RATE_LIMIT.get(blockKey, 'json');
  if (blocked && Number(blocked.until || 0) > now) {
    return { allowed: false, retryAfter: Number(blocked.until) - now };
  }

  const state = await env.RATE_LIMIT.get(stateKey, 'json') || {
    windowStart: now,
    count: 0,
    strikes: 0,
  };

  if (now - Number(state.windowStart || 0) >= WINDOW_SECONDS) {
    state.windowStart = now;
    state.count = 0;
  }

  state.count = Number(state.count || 0) + 1;

  if (state.count > LIMIT) {
    state.strikes = Number(state.strikes || 0) + 1;
    const blockSeconds = BLOCK_SECONDS[Math.min(state.strikes - 1, BLOCK_SECONDS.length - 1)];
    const until = now + blockSeconds;

    await env.RATE_LIMIT.put(stateKey, JSON.stringify(state), { expirationTtl: 24 * 60 * 60 });
    await env.RATE_LIMIT.put(blockKey, JSON.stringify({ until, strikes: state.strikes }), { expirationTtl: blockSeconds });

    return { allowed: false, retryAfter: blockSeconds };
  }

  await env.RATE_LIMIT.put(stateKey, JSON.stringify(state), { expirationTtl: 24 * 60 * 60 });
  return { allowed: true, retryAfter: 0 };
}

async function logBlockedRequest(env, ip, action, retryAfter) {
  const now = new Date().toISOString();
  const key = `blocked:${now}:${ip}:${action}`;
  await env.RATE_LIMIT.put(key, JSON.stringify({ ip, action, retryAfter, time: now }), { expirationTtl: 7 * 24 * 60 * 60 });
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
