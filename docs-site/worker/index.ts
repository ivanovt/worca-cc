/**
 * worca-docs Worker — wraps the Workers Assets binding with HTTP Range
 * support for video files.
 *
 * Why this exists: Workers Assets serves static files but ignores the
 * Range header, returning the full body with HTTP 200 instead of a 206
 * partial response. Browsers can't seek a `<video>` element without 206
 * responses backed by Accept-Ranges, so timeline scrubbing on
 * docs.worca.dev/introduction/watch/ was broken end-to-end. This Worker
 * intercepts requests to /videos/*.mp4 (and other media), parses the
 * Range header, fetches the asset, slices it, and returns 206.
 *
 * Everything else — HTML, CSS, JS, fonts, images, the chapter posters
 * (which are small enough to never need range), and 404s — passes
 * through to env.ASSETS.fetch() unchanged.
 *
 * Memory note: the entire asset is loaded to compute the slice. That's
 * fine for the current 13–16 MB MP4s (well under Workers' 128 MB limit).
 * If videos ever exceed ~50 MB, switch to streaming via a TransformStream
 * or move to Cloudflare R2 / Cloudflare Stream.
 */

export interface Env {
  ASSETS: Fetcher;
}

/** File extensions that should support Range requests. */
const RANGE_EXTENSIONS = [".mp4", ".webm", ".m4v", ".mov"];

const isRangeEligible = (pathname: string): boolean =>
  RANGE_EXTENSIONS.some((ext) => pathname.toLowerCase().endsWith(ext));

interface ParsedRange {
  start: number;
  end: number;
}

/** Parse a single "bytes=START-END" range. Multi-range requests aren't
 *  needed for video playback and are rejected with null. */
const parseRange = (header: string, totalSize: number): ParsedRange | null => {
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;

  const startStr = m[1];
  const endStr = m[2];

  // "bytes=-N" — suffix range, last N bytes.
  if (startStr === "" && endStr !== "") {
    const suffix = parseInt(endStr, 10);
    if (Number.isNaN(suffix) || suffix <= 0) return null;
    const start = Math.max(0, totalSize - suffix);
    return { start, end: totalSize - 1 };
  }

  if (startStr === "") return null;
  const start = parseInt(startStr, 10);
  if (Number.isNaN(start) || start < 0 || start >= totalSize) return null;

  let end = endStr === "" ? totalSize - 1 : parseInt(endStr, 10);
  if (Number.isNaN(end)) return null;
  if (end >= totalSize) end = totalSize - 1;
  if (end < start) return null;

  return { start, end };
};

const handleRangeRequest = async (
  request: Request,
  env: Env,
): Promise<Response> => {
  // Re-fetch as a plain GET so the asset binding returns the full body.
  // (HEAD won't give us a body to slice.)
  const fullReq = new Request(request.url, { method: "GET" });
  const fullResp = await env.ASSETS.fetch(fullReq);

  if (!fullResp.ok || !fullResp.body) {
    // 404 / 5xx — let it pass through unmodified.
    return fullResp;
  }

  const body = await fullResp.arrayBuffer();
  const totalSize = body.byteLength;

  const rangeHeader = request.headers.get("Range") ?? "";
  const parsed = parseRange(rangeHeader, totalSize);

  if (!parsed) {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${totalSize}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  const { start, end } = parsed;
  const slice = body.slice(start, end + 1);

  const headers = new Headers();
  // Preserve content-type and cache-control from the upstream response,
  // overwrite the parts that change for a 206.
  const passthrough = ["content-type", "cache-control", "etag", "last-modified"];
  for (const key of passthrough) {
    const value = fullResp.headers.get(key);
    if (value) headers.set(key, value);
  }
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
  headers.set("Content-Length", String(slice.byteLength));

  return new Response(slice, {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
};

/** For non-Range GET requests on range-eligible files, add the
 *  Accept-Ranges header so the browser knows it can issue Range requests
 *  next time without needing to re-detect support. */
const addAcceptRanges = (resp: Response): Response => {
  if (!resp.ok || resp.headers.has("Accept-Ranges")) return resp;
  const headers = new Headers(resp.headers);
  headers.set("Accept-Ranges", "bytes");
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Only modify behavior for GET on the video-asset paths. Everything
    // else (HTML, CSS, JS, fonts, images, 404) passes through.
    if (request.method === "GET" && isRangeEligible(url.pathname)) {
      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) {
        return handleRangeRequest(request, env);
      }
      const resp = await env.ASSETS.fetch(request);
      return addAcceptRanges(resp);
    }

    return env.ASSETS.fetch(request);
  },
};
