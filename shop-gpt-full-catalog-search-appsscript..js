/**
 * GPT full-catalog search for the public AQUAM INSULA shop catalogue.
 *
 * This is intentionally provided as a standalone Apps Script module and is not
 * deployed by Codex. It expects the existing shop script helpers:
 * - getProductsFromSheet()
 * - safeParseJSON(str, fallback)
 *
 * Required Script Property:
 * - OPENAI_API_KEY
 *
 * Optional Script Property:
 * - SHOP_SEARCH_MODEL, defaults to gpt-4o-mini-2024-07-18
 *
 * Suggested doPost switch case:
 *
 *   case 'searchShopProductsAi': {
 *     data = searchShopProductsAi(e);
 *     break;
 *   }
 */

function searchShopProductsAi(e) {
  var query = String(e && e.parameter && e.parameter.query || '').trim();
  var superCategory = String(e && e.parameter && e.parameter.superCategory || '').trim();
  var subCategory = String(e && e.parameter && e.parameter.subCategory || '').trim();

  if (query.length < 2) {
    return {
      query: query,
      codes: [],
      summary: 'Please enter a more specific search phrase.',
      source: 'too_short'
    };
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = makeShopSearchCacheKey_(query, superCategory, subCategory);
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var products = getProductsFromSheet();
  var compactProducts = products
    .map(compactShopProductForSearch_)
    .filter(function(product) {
      return product.code || product.name;
    });

  var exact = findExactShopProductCodeMatches_(compactProducts, query);
  if (exact.length) {
    var exactResult = {
      query: query,
      codes: exact.map(function(product) { return product.code; }),
      summary: 'Exact product-number match.',
      source: 'exact'
    };
    cache.put(cacheKey, JSON.stringify(exactResult), 1800);
    return exactResult;
  }

  var props = PropertiesService.getScriptProperties().getProperties();
  var apiKey = props.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured for shop search.');
  }

  var catalogueText = buildShopCataloguePromptText_(compactProducts);
  var payload = {
    model: props.SHOP_SEARCH_MODEL || 'gpt-4o-mini-2024-07-18',
    messages: [
      {
        role: 'system',
        content: [
          'You are the product search engine for Aquam Insula Maritime Lifestyle in Fiji.',
          'Rank public shop products by buyer intent, synonyms, marine use case, material, category, compatibility, and likely customer need.',
          'Prefer exact product-code matches first.',
          'Return only strict JSON.'
        ].join(' ')
      },
      {
        role: 'user',
        content: 'Public shop catalogue:\n' + catalogueText
      },
      {
        role: 'user',
        content: JSON.stringify({
          query: query,
          currentSuperCategory: superCategory,
          currentSubCategory: subCategory,
          instruction: [
            'Return up to 80 clearly relevant product codes, best first.',
            'Use synonyms and buyer intent, not only literal text matching.',
            'Avoid weak or unrelated matches.',
            'If the current category/subcategory is provided, prefer products in that scope unless another product is clearly a better match.',
            'JSON format: {"codes":["..."],"summary":"short reason"}.'
          ].join(' ')
        })
      }
    ],
    max_tokens: 700,
    temperature: 0.08,
    response_format: { type: 'json_object' }
  };

  var response = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: { Authorization: 'Bearer ' + apiKey },
    muteHttpExceptions: true
  });

  var status = response.getResponseCode();
  var text = response.getContentText() || '{}';
  if (status < 200 || status >= 300) {
    throw new Error('OpenAI shop search failed (' + status + '): ' + text.slice(0, 500));
  }

  var json = JSON.parse(text);
  var content = json &&
    json.choices &&
    json.choices[0] &&
    json.choices[0].message &&
    json.choices[0].message.content;
  var parsed = JSON.parse(content || '{}');

  var codeSet = {};
  compactProducts.forEach(function(product) {
    codeSet[product.code] = true;
  });

  var ranked = (parsed.codes || [])
    .map(function(code) { return String(code || '').trim(); })
    .filter(function(code, index, arr) {
      return code && codeSet[code] && arr.indexOf(code) === index;
    })
    .slice(0, 80);

  var result = {
    query: query,
    codes: ranked,
    summary: String(parsed.summary || (
      ranked.length
        ? 'Ranked by GPT from the public shop catalogue.'
        : 'No clearly relevant products found.'
    )).slice(0, 220),
    source: 'gpt_full_catalog'
  };

  cache.put(cacheKey, JSON.stringify(result), 1800);
  return result;
}

function compactShopProductForSearch_(product) {
  return {
    code: String(product.productNumber || '').trim(),
    name: String(product.description || '').trim(),
    variant: String(product.variant || '').trim(),
    material: String(product.material || '').trim(),
    superCategory: String(product.superCategory || '').trim(),
    subCategory: String(product.subCategory || '').trim(),
    sheet: String(product.sheetName || '').trim(),
    location: String(product.storageLocation || '').trim()
  };
}

function buildShopCataloguePromptText_(products) {
  return products.map(function(product) {
    return [
      'code=' + product.code,
      'name=' + product.name,
      'variant=' + product.variant,
      'material=' + product.material,
      'super=' + product.superCategory,
      'sub=' + product.subCategory,
      'sheet=' + product.sheet,
      'loc=' + product.location
    ].join(' | ');
  }).join('\n');
}

function findExactShopProductCodeMatches_(products, query) {
  var queryCode = String(query || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return products.filter(function(product) {
    return product.code.toLowerCase().replace(/[^a-z0-9]/g, '') === queryCode;
  });
}

function makeShopSearchCacheKey_(query, superCategory, subCategory) {
  var seed = [
    String(query || '').toLowerCase(),
    String(superCategory || ''),
    String(subCategory || '')
  ].join('|');
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed);
  return 'shop_full_catalog_ai_search_v1_' +
    Utilities.base64EncodeWebSafe(digest).slice(0, 60);
}

