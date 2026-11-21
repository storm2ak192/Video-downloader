// Mori Scraper Engine Runtime Loader
// GNU General Public License v3.0 — (C) 2026 coflyn.

import * as utils from "../utils/index.js";
import * as urlUtils from "../utils/urlUtils.js";
import * as core from "../modules/core.js";
import { scraperFetch } from "./httpHelper.js";
import { scrapeFacebookWeb } from "./facebook.js";

export * from "./httpHelper.js";

export const BUNDLED_SCRAPER_VERSION = 6;
window.__MORI_BUNDLED_SCRAPER_VERSION__ = BUNDLED_SCRAPER_VERSION;

// Expose deps to the bundled IIFE core
window.__moriDeps = { utils, urlUtils, core };

// Route browser-only scraper traffic through Mori's same-origin safe relay.
// The native app keeps using Capacitor HTTP and is not affected by this wrapper.
const RELAY_HOSTS = [
  "tiktok.com","tikdownloader.io","tiktokio.com","snapsave.app","indown.net","savevid.net","fastdl.to",
  "youtube.com","youtu.be","ytimg.com","ytmp3.gg","ytmp3.mobi","media.ytmp3.gg","convert1s.com",
  "twitter.com","x.com","fxtwitter.com","vxtwitter.com","twittervideodownloader.com","savetwt.com",
  "spotify.com","spotidown.app","spotimate.app","aplmate.com",
  "pinterest.com","pin.it","pindown.io","instagram.com","facebook.com","fb.watch",
  "xiaohongshu.com","xhslink.com","xhslink.cn","rednote.com",
  "threads.com","threads.net","threadster.app",
  "bilibili.com","bilibili.tv","b23.tv","bili.im",
  "douyin.com","iesdouyin.com","snssdk.com",
  "bandcamp.com","bandcampdownloader.app","pixiv.net","pximg.net","pixiv.re","ugoira.com",
  "reddit.com","redd.it","rapidsave.com",
  "terabox.com","teraboxapp.com","1024tera.com","nephobox.com","4funbox.com","mirrobox.com","momerybox.com","tibibox.com","sechno.com",
];

function installBrowserScraperRelay() {
  if (window.Capacitor?.isNativePlatform?.() || window.__moriBrowserRelayInstalled) return;
  const nativeFetch = window.fetch.bind(window);
  const isRelayHost = (hostname) => RELAY_HOSTS.some((domain) =>
    hostname === domain || hostname.endsWith("." + domain)
  );

  window.fetch = async (input, init = {}) => {
    const isRequestInput = typeof Request !== "undefined" && input instanceof Request;
    // Do not proxy ordinary media downloads or app fetches; scraperFetch always
    // supplies its explicit User-Agent/header object.
    if (!init.headers && !isRequestInput) return nativeFetch(input, init);

    const requestUrl = typeof input === "string" || input instanceof URL
      ? String(input)
      : input?.url;
    if (!requestUrl) return nativeFetch(input, init);

    let target;
    try { target = new URL(requestUrl, window.location.href); }
    catch { return nativeFetch(input, init); }

    if (target.origin === window.location.origin || !isRelayHost(target.hostname)) {
      return nativeFetch(input, init);
    }

    const requestObject = typeof Request !== "undefined" && input instanceof Request
      ? input.clone()
      : null;
    const method = String(init.method || requestObject?.method || "GET").toUpperCase();
    const headers = new Headers(requestObject?.headers || undefined);
    if (init.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));

    let body = init.body;
    if (body == null && requestObject && method !== "GET" && method !== "HEAD") {
      body = await requestObject.text();
    }
    if (body instanceof URLSearchParams) body = body.toString();
    if (body instanceof FormData) {
      throw new TypeError("FormData scraper requests are not supported by the secure web relay.");
    }
    if (body != null && typeof body !== "string") body = String(body);

    const relayResponse = await nativeFetch("/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        url: target.toString(),
        method,
        headers: Object.fromEntries(headers.entries()),
        body: body == null ? null : body,
        responseType: null,
      }),
      cache: "no-store",
      signal: init.signal || requestObject?.signal,
    });

    let payload;
    try { payload = await relayResponse.json(); }
    catch { throw new TypeError("Mori's secure scraper relay returned an invalid response."); }
    if (!relayResponse.ok || payload?.error) {
      throw new TypeError(payload?.error || "Mori's secure scraper relay failed.");
    }

    let responseBody = payload?.data ?? "";
    if (payload?.encoding === "base64") {
      const binary = atob(responseBody);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      responseBody = bytes;
    }
    const status = Number(payload?.status || 200);
    const response = new Response(
      method === "HEAD" || status === 204 || status === 205 || status === 304 ? null : responseBody,
      { status, headers: payload?.headers || {} },
    );
    try { Object.defineProperty(response, "url", { value: payload?.url || target.toString() }); } catch {}
    return response;
  };

  window.__moriBrowserRelayInstalled = true;
}

installBrowserScraperRelay();

let _corePromise = null;

async function fetchBundleText() {
  const urls = [
    "js/scrapers/bundle.js",
    "/js/scrapers/bundle.js",
    "./js/scrapers/bundle.js",
    "file:///android_asset/public/js/scrapers/bundle.js",
  ];
  for (const u of urls) {
    try {
      const res = await fetch(u);
      if (res.ok) return res.text();
    } catch (_) {}
  }
  // XHR fallback (Android WebView edge cases)
  if (typeof XMLHttpRequest !== "undefined") {
    for (const u of urls) {
      const text = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", u, true);
        xhr.onload = () => (xhr.status === 200 || (xhr.status === 0 && xhr.responseText)) ? resolve(xhr.responseText) : resolve(null);
        xhr.onerror = () => resolve(null);
        xhr.send();
      });
      if (text) return text;
    }
  }
  throw new Error("[Mori] Could not load scrapers/bundle.js");
}

async function loadCoreScrapers() {
  if (_corePromise) return _corePromise;
  _corePromise = (async () => {
    let scriptText = null;
    let isFromOtaPatch = false;

    // A. OTA patch from localStorage (plain JS text)
    try {
      const patchedText = localStorage.getItem("mori_patched_scraper_bin");
      const activeVer = parseInt(localStorage.getItem("mori_active_scraper_version") || "0", 10);
      if (patchedText && activeVer >= BUNDLED_SCRAPER_VERSION) {
        scriptText = patchedText;
        isFromOtaPatch = true;
        console.log(`[Mori] Loaded OTA patched scraper core v${activeVer}`);
      }
    } catch (otaErr) {
      console.warn("[Mori] OTA patch load warning:", otaErr);
    }

    try {
      // B. Fallback to bundled bundle.js
      if (!scriptText) {
        scriptText = await fetchBundleText();
      }

      const fn = new Function(
        scriptText +
          "\nreturn typeof __MoriCoreScrapers !== 'undefined' ? __MoriCoreScrapers : (typeof window !== 'undefined' ? window.__MoriCoreScrapers : null);"
      );
      const mod = fn();

      if (!mod) throw new Error("[Mori] Failed to instantiate core scraper modules.");

      window.__MoriCoreScrapers = mod;
      console.log(`[Mori] Core scrapers ready (${isFromOtaPatch ? "OTA Patch" : "Bundled"} v${BUNDLED_SCRAPER_VERSION}).`);
      return mod;
    } catch (e) {
      // Safe-mode: corrupted OTA patch → clear and retry with bundled
      if (isFromOtaPatch) {
        console.warn("[Mori] Corrupted OTA patch — resetting to bundled core.", e);
        localStorage.removeItem("mori_patched_scraper_bin");
        localStorage.removeItem("mori_active_scraper_version");
        _corePromise = null;
        return loadCoreScrapers();
      }
      console.error("[Mori] Fatal init error:", e);
      if (typeof window.showFatalErrorModal === "function") {
        window.showFatalErrorModal(e.message || String(e));
      }
      throw e;
    }
  })();
  return _corePromise;
}

export async function scrapeTikTok(...args) { return (await loadCoreScrapers()).scrapeTikTok(...args); }
export function setTikTokSource(...args) { loadCoreScrapers().then((m) => m.setTikTokSource(...args)); }

export async function scrapeYouTube(...args) { return (await loadCoreScrapers()).scrapeYouTube(...args); }
export function setYouTubeSource(...args) { loadCoreScrapers().then((m) => m.setYouTubeSource(...args)); }

export async function scrapeInstagram(...args) { return (await loadCoreScrapers()).scrapeInstagram(...args); }
export function setInstagramSource(...args) { loadCoreScrapers().then((m) => m.setInstagramSource(...args)); }

export async function scrapeTwitter(...args) { return (await loadCoreScrapers()).scrapeTwitter(...args); }
export function setTwitterSource(...args) { loadCoreScrapers().then((m) => m.setTwitterSource(...args)); }

export async function scrapeSpotify(...args) { return (await loadCoreScrapers()).scrapeSpotify(...args); }
export function setSpotifySource(...args) { loadCoreScrapers().then((m) => m.setSpotifySource(...args)); }

export async function scrapeBilibili(...args) { return (await loadCoreScrapers()).scrapeBilibili(...args); }
export async function scrapePixiv(...args) { return (await loadCoreScrapers()).scrapePixiv(...args); }
export async function scrapeRedNote(...args) { return (await loadCoreScrapers()).scrapeRedNote(...args); }

export async function scrapeDouyin(url, ...rest) {
  const originalUrl = url;
  let targetUrl = url;

  if (typeof url === "string" && (url.includes("v.douyin.com") || url.includes("/share/slides/"))) {
    try {
      let resolvedUrl = url;
      if (url.includes("v.douyin.com")) {
        const fetchRes = await scraperFetch(
          {
            url,
            method: "GET",
            headers: {
              "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            },
            rawResponse: true,
          },
          "Douyin Resolver"
        );
        if (fetchRes?.url) resolvedUrl = fetchRes.url;
      }
      const slidesMatch = resolvedUrl.match(new RegExp("share/slides/([0-9]{15,22})", "i"));
      if (slidesMatch?.[1]) {
        targetUrl = "https://www.iesdouyin.com/share/video/" + slidesMatch[1] + "/";
      } else if (resolvedUrl && resolvedUrl !== url) {
        targetUrl = resolvedUrl;
      }
    } catch (e) {
      console.warn("[Mori] Douyin resolver warning:", e);
    }
  }

  const c = await loadCoreScrapers();
  let res;
  try {
    res = await c.scrapeDouyin(targetUrl, ...rest);
    if (!res || !res.status) {
      await new Promise((r) => setTimeout(r, 400));
      res = await c.scrapeDouyin(targetUrl, ...rest);
    }
  } catch (err) {
    await new Promise((r) => setTimeout(r, 400));
    res = await c.scrapeDouyin(targetUrl, ...rest);
  }

  if (res) {
    if (res.result) res.result.sourceUrl = originalUrl;
    if (res.data) res.data.sourceUrl = originalUrl;
    res.sourceUrl = originalUrl;
  }
  return res;
}

export async function scrapeThreads(...args) { return (await loadCoreScrapers()).scrapeThreads(...args); }
export async function scrapePinterest(...args) { return (await loadCoreScrapers()).scrapePinterest(...args); }
export async function scrapeAppleMusic(...args) { return (await loadCoreScrapers()).scrapeAppleMusic(...args); }
export async function scrapeFacebook(url, ...args) {
  if (!window.Capacitor?.isNativePlatform?.()) {
    // First use the server-side resolver, then retry with Mori's bundled parser.
    // Both paths now share the same allowlisted relay for provider requests.
    const primary = await scrapeFacebookWeb(url);
    if (primary?.status) return primary;
    try {
      const fallback = await (await loadCoreScrapers()).scrapeFacebook(url, ...args);
      if (fallback?.status) return fallback;
      return {
        status: false,
        message: [
          primary?.message ? "Server resolver: " + primary.message : "",
          fallback?.message ? "Fallback resolver: " + fallback.message : "",
        ].filter(Boolean).join(" | ") || "Could not analyze this Facebook link.",
      };
    } catch (error) {
      return {
        status: false,
        message: [
          primary?.message ? "Server resolver: " + primary.message : "",
          "Fallback resolver: " + (error?.message || "failed"),
        ].filter(Boolean).join(" | "),
      };
    }
  }
  return (await loadCoreScrapers()).scrapeFacebook(url, ...args);
}
export async function scrapeBandcamp(...args) { return (await loadCoreScrapers()).scrapeBandcamp(...args); }
export async function scrapeReddit(...args) { return (await loadCoreScrapers()).scrapeReddit(...args); }
export async function scrapeTeraBox(...args) { return (await loadCoreScrapers()).scrapeTeraBox(...args); }
