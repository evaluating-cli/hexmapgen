// Hex Earth Worker — static host + proxy.
// All heavy compute runs client-side (browser). This Worker only forwards
// requests to NASA GIBS (satellite + world map) and AWS Terrarium (elevation)
// so the browser can read them same-origin (no CORS / canvas tainting).
// Rivers ship as a static asset (/rivers.geojson, Natural Earth 50m).

const GIBS_ENDPOINT = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
const WORLD_URL =
  GIBS_ENDPOINT + "?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=BlueMarble_NextGeneration" +
  "&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=2048&HEIGHT=1024&FORMAT=image/jpeg";
const DEM_URL = (z: number, x: number, y: number) =>
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;

// Imagery and tiles are static geodata: cache them hard at the edge and in the
// browser. Upstream GIBS sends "no-store", which used to disable every cache.
const CACHE_SECONDS = 604800; // 7 days
const MIN_SATELLITE_DIM = 64;
const MAX_SATELLITE_DIM = 2048;
const MAX_DEM_ZOOM = 15;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const badRequest = (message: string) => json(400, { error: message });

function num(q: URLSearchParams, name: string): number | null {
  const raw = q.get(name);
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function int(q: URLSearchParams, name: string): number | null {
  const value = num(q, name);
  return value !== null && Number.isInteger(value) ? value : null;
}

async function proxy(target: string, method: string): Promise<Response> {
  let upstream: Response;
  try {
    // Always fetch with GET: WMS answers HEAD with an HTML page, which would
    // return the wrong content-type. HEAD is satisfied by dropping the body.
    upstream = await fetch(target, {
      cf: { cacheEverything: true, cacheTtl: CACHE_SECONDS },
    });
  } catch (error) {
    return json(502, { error: `upstream fetch failed: ${String(error)}` });
  }
  if (!upstream.ok) {
    return json(502, { error: `upstream responded ${upstream.status}` });
  }
  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") ?? "application/octet-stream");
  headers.set("cache-control", `public, max-age=${CACHE_SECONDS}, immutable`);
  // surface what the edge did — useful when debugging missing cache hits
  const cfCache = upstream.headers.get("cf-cache-status");
  if (cfCache) headers.set("x-hexearth-cache", cfCache);
  const body = method === "HEAD" ? null : upstream.body;
  return new Response(body, { status: 200, headers });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    const q = url.searchParams;

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json(405, { error: "method not allowed" });
    }
    const method = request.method;

    if (p === "/proxy/world") {
      return proxy(WORLD_URL, method);
    }

    if (p === "/proxy/satellite") {
      const latmin = num(q, "latmin");
      const latmax = num(q, "latmax");
      const lonmin = num(q, "lonmin");
      const lonmax = num(q, "lonmax");
      const w = int(q, "w");
      const h = int(q, "h");
      if (latmin === null || latmax === null || lonmin === null || lonmax === null) {
        return badRequest("latmin, latmax, lonmin and lonmax are required numbers");
      }
      if (latmin < -90 || latmax > 90 || latmin >= latmax) {
        return badRequest("latitudes must satisfy -90 <= latmin < latmax <= 90");
      }
      if (lonmin < -180 || lonmax > 180 || lonmin >= lonmax) {
        return badRequest("longitudes must satisfy -180 <= lonmin < lonmax <= 180");
      }
      if (w === null || h === null) {
        return badRequest("w and h are required integers");
      }
      if (w < MIN_SATELLITE_DIM || h < MIN_SATELLITE_DIM ||
          w > MAX_SATELLITE_DIM || h > MAX_SATELLITE_DIM) {
        return badRequest(
          `w and h must be between ${MIN_SATELLITE_DIM} and ${MAX_SATELLITE_DIM}`);
      }
      const bbox = `${latmin},${lonmin},${latmax},${lonmax}`;
      const target = `${GIBS_ENDPOINT}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0` +
        `&LAYERS=BlueMarble_NextGeneration&CRS=EPSG:4326&BBOX=${bbox}` +
        `&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/jpeg`;
      return proxy(target, method);
    }

    if (p === "/proxy/dem") {
      const z = int(q, "z");
      const x = int(q, "x");
      const y = int(q, "y");
      if (z === null || x === null || y === null) {
        return badRequest("z, x and y are required integers");
      }
      if (z < 0 || z > MAX_DEM_ZOOM) {
        return badRequest(`z must be between 0 and ${MAX_DEM_ZOOM}`);
      }
      const last = 2 ** z - 1;
      if (x < 0 || x > last || y < 0 || y > last) {
        return badRequest(`x and y must be between 0 and ${last} at zoom ${z}`);
      }
      return proxy(DEM_URL(z, x, y), method);
    }

    if (p.startsWith("/proxy/")) {
      return json(404, { error: `unknown proxy route ${p}` });
    }

    return new Response("Not found", { status: 404 });
  },
};
