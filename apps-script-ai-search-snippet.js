/**
 * Add a branch like this to your existing doGet/doPost action router:
 *
 *   if (action === 'searchProducts') {
 *     return jsonResponse(searchProductsWithAi_(e.parameter));
 *   }
 *
 * This reuses the existing OPENAI_API_KEY script property.
 */

function searchProductsWithAi_(params) {
  var query = String(params.query || '').trim();
  var superCategory = String(params.superCategory || '').trim();
  var subCategory = String(params.subCategory || '').trim();
  var limit = Math.min(Number(params.limit || 100), 100);

  if (!query) return { productNumbers: [] };

  var cache = CacheService.getScriptCache();
  var cacheKey = [
    'aiSearch',
    query.toLowerCase(),
    superCategory.toLowerCase(),
    subCategory.toLowerCase(),
    limit
  ].join('|');
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var allProducts = getProductsFromSheet();
  var scopedProducts = allProducts.filter(function (p) {
    return String(p.productNumber || '').charAt(0) !== 'X' &&
      (!superCategory || String(p.superCategory || '') === superCategory);
  });

  var candidates = shortlistSearchCandidates_(query, scopedProducts, 80);
  if (!candidates.length) return { productNumbers: [] };

  var promptProducts = candidates.map(function (p) {
    return {
      productNumber: p.productNumber,
      description: p.description,
      variant: p.variant,
      material: p.material,
      superCategory: p.superCategory,
      subCategory: p.subCategory
    };
  });

  var apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY script property');

  var payload = {
    model: 'gpt-5.4-mini',
    input: [
      {
        role: 'system',
        content: 'Rank shop products for a customer search. Match intent, synonyms, singular/plural forms, materials, and common retail wording. Return only relevant product numbers from the provided candidates. If no candidate is truly relevant, return an empty list.'
      },
      {
        role: 'user',
        content: JSON.stringify({
          query: query,
          maxResults: limit,
          products: promptProducts
        })
      }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'shop_search_results',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            productNumbers: {
              type: 'array',
              items: { type: 'string' }
            }
          },
          required: ['productNumbers']
        }
      }
    }
  };

  var response = UrlFetchApp.fetch('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var status = response.getResponseCode();
  var body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error('OpenAI search failed: ' + status + ' ' + body);
  }

  var parsed = JSON.parse(body);
  var text = parsed.output_text || extractResponseText_(parsed);
  var result = JSON.parse(text || '{"productNumbers":[]}');
  result.productNumbers = (result.productNumbers || []).slice(0, limit);

  cache.put(cacheKey, JSON.stringify(result), 60 * 30);
  return result;
}

function shortlistSearchCandidates_(query, products, maxCandidates) {
  var qTokens = normalizeSearchTokens_(query);
  var scored = products.map(function (p) {
    var textTokens = normalizeSearchTokens_([
      p.productNumber,
      p.description,
      p.variant,
      p.material,
      p.sheetName,
      p.superCategory,
      p.subCategory
    ].join(' '));
    var text = textTokens.join(' ');
    var score = qTokens.reduce(function (sum, token) {
      return sum + (textTokens.indexOf(token) >= 0 ? 1 : 0);
    }, 0);
    return { product: p, score: score, exactPhrase: text.indexOf(normalizeSearch_(query)) >= 0 };
  }).filter(function (row) {
    return row.score > 0;
  });

  var strictScored = scored.filter(function (row) {
    return row.score === qTokens.length;
  });
  if (strictScored.length) scored = strictScored;

  scored.sort(function (a, b) {
    return b.score - a.score ||
      Number(b.exactPhrase) - Number(a.exactPhrase) ||
      String(a.product.description || '').localeCompare(String(b.product.description || ''));
  });

  return scored.slice(0, maxCandidates).map(function (row) {
    return row.product;
  });
}

function normalizeSearch_(value) {
  return normalizeSearchTokens_(value).join(' ');
}

function normalizeSearchTokens_(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(function (token) {
      if (token === 'glasses') return 'glass';
      if (token.slice(-3) === 'ies') return token.slice(0, -3) + 'y';
      return token.replace(/s$/, '');
    });
}

function extractResponseText_(response) {
  var output = response.output || [];
  for (var i = 0; i < output.length; i++) {
    var content = output[i].content || [];
    for (var j = 0; j < content.length; j++) {
      if (content[j].text) return content[j].text;
    }
  }
  return '';
}
