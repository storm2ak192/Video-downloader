// Mori's same-origin scraper relay for browser builds.
// This is intentionally NOT an open proxy: only known public scraper/platform hosts
// are reachable, redirects are revalidated, and response bodies are size-limited.
const ALLOWED_HOSTS = [
  "tiktok.com","tikdownloader.io","tiktokio.com","snapsave.app","indown.net","savevid.net",
  "youtube.com","youtu.be","ytimg.com","ytmp3.gg","ytmp3.mobi","media.ytmp3.gg","convert1s.com","fastdl.to","ymcdn.org",
  "twitter.com","x.com","fxtwitter.com","vxtwitter.com","twittervideodownloader.com","savetwt.com",
  "spotify.com","spotidown.app","spotimate.app","aplmate.com",
  "pinterest.com","pin.it","pindown.io","instagram.com",
  "facebook.com","fb.watch",
  "xiaohongshu.com","xhslink.com","xhslink.cn","rednote.com",
  "threads.com","threads.net","threadster.app",
  "bilibili.com","bilibili.tv","b23.tv","bili.im",
  "douyin.com","iesdouyin.com","snssdk.com",
  "bandcamp.com","bandcampdownloader.app",
  "pixiv.net","pximg.net","pixiv.re","ugoira.com",
  "reddit.com","redd.it","rapidsave.com",
  "terabox.com","teraboxapp.com","1024tera.com","nephobox.com","4funbox.com",
  "mirrobox.com","momerybox.com","tibibox.com","sechno.com",
];

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 18000;

function isAllowedHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\\.$/, "");
  return ALLOWED_HOSTS.some((domain) => host === domain || host.endsWith("." + domain));
}

function validateTarget(value) {
  let target;
  try { target = new URL(value); } catch { throw new Error("Invalid scraper target URL."); }
  if (!["http:", "https:"].includes(target.protocol)) throw new Error("Only HTTP(S) scraper URLs are allowed.");
  if (target.username || target.password) throw new Error("Credentials in scraper URLs are not allowed.");
  if (target.port && !((target.protocol === "https:" && target.port === "443") || (target.protocol === "http:" && target.port === "80"))) {
    throw new Error("Custom scraper URL ports are not allowed.");
  }
  if (!isAllowedHost(target.hostname)) throw new Error("This scraper host is not in Mori's safe allowlist: " + target.hostname);
  return target;
}

function parseBody(body) {
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) return body;
  if (typeof body === "string") {
    try { return JSON.parse(body); } catch { return null; }
  }
  return null;
}

function copyRequestHeaders(input) {
  const allowed = new Set([
    "accept","accept-language","content-type","user-agent","referer","origin",
    "x-requested-with","x-csrf-token","x-csrftoken","x-xsrf-token","x-ig-app-id","cookie",
    "x-bili-mid","x-bili-aurora-eid","x-bili-aurora-exps","range",
  ]);
  const output = {};
  if (!input || typeof input !== "object") return output;
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key.toLowerCase()) && typeof value === "string" && value.length <= (key.toLowerCase() === "cookie" ? 8192 : 2048)) {
      output[key] = value;
    }
  }
  return output;
}

async function readLimited(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RESPONSE_BYTES) throw new Error("Scraper response is too large.");
    return buffer;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch {}
      throw new Error("Scraper response exceeded the 3 MB safety limit.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        return res.status(403).json({ error: "Cross-origin requests are not allowed." });
      }
    } catch {
      return res.status(403).json({ error: "Invalid request origin." });
    }
  }

  const payload = parseBody(req.body);
  if (!payload || typeof payload.url !== "string" || payload.url.length > 8192) {
    return res.status(400).json({ error: "A valid scraper URL is required." });
  }
  const method = String(payload.method || "GET").toUpperCase();
  if (!["GET","POST","HEAD"].includes(method)) {
    return res.status(405).json({ error: "This HTTP method is not available to scraper requests." });
  }
  const body = payload.body == null ? undefined : String(payload.body);
  if (body && Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    return res.status(413).json({ error: "Scraper request body is too large." });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let target = validateTarget(payload.url);
    const headers = copyRequestHeaders(payload.headers);
    let currentMethod = method;
    let currentBody = body;
    let response;

    for (let hop = 0; hop <= 5; hop++) {
      response = await fetch(target, {
        method: currentMethod,
        headers,
        body: currentBody,
        redirect: "manual",
        signal: controller.signal,
      });
      if (![301,302,303,307,308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location) break;
      if (hop === 5) throw new Error("Scraper redirect limit exceeded.");
      const previousHost = target.hostname;
      target = validateTarget(new URL(location, target).toString());
      if (target.hostname !== previousHost) {
        delete headers.Cookie;
        delete headers.cookie;
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === "POST")) {
        currentMethod = "GET";
        currentBody = undefined;
      }
    }

    const bytes = await readLimited(response);
    const headersOut = {};
    for (const name of ["content-type","content-length","content-disposition","location","set-cookie","cache-control","etag","last-modified"]) {
      const value = response.headers.get(name);
      if (value) headersOut[name] = value;
    }
    const binary = payload.responseType === "arraybuffer";
    return res.status(200).json({
      status: response.status,
      headers: headersOut,
      data: binary ? bytes.toString("base64") : bytes.toString("utf8"),
      encoding: binary ? "base64" : "utf8",
      url: response.url || target.toString(),
    });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "Scraper request timed out."
      : (error?.message || "Scraper relay failed.");
    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timer);
  }
}
