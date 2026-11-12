// facebook.js — browser-only Facebook resolver adapter for Vercel
// The serverless endpoint contacts SnapSave; media files are still downloaded
// directly from the provider to the user's browser/device.
export async function scrapeFacebookWeb(url) {
  try {
    const response = await fetch("/api/facebook", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ url }),
      cache: "no-store",
    });

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("The Facebook resolver returned an invalid response.");
    }

    if (!response.ok || !payload?.status || !payload?.result) {
      throw new Error(
        payload?.message || "Could not analyze this Facebook link. Please try again.",
      );
    }

    if (!Array.isArray(payload.result.downloads) || payload.result.downloads.length === 0) {
      throw new Error("No downloadable Facebook qualities were found.");
    }

    return payload;
  } catch (error) {
    return {
      status: false,
      message: error?.message || "Facebook analysis failed. Check your connection and try again.",
    };
  }
}
