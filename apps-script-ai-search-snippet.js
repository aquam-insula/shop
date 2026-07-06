/**
 * Add a branch like this to your existing doGet/doPost action router:
 *
 *   if (action === 'searchProducts') {
 *     return jsonResponse(searchProductsWithAi_(e.parameter));
 *   }
 *
 * or inside the existing switch:
 *
 *   case 'searchProducts':
 *     data = searchProductsWithAi_(e.parameter);
 *     break;
 *
 * This searches the public shop catalogue with GPT and reuses the existing
 * OPENAI_API_KEY script property.
 */

function searchProductsWithAi_(params) {
  var query = String(params.query || '').trim();
  var superCategory = String(params.superCategory || '').trim();
  var subCategory = String(params.subCategory || '').trim();
  var limit = Math.min(Number(params.limit || 100), 100);

  if (query.length < 2) {
    return { productNumbers: [], summary: 'Please enter a more specific search phrase.' };
  }

  var cache = CacheService.getScriptCache();
  var cacheKey = makeShopAiSearchCacheKey_(query, superCategory, subCategory, limit);
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var allProducts = getProductsFromSheet();
  var scopedProducts = allProducts
    .filter(function(p) {
      return String(p.productNumber || '').charAt(0) !== 'X' &&
        (!superCategory || String(p.superCategory || '') === superCategory);
    })
    .map(compactShopSearchProduct_)
    .filter(function(p) {
      return p.productNumber || p.description;
    });

  var exactMatches = findExactShopSearchMatches_(query, scopedProducts);
  if (exactMatches.length) {
    var exactResult = {
      productNumbers: exactMatches.map(function(p) { return p.productNumber; }).slice(0, limit),
      summary: 'Exact product-number match.'
    };
    cache.put(cacheKey, JSON.stringify(exactResult), 60 * 30);
    return exactResult;
  }

  var apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('Missing OPENAI_API_KEY script property');

  var model = PropertiesService.getScriptProperties().getProperty('SHOP_SEARCH_MODEL') || 'gpt-5.4-mini';
  var catalogueText = buildShopCatalogueText_(scopedProducts);

  var payload = {
    model: model,
    input: [
      {
        role: 'system',
        content: [
          'Rank public AQUAM INSULA shop products for a customer search.',
          'Match buyer intent, synonyms, singular/plural forms, materials, marine use cases, lifestyle wording, category, and product compatibility.',
          'Return only relevant product numbers from the public catalogue.',
          'If no product is truly relevant, return an empty list.'
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
          maxResults: limit,
          instruction: [
            'Return best matching productNumbers only, ranked best first.',
            'Prefer exact product-number matches first.',
            'If currentSubCategory is provided, prefer matches there unless another product is clearly better.',
            'Avoid broad or weakly related products.'
          ].join(' ')
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
            },
            summary: { type: 'string' }
          },
          required: ['productNumbers', 'summary']
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
  var result = JSON.parse(text || '{"productNumbers":[],"summary":""}');

  var productNumberSet = {};
  scopedProducts.forEach(function(p) {
    productNumberSet[p.productNumber] = true;
  });

  result.productNumbers = (result.productNumbers || [])
    .map(function(productNumber) { return String(productNumber || '').trim(); })
    .filter(function(productNumber, index, arr) {
      return productNumber &&
        productNumberSet[productNumber] &&
        arr.indexOf(productNumber) === index;
    })
    .slice(0, limit);
  result.summary = String(result.summary || '').slice(0, 220);

  cache.put(cacheKey, JSON.stringify(result), 60 * 30);
  return result;
}

function compactShopSearchProduct_(p) {
  return {
    productNumber: String(p.productNumber || '').trim(),
    description: String(p.description || '').trim(),
    variant: String(p.variant || '').trim(),
    material: String(p.material || '').trim(),
    sheetName: String(p.sheetName || '').trim(),
    superCategory: String(p.superCategory || '').trim(),
    subCategory: String(p.subCategory || '').trim(),
    storageLocation: String(p.storageLocation || '').trim()
  };
}

function buildShopCatalogueText_(products) {
  return products.map(function(p) {
    return [
      'productNumber=' + p.productNumber,
      'description=' + p.description,
      'variant=' + p.variant,
      'material=' + p.material,
      'superCategory=' + p.superCategory,
      'subCategory=' + p.subCategory,
      'sheetName=' + p.sheetName,
      'storageLocation=' + p.storageLocation
    ].join(' | ');
  }).join('\n');
}

function findExactShopSearchMatches_(query, products) {
  var queryCode = String(query || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return products.filter(function(p) {
    return p.productNumber.toLowerCase().replace(/[^a-z0-9]/g, '') === queryCode;
  });
}

function makeShopAiSearchCacheKey_(query, superCategory, subCategory, limit) {
  var seed = [
    'aiSearchFullCatalogue',
    String(query || '').toLowerCase(),
    String(superCategory || '').toLowerCase(),
    String(subCategory || '').toLowerCase(),
    String(limit || '')
  ].join('|');
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, seed);
  return 'aiSearchFull_' + Utilities.base64EncodeWebSafe(digest).slice(0, 80);
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
