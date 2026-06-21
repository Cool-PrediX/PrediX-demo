// ============================================================
// src/background.js
// MV3 Service Worker — 配置中心 + 代理 + 缓存 + LLM 轮询
// ============================================================

const CONFIG = {
  API_BASE_URL:      "https://predix-api.tsuyu.love/api",
  GAMMA_API:         "https://gamma-api.polymarket.com",
  POLL_INTERVAL_MS:  1000,
  MAX_POLL_ATTEMPTS: 120,
  MATCH_THRESHOLD:   0.05,
  MAX_TWEETS_PER_BATCH: 5,
  SCAN_DEBOUNCE_MS:  1000,
  POLYMARKET_RELAYER_URL: "https://relayer-v2.polymarket.com",
  POLYMARKET_CLOB_URL:    "https://clob.polymarket.com",
  POLYMARKET_DATA_API:    "https://data-api.polymarket.com",
  POLYMARKET_CHAIN_ID:    137,
  BUILDER_SIGN_URL:       "https://predix-api.tsuyu.love/api/builder/sign",
  POLYGON_RPC_URL:        "https://polygon.drpc.org",
  POLYGON_RPC_LIST:       "https://polygon.drpc.org,https://tenderly.rpc.polygon.community,https://polygon.publicnode.com,https://polygon-mainnet.gateway.tatum.io/,https://polygon-public.nodies.app/,https://1rpc.io/matic,https://rpc-mainnet.matic.quiknode.pro,https://polygon.api.onfinality.io/public",
  POLYMARKET_BRIDGE_URL:  "https://bridge.polymarket.com",
  POLY_BUILDER_CODE:      "0x8033ced98648f8c668353aef7551c5eb185e68296ee78b46671726bd1aa9b6c7",
  CACHE_KEY:         "predix_match_cache",
  CACHE_TTL_MS:      24 * 3600 * 1000,
  MAX_CACHE_ENTRIES: 300,
};

const ALLOWED_HOSTS = (() => {
  const hosts = [];
  try { hosts.push(new URL(CONFIG.API_BASE_URL).hostname); } catch {}
  try { hosts.push(new URL(CONFIG.GAMMA_API).hostname); } catch {}
  try { hosts.push(new URL(CONFIG.POLYMARKET_RELAYER_URL).hostname); } catch {}
  try { hosts.push(new URL(CONFIG.POLYMARKET_CLOB_URL).hostname); } catch {}
  try { hosts.push(new URL(CONFIG.POLYMARKET_DATA_API).hostname); } catch {}
  try { hosts.push(new URL(CONFIG.BUILDER_SIGN_URL).hostname); } catch {}
  try { hosts.push(new URL(CONFIG.POLYMARKET_BRIDGE_URL).hostname); } catch {}
  return hosts;
})();

/* ================================================================
   i18n 归一化
   ================================================================ */

function normalizeResult(data) {
  for (const result of data.results || []) {
    if (!result) continue;
    result.title = result.i18n_title || result.title;
    result.question = result.i18n_question || result.question;
    delete result.i18n_title;
    delete result.i18n_question;
    for (const market of result.markets || []) {
      if (!market) continue;
      if (market.i18n_question) {
        market.question = market.i18n_question;
        delete market.i18n_question;
      }
    }
  }
  return data;
}

/* ================================================================
   Match 缓存（内存 + storage.local）
   ================================================================ */

const cache = new Map();

async function loadCache() {
  const { [CONFIG.CACHE_KEY]: stored } = await chrome.storage.local.get(CONFIG.CACHE_KEY);
  if (stored && Array.isArray(stored)) {
    stored.sort((a, b) => (b.v?.cachedAt || 0) - (a.v?.cachedAt || 0));
    for (let i = 0; i < Math.min(stored.length, CONFIG.MAX_CACHE_ENTRIES); i++) {
      cache.set(stored[i].k, stored[i].v);
    }
  }
}
loadCache();

async function createOffscreen() {
  try {
    const existing = await chrome.offscreen.hasDocument();
    if (!existing) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["DOM_PARSER"],
        justification: "Host ML models for tweet preprocessing",
      });
    }
  } catch (err) { /* offscreen 不可用时静默降级 */ }
}
createOffscreen();

chrome.runtime.onConnect.addListener((port) => {
  // 保持 offscreen keepalive 端口，防止 Chrome 销毁 offscreen 文档
  if (port.name === "offscreen-keepalive") return;
});

function isAllowed(url) {
  try {
    const host = new URL(url).hostname;
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h));
  } catch {
    return false;
  }
}

/* ---------- SHA-256（同步） ---------- */

function sha256Sync(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + c;
    hash |= 0;
  }
  return hash.toString(36);
}

/* ---------- 请求体级别去重 ---------- */

const matchInFlight = new Map();

const bodyCache = new Map();
const BODY_CACHE_KEY = "predix_body_cache";

function cacheBodySet(bodyStr, data) {
  const key = sha256Sync(bodyStr);
  bodyCache.set(key, { cachedAt: Date.now(), data });
  scheduleBodyPersist();
}

function cacheGetByBody(bodyStr) {
  const key = sha256Sync(bodyStr);
  const entry = bodyCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CONFIG.CACHE_TTL_MS) {
    bodyCache.delete(key);
    return null;
  }
  return entry.data;
}

let bodyPersistTimer = null;
function scheduleBodyPersist() {
  if (bodyPersistTimer) clearTimeout(bodyPersistTimer);
  bodyPersistTimer = setTimeout(() => {
    const arr = [];
    for (const [k, v] of bodyCache) {
      if (arr.length < 50) arr.push({ k, v });
    }
    chrome.storage.local.set({ [BODY_CACHE_KEY]: arr }).catch(() => {});
  }, 3000);
}

/* ---------- tweet_hash 级别缓存 ---------- */

function cacheGet(tweetHash) {
  const entry = cache.get(tweetHash);
  if (!entry || !entry.result) return null;
  const expiresAt = entry.result.expires_at
    ? new Date(entry.result.expires_at).getTime()
    : entry.cachedAt + CONFIG.CACHE_TTL_MS;
  if (Date.now() >= expiresAt) {
    cache.delete(tweetHash);
    persistCache();
    return null;
  }
  return entry.result;
}

function cacheSet(tweetHash, result) {
  const normalized = normalizeResult(result);
  normalized.enriched_level = result.enriched_level || 0;
  cache.set(tweetHash, { cachedAt: Date.now(), result: normalized });
  evictIfNeeded();
  persistCache();
}

function cacheUpdate(tweetHash, updater) {
  const entry = cache.get(tweetHash);
  if (entry) {
    updater(entry.result);
    entry.cachedAt = Date.now();
    persistCache();
  }
}

function evictIfNeeded() {
  if (cache.size <= CONFIG.MAX_CACHE_ENTRIES) return;
  const sorted = [...cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
  for (let i = 0; i < sorted.length - CONFIG.MAX_CACHE_ENTRIES; i++) {
    cache.delete(sorted[i][0]);
  }
}

let persistTimer = null;
function persistCache() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const arr = [];
    for (const [k, v] of cache) arr.push({ k, v });
    chrome.storage.local.set({ [CONFIG.CACHE_KEY]: arr }).catch(() => {
      chrome.storage.local.clear(() => cache.clear());
    });
  }, 2000);
}

/* ================================================================
   LLM 轮询 — chrome.alarms 驱动
   ================================================================ */

const pendingPolls = new Map();
let defaultLang = "en";

function startPolling(tweetHash, language, tabId) {
  if (language) defaultLang = language;
  if (pendingPolls.has(tweetHash)) return;
  const cached = cacheGet(tweetHash);
  if (cached && !cached.is_optimizing) return;

  pendingPolls.set(tweetHash, { attempts: 0, tabId, lastLevel: 0 });
  kickPollAlarm();
}

function kickPollAlarm() {
  const delayInMinutes = CONFIG.POLL_INTERVAL_MS / 60000;
  chrome.alarms.create("pollTick", { delayInMinutes });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pollTick") executeBatchPoll();
});

async function executeBatchPoll() {
  const hashes = [...pendingPolls.keys()];
  if (hashes.length === 0) return;

  try {
    const params = new URLSearchParams({ hashes: hashes.join(",") });
    const resp = await fetch(`${CONFIG.API_BASE_URL}/tweet/poll?${params}`);
    if (!resp.ok) { kickPollAlarm(); return; }

    const data = await resp.json();
    for (const item of data.results || []) {
      const task = pendingPolls.get(item.tweet_hash);
      if (!task) continue;

      const level = item.enriched_level || 0;
      const isCompleted = item.status === "COMPLETED" || item.status === "completed" || level >= 3;

      if (isCompleted) {
        pendingPolls.delete(item.tweet_hash);
        onPollCompleted(item.tweet_hash, item, task.tabId);
      } else if (level >= 1 && (!task.lastLevel || task.lastLevel < level)) {
        task.lastLevel = level;
        pushIntermediateResult(item.tweet_hash, item, task.tabId);
      } else {
        task.attempts++;
        if (task.attempts >= CONFIG.MAX_POLL_ATTEMPTS) {
          pendingPolls.delete(item.tweet_hash);
        }
      }
    }
  } catch {}

  if (pendingPolls.size > 0) kickPollAlarm();
}

function pushIntermediateResult(tweetHash, pollResult, tabId) {
  cacheUpdate(tweetHash, (c) => {
    const rawResults = pollResult._enriched_initial || pollResult.initial_results || pollResult.results || [];
    const existingMap = new Map();
    for (const orig of c.results || []) existingMap.set(orig.id, orig);

    c.results = rawResults.map((r) => {
      const id = r.id || r.event_id;
      const existing = existingMap.get(id);
      return {
        id:          id || existing?.id,
        title:       r.i18n_title || r.title || r.question || existing?.title || "",
        question:    r.i18n_question || r.question || existing?.question || "",
        rank:        r.rank != null ? r.rank : (r.score ?? existing?.rank ?? 0),
        category:    r.category ?? existing?.category,
        markets:     (r.markets?.length ? r.markets : existing?.markets) || [],
        description: existing?.description || "",
        descriptionOriginal: existing?.descriptionOriginal || r.description || "",
        i18n_title:  r.i18n_title || existing?.i18n_title,
      };
    });
    c.is_optimizing = true;
    c.enriched_level = pollResult.enriched_level || 1;
  });

  const updated = cacheGet(tweetHash);
  if (updated && tabId != null) {
    chrome.tabs.sendMessage(tabId, {
      type: "LLM_RESULT_READY",
      hash: tweetHash,
      results: updated.results,
      is_optimizing: true,
    }).catch(() => {});
  }
}

function onPollCompleted(tweetHash, pollResult, tabId) {
  cacheUpdate(tweetHash, (c) => {
    c.is_optimizing = false;
    const threshold = CONFIG.MATCH_THRESHOLD;
    const llmResults = pollResult.results || [];
    c.results = (c.results || [])
      .map((orig) => {
        const llm = llmResults.find((r) => r.event_id === orig.id);
        if (!llm || llm.score < threshold) return null;
        return {
          ...orig,
          title:    llm.i18n_question || llm.question || orig.title,
          question: llm.i18n_question || llm.question || orig.question,
          rank:     llm.score,
        };
      })
      .filter(Boolean);
  });

  const updated = cacheGet(tweetHash);
  if (updated && tabId != null) {
    chrome.tabs
      .sendMessage(tabId, {
        type: "LLM_RESULT_READY",
        hash: tweetHash,
        results: updated.results,
        is_optimizing: false,
      })
      .catch(() => {});
  }
}

/* ================================================================
   请求处理
   ================================================================ */

async function handleMatchRequest(url, options, tabId, sendResponse) {
  try {
  const bodyStr = options.body || "{}";
  const body = JSON.parse(bodyStr);
  const tweets = body.tweets || [];
  const lang = body.language || "en";

  const bodyKey = sha256Sync(bodyStr);
  if (matchInFlight.has(bodyKey)) {
    try {
      const res = await matchInFlight.get(bodyKey);
      sendResponse(res);
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return;
  }

  const cached = cacheGetByBody(bodyStr);
  if (cached) {
    sendResponse({ success: true, status: 200, body: JSON.stringify(cached) });
    return;
  }

  const promise = (async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: options.headers || { "Content-Type": "application/json" },
      body: options.body,
    });
    const text = await res.text();

    if (res.ok) {
      const data = JSON.parse(text);
      normalizeResult(data);

      let hasResults = false;
      for (const result of data.results || []) {
        if (!result || !result.tweet_hash) continue;
        if (!result.results || result.results.length === 0) continue;
        hasResults = true;
        cacheSet(result.tweet_hash, result);
        if (result.is_optimizing) {
          startPolling(result.tweet_hash, lang, tabId);
        }
      }

      if (hasResults) cacheBodySet(bodyStr, data);
      return { success: true, status: res.status, body: text };
    }
    return { success: false, status: res.status, body: text };
  })();

  matchInFlight.set(bodyKey, promise);
  try {
    const res = await promise;
    sendResponse(res);
  } catch (err) {
    sendResponse({ success: false, error: err.message });
  } finally {
    matchInFlight.delete(bodyKey);
  }
  } catch (err) {
    sendResponse({ success: false, error: err.message || "Invalid match request" });
  }
}

/* ---------- Proxy cache (in-memory, TTL-based) ---------- */

const proxyCache = new Map();
const proxyInFlight = new Map();

function getCacheTtl(url) {
  if (url.includes("/markets/")) return 10_000;
  if (url.includes("/events?")) return 120_000;
  if (url.includes("/book?")) return 5_000;
  if (url.includes("/prices-history")) return 300_000;
  if (url.includes("/positions")) return 0;
  if (url.includes("/market-positions")) return 0;
  return 10_000;
}

function proxyCacheGet(url) {
  const entry = proxyCache.get(url);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) { proxyCache.delete(url); return null; }
  return entry.body;
}

function proxyCacheSet(url, body) {
  const ttl = getCacheTtl(url);
  proxyCache.set(url, { body, expiresAt: Date.now() + ttl });
  if (proxyCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of proxyCache) { if (now >= v.expiresAt) proxyCache.delete(k); }
    if (proxyCache.size > 200) {
      const sorted = [...proxyCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      while (proxyCache.size > 200 && sorted.length > 0) {
        const [k] = sorted.shift();
        proxyCache.delete(k);
      }
    }
  }
}

async function proxyRequest(url, options, sendResponse) {
  const method = options?.method || "GET";
  const isCacheable = method === "GET" && !options?.body;

  if (isCacheable) {
    const cached = proxyCacheGet(url);
    if (cached) { sendResponse({ success: true, status: 200, body: cached }); return; }
    if (proxyInFlight.has(url)) {
      try { const res = await proxyInFlight.get(url); sendResponse(res); } catch (err) { sendResponse({ success: false, error: err.message }); }
      return;
    }
  }

  const promise = (async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      try {
        const res = await fetch(url, {
          method, headers: options?.headers || {}, body: options?.body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        const result = { success: res.ok, status: res.status, body: text };
        if (res.ok && isCacheable) proxyCacheSet(url, text);
        return result;
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    } catch (err) {
      console.error("[proxyRequest] fetch failed:", url, err?.message || err);
      throw err;
    }
  })();

  if (isCacheable) {
    proxyInFlight.set(url, promise);
    try { const res = await promise; sendResponse(res); } catch (err) { console.error("[proxyRequest] cached path failed:", url, err?.message || err); sendResponse({ success: false, error: err.message }); }
    finally { proxyInFlight.delete(url); }
  } else {
    try { const res = await promise; sendResponse(res); } catch (err) { console.error("[proxyRequest] non-cached path failed:", url, err?.message || err); sendResponse({ success: false, error: err.message }); }
  }
}

/* ================================================================
   SW 重启恢复 + 心跳保活
   ================================================================ */

(function recoverPolls() {
  for (const [hash, entry] of cache) {
    if (entry.result?.is_optimizing) startPolling(hash, defaultLang, null);
  }
})();

chrome.alarms.create("heartbeat", { periodInMinutes: 0.33 });

/* ================================================================
   扩展图标点击 → 切换侧边栏
   ================================================================ */

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SIDEBAR" }).catch(() => {
    /* 非 Twitter 页面无 content script，静默忽略 */
  });
});

/* ================================================================
   消息路由
   ================================================================ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message.type) {
    case "GET_CONFIG": {
      sendResponse({
        API_BASE_URL: CONFIG.API_BASE_URL,
        GAMMA_API: CONFIG.GAMMA_API,
        POLL_INTERVAL_MS: CONFIG.POLL_INTERVAL_MS,
        MAX_POLL_ATTEMPTS: CONFIG.MAX_POLL_ATTEMPTS,
        MATCH_THRESHOLD: CONFIG.MATCH_THRESHOLD,
        MAX_TWEETS_PER_BATCH: CONFIG.MAX_TWEETS_PER_BATCH,
        SCAN_DEBOUNCE_MS: CONFIG.SCAN_DEBOUNCE_MS,
        POLYMARKET_RELAYER_URL: CONFIG.POLYMARKET_RELAYER_URL,
        POLYMARKET_CLOB_URL: CONFIG.POLYMARKET_CLOB_URL,
        POLYMARKET_DATA_API: CONFIG.POLYMARKET_DATA_API,
        POLYMARKET_CHAIN_ID: CONFIG.POLYMARKET_CHAIN_ID,
        BUILDER_SIGN_URL: CONFIG.BUILDER_SIGN_URL,
        POLYGON_RPC_URL: CONFIG.POLYGON_RPC_URL,
        POLYGON_RPC_LIST: CONFIG.POLYGON_RPC_LIST,
        POLYMARKET_BRIDGE_URL: CONFIG.POLYMARKET_BRIDGE_URL,
        POLY_BUILDER_CODE: CONFIG.POLY_BUILDER_CODE,
      });
      return false;
    }

    case "PROXY_FETCH": {
      const { url, options } = message;
      if (!isAllowed(url)) {
        sendResponse({ success: false, error: "Host not allowed" });
        return false;
      }
      if (url.includes("/tweet/match") && options?.method === "POST") {
        handleMatchRequest(url, options, tabId, sendResponse);
        return true;
      }
      proxyRequest(url, options, sendResponse);
      return true;
    }

    case "QUERY_CACHE": {
      const { hash: tweetHash } = message;
      const result = cacheGet(tweetHash);
      sendResponse(result ? { success: true, data: result } : { success: false });
      return false;
    }

    case "BULK_QUERY_CACHE": {
      const { hashes } = message;
      const results = {};
      for (const h of (hashes || [])) {
        const entry = cacheGet(h);
        if (entry) results[h] = entry;
      }
      sendResponse({ success: true, results });
      return false;
    }

    case "CLEAR_CACHE": {
      cache.clear();
      bodyCache.clear();
      chrome.storage.local.remove(CONFIG.CACHE_KEY);
      chrome.storage.local.remove(BODY_CACHE_KEY);
      sendResponse({ success: true });
      return false;
    }

    case "GET_TOKENS": {
      // 转发到 offscreen document（ML Worker）；未就绪时静默降级
      try {
        let responded = false;
        const timer = setTimeout(() => {
          if (!responded) { responded = true; sendResponse(null); }
        }, 15_000);
        chrome.runtime.sendMessage(message, (response) => {
          if (responded) return;
          responded = true;
          clearTimeout(timer);
          if (chrome.runtime.lastError) { sendResponse(null); return; }
          sendResponse(response);
        });
      } catch {
        sendResponse(null);
      }
      return true;
    }

    default:
      return false;
  }
});
