const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const SEARCH_SIZE_DEFAULT = 40;
const SEARCH_SIZE_MAX = 48;
const CACHE_TTL_MS = 30 * 1000;

app.disable('x-powered-by');
// Netlify(정적 프런트엔드)에서 별도 호스팅된 이 API를 호출할 수 있도록 CORS 허용.
// API는 검색어만 받으며 임의 URL 프록시는 제공하지 않습니다.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(__dirname, { extensions: ['html'] }));

let browserPromise;
const searchCache = new Map();
let activeSearches = 0;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
  }
  try {
    return await browserPromise;
  } catch (error) {
    browserPromise = null;
    throw error;
  }
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'oliveprice-search', browser: 'playwright' });
});

app.get('/api/oliveyoung/search', async (req, res) => {
  const keyword = cleanText(req.query.q).slice(0, 80);
  const pageNo = Math.max(1, Math.min(50, Number.parseInt(req.query.page, 10) || 1));
  const size = Math.max(1, Math.min(SEARCH_SIZE_MAX, Number.parseInt(req.query.size, 10) || SEARCH_SIZE_DEFAULT));
  if (!keyword) return res.status(400).json({ error: '검색어를 입력해 주세요.' });

  const cacheKey = `${keyword.toLocaleLowerCase('ko-KR')}|${pageNo}|${size}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return res.json({ ...cached.payload, cached: true });
  }
  if (activeSearches >= 2) {
    return res.status(503).json({ error: '검색 요청이 많습니다. 잠시 후 다시 시도해 주세요.' });
  }

  activeSearches += 1;
  let context;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      viewport: { width: 1440, height: 1000 }
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(8000);

    const searchUrl = new URL('https://www.oliveyoung.co.kr/store/search/getSearchMain.do');
    searchUrl.searchParams.set('query', keyword);
    searchUrl.searchParams.set('listnum', String(size));
    searchUrl.searchParams.set('pageIdx', String(pageNo));
    searchUrl.searchParams.set('giftYn', 'N');
    searchUrl.searchParams.set('goods_sort', 'WEIGHT/DESC,RANK/DESC');

    const response = await page.goto(searchUrl.toString(), { waitUntil: 'domcontentloaded' });
    if (!response || response.status() >= 400) {
      throw new Error(`올리브영 검색 페이지 응답 오류 (${response ? response.status() : '응답 없음'})`);
    }

    // Search result cards may be rendered after the initial document response.
    await page.waitForSelector('a[href*="goodsNo="]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(900);

    const extracted = await page.evaluate(({ requestedSize }) => {
      const absoluteUrl = (value) => {
        if (!value) return '';
        try { return new URL(value, location.origin).href; } catch { return ''; }
      };
      const priceFromText = (value) => {
        const matches = String(value || '').match(/[0-9][0-9,]{2,}/g) || [];
        return matches.map(v => Number(v.replace(/,/g, ''))).filter(v => Number.isFinite(v) && v >= 100);
      };
      const textOf = (node) => (node?.innerText || node?.textContent || '').replace(/\s+/g, ' ').trim();
      const cleanText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const anchors = Array.from(document.querySelectorAll('a[href*="goodsNo="]'))
        .filter(a => /getGoodsDetail\.do|goodsNo=/i.test(a.getAttribute('href') || ''));
      const seen = new Set();
      const items = [];

      for (const anchor of anchors) {
        const hrefRaw = anchor.getAttribute('href') || '';
        const codeMatch = hrefRaw.match(/[?&]goodsNo=([A-Za-z0-9]+)/i) || hrefRaw.match(/goodsNo=([A-Za-z0-9]+)/i);
        if (!codeMatch) continue;
        const goodsNo = codeMatch[1];
        if (seen.has(goodsNo)) continue;

        // Find the nearest ancestor that looks like one product card, not the whole result list.
        let card = anchor;
        let bestCard = anchor;
        let bestScore = -1;
        for (let depth = 0; depth < 9 && card; depth += 1, card = card.parentElement) {
          const cardText = textOf(card);
          if (!cardText || cardText.length > 900) continue;
          const imageCount = card.querySelectorAll('img').length;
          const detailCodes = new Set(Array.from(card.querySelectorAll('a[href*="goodsNo="]')).map(a => {
            const m = (a.getAttribute('href') || '').match(/goodsNo=([A-Za-z0-9]+)/i);
            return m ? m[1] : null;
          }).filter(Boolean));
          if (detailCodes.size > 1) continue;
          const hasPrice = /[0-9][0-9,]*\s*원/.test(cardText);
          const hasNameClass = !!card.querySelector('[class*="prd_name"], [class*="goods_name"], [class*="product_name"], [class*="tx_name"]');
          const className = String(card.className || '');
          const score = (imageCount ? 3 : 0) + (hasPrice ? 4 : 0) + (hasNameClass ? 3 : 0) + (/prd|goods|product|item/i.test(className) ? 2 : 0) + (cardText.length >= 18 ? 1 : 0) - depth * 0.05;
          if (score > bestScore) { bestScore = score; bestCard = card; }
        }
        const cardText = textOf(bestCard) || textOf(anchor);
        const nameSelectors = [
          '[class*="prd_name"]', '[class*="goods_name"]', '[class*="product_name"]',
          '[class*="tx_name"]', '[class*="tit"]', '[class*="name"]'
        ];
        const nameCandidates = [];
        for (const selector of nameSelectors) {
          for (const node of bestCard.querySelectorAll(selector)) {
            const value = textOf(node);
            if (value.length >= 3 && value.length <= 180 && !/^[0-9,]+\s*원$/.test(value)) nameCandidates.push(value);
          }
        }
        const anchorTitle = cleanText(anchor.getAttribute('title') || anchor.getAttribute('aria-label') || textOf(anchor));
        const name = nameCandidates.sort((a, b) => b.length - a.length)[0] || anchorTitle || cardText.slice(0, 180);
        if (!name || name.length < 2) continue;

        const brandNode = bestCard.querySelector('[class*="brand"], .tx_brand, .prd_brand');
        const brand = cleanText(textOf(brandNode));
        const imageNode = bestCard.querySelector('img') || anchor.querySelector('img');
        const imageUrl = imageNode ? absoluteUrl(
          imageNode.getAttribute('data-original') || imageNode.getAttribute('data-src') ||
          imageNode.getAttribute('data-lazy') || imageNode.currentSrc || imageNode.getAttribute('src') || ''
        ) : '';

        const currentPriceNode = bestCard.querySelector('.tx_cur, [class*="sale_price"], [class*="current_price"], [class*="price"]');
        const currentPriceValues = priceFromText(textOf(currentPriceNode));
        const allPriceValues = priceFromText(cardText);
        const distinctPrices = [...new Set(allPriceValues)].sort((a, b) => a - b);
        const currentPrice = (currentPriceValues.length ? Math.min(...currentPriceValues) : distinctPrices[0]) || null;
        const originalPriceNode = bestCard.querySelector('.tx_org, [class*="original_price"], [class*="normal_price"], del, s');
        const originalPriceValues = priceFromText(textOf(originalPriceNode));
        const originalPrice = originalPriceValues[0] || distinctPrices[distinctPrices.length - 1] || currentPrice;

        seen.add(goodsNo);
        items.push({
          goodsNo,
          name,
          brand,
          currentPrice,
          originalPrice,
          imageUrl,
          externalUrl: absoluteUrl(hrefRaw)
        });
        if (items.length >= requestedSize) break;
      }

      const bodyText = textOf(document.body).slice(0, 6000);
      const title = document.title || '';
      const blocked = /잠시만 기다려|접근이 제한|자동화된 접근|보안 확인|access denied|just a moment|captcha|비정상적인 접근/i.test(`${title} ${bodyText}`);
      const explicitEmpty = /검색 결과가 없습니다|검색된 상품이 없습니다|검색 결과가 존재하지 않습니다/i.test(bodyText);
      const totalMatch = bodyText.match(/(?:총\s*)?([0-9][0-9,]*)\s*건/);
      const totalCount = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null;
      return { items, title, blocked, explicitEmpty, totalCount, bodyPreview: bodyText.slice(0, 500) };
    }, { requestedSize: size });

    if (extracted.blocked) {
      throw new Error('올리브영이 자동화 접근을 제한했거나 보안 확인 화면을 표시했습니다. 올리브영 사이트에서 직접 검색해 주세요.');
    }
    if (!extracted.items.length && !extracted.explicitEmpty) {
      throw new Error('올리브영 페이지는 열렸지만 상품 목록을 읽지 못했습니다. 검색 페이지 구조가 변경되었거나 일시적으로 목록이 표시되지 않았을 수 있습니다.');
    }

    const payload = {
      keyword,
      page: pageNo,
      pageSize: size,
      totalCount: extracted.totalCount,
      returnedCount: extracted.items.length,
      hasNext: extracted.totalCount != null ? pageNo * extracted.items.length < extracted.totalCount : extracted.items.length >= size,
      items: extracted.items,
      source: 'oliveyoung-online-search',
      sourceUrl: searchUrl.toString(),
      fetchedAt: new Date().toISOString()
    };
    searchCache.set(cacheKey, { time: Date.now(), payload });
    // Keep the in-memory cache bounded.
    if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
    return res.json(payload);
  } catch (error) {
    console.error('[oliveyoung-search]', error.message);
    return res.status(502).json({ error: error.message || '올리브영 검색 중 오류가 발생했습니다.' });
  } finally {
    activeSearches -= 1;
    if (context) await context.close().catch(() => {});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OlivePrice server running: http://localhost:${PORT}`);
});
