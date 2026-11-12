import { load } from "cheerio";

const SNAP_SAVE = "https://snapsave.app";

function decodeSnapSave(data) {
  try {
    const regex = /eval\(function\(h,u,n,t,e,r\)\{.*?\}\("(.*?)",(\d+),"(.*?)",(\d+),(\d+),(\d+)\)\)/;
    const match = String(data).match(regex);
    if (!match) return String(data);
    const h = match[1];
    const n = match[3];
    const t = Number(match[4]);
    const radix = Number(match[5]);
    const delimiter = n[radix];
    const parts = h.split(delimiter);
    let decoded = "";
    for (const part of parts) {
      if (!part) continue;
      let value = 0;
      for (let i = 0; i < part.length; i++) {
        value += n.indexOf(part[i]) * Math.pow(radix, part.length - 1 - i);
      }
      decoded += String.fromCharCode(value - t);
    }
    return decodeURIComponent(escape(decoded));
  } catch {
    return String(data);
  }
}

function resolveSnapSaveUrl(value) {
  if (!value) return "";
  let raw = String(value).trim().replace(/^["'\\]+|["'\\]+$/g, "");
  if (raw.startsWith("//")) return "https:" + raw;
  if (raw.startsWith("/")) return SNAP_SAVE + raw;
  if (!/^https?:\/\//i.test(raw) && raw.includes(".")) {
    try {
      const payload = raw.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const parsed = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
      if (parsed.video_url) return parsed.video_url;
      if (parsed.url) return parsed.url;
    } catch {}
  }
  return raw;
}

function cookieHeader(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => value.split(";")[0]).filter(Boolean).join("; ");
}

function isFacebookUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com", "fb.watch"].includes(host)
      || host.endsWith(".facebook.com");
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ status: false, message: "Method not allowed." });
  }

  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin) {
    try {
      if (new URL(origin).host !== host) {
        return res.status(403).json({ status: false, message: "Cross-origin requests are not allowed." });
      }
    } catch {
      return res.status(403).json({ status: false, message: "Invalid request origin." });
    }
  }

  const inputUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!isFacebookUrl(inputUrl)) {
    return res.status(400).json({ status: false, message: "Please provide a valid public Facebook video or Reel URL." });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const commonHeaders = {
      "User-Agent": "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Origin": SNAP_SAVE,
      "Referer": SNAP_SAVE + "/id",
    };

    const home = await fetch(SNAP_SAVE + "/id", {
      headers: commonHeaders,
      signal: controller.signal,
    });
    if (!home.ok) throw new Error("SnapSave could not be reached. Please try again later.");
    const cookies = cookieHeader(home.headers);

    const body = new URLSearchParams({ url: inputUrl }).toString();
    const action = await fetch(SNAP_SAVE + "/action.php?lang=id", {
      method: "POST",
      headers: {
        ...commonHeaders,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(cookies ? { Cookie: cookies } : {}),
      },
      body,
      signal: controller.signal,
    });
    if (!action.ok) throw new Error("Facebook resolver returned HTTP " + action.status + ".");
    const decoded = decodeSnapSave(await action.text());
    const $ = load(decoded);
    const downloads = [];
    const seen = new Set();

    const addDownload = (candidate, label, render = false) => {
      const finalUrl = resolveSnapSaveUrl(candidate);
      if (!finalUrl || !/^https?:\/\//i.test(finalUrl) || seen.has(finalUrl)) return;
      let parsed;
      try { parsed = new URL(finalUrl); } catch { return; }
      if (parsed.hostname === "snapsave.app" || parsed.hostname.endsWith(".snapsave.app")
          || parsed.hostname === "facebook.com" || parsed.hostname.endsWith(".facebook.com")) return;
      if (render || /get_progressApi|get_progress/i.test(String(candidate))) return;
      seen.add(finalUrl);
      const quality = String(label || "").replace(/\s+/g, " ").trim();
      downloads.push({
        type: "VIDEO",
        quality: quality || (/\b(\d{3,4}p)\b/i.exec(finalUrl)?.[1] || "Video"),
        url: finalUrl,
      });
    };

    $("table tbody tr").each((_, row) => {
      const tr = $(row);
      if (tr.hasClass("render")) return;
      const quality = tr.find("td.video-quality").first().text().trim()
        || tr.find("td").first().text().trim()
        || tr.attr("data-quality")
        || "Video";
      const link = tr.find("a.btn-download, a[href], button[onclick]").first();
      addDownload(link.attr("href") || link.attr("onclick") || link.attr("data-url"), quality);
    });

    $("select option").each((_, option) => {
      const value = $(option).attr("value");
      addDownload(value, $(option).text().trim() || "Video");
    });

    $(".download-items__btn a, a.abutton, a.btn-download, a[href*='download.php']").each((_, anchor) => {
      const a = $(anchor);
      addDownload(a.attr("href") || a.attr("onclick"), a.attr("title") || a.text().trim() || "Video");
    });

    if (!downloads.length) {
      throw new Error("No Facebook download qualities were returned. The post may be private, restricted, or temporarily unsupported.");
    }

    const preview = $(".video-preview img").first();
    let thumbnail = preview.attr("src") || preview.attr("data-src") || "";
    if (thumbnail.startsWith("/")) thumbnail = SNAP_SAVE + thumbnail;
    if (!thumbnail) thumbnail = $('meta[property="og:image"]').attr("content") || "";
    const titleText = $(".clearfix > h3, .clearfix > p, h3, h4, p.card-text").first().text().trim();
    const title = titleText && !/download|snapsave/i.test(titleText) ? titleText.slice(0, 120) : "Facebook Video";

    return res.status(200).json({
      status: true,
      result: { title, thumbnail, downloads, sourceUrl: inputUrl, type: "video" },
    });
  } catch (error) {
    const message = error?.name === "AbortError"
      ? "Facebook analysis timed out. Please try again."
      : (error?.message || "Could not analyze this Facebook link.");
    return res.status(502).json({ status: false, message });
  } finally {
    clearTimeout(timeout);
  }
}
