// Hex Earth Worker — static host + thin proxy.
// All heavy compute runs client-side (browser). This Worker only forwards
// requests to NASA GIBS (satellite + world map) and AWS Terrarium (elevation)
// so the browser can read them same-origin (no CORS / canvas tainting).
// Rivers ship as a static asset (/rivers.geojson, Natural Earth 50m).

const GIBS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
const WORLD_URL =
  GIBS + "?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=BlueMarble_NextGeneration" +
  "&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=2048&HEIGHT=1024&FORMAT=image/jpeg";
const DEM_URL = (z: string, x: string, y: string) =>
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    const q = url.searchParams;

    try {
      if (p === "/proxy/world") {
        return fetch(WORLD_URL);
      }
      if (p === "/proxy/satellite") {
        const bbox = `${q.get("latmin")},${q.get("lonmin")},${q.get("latmax")},${q.get("lonmax")}`;
        const u = `${GIBS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=BlueMarble_NextGeneration` +
          `&CRS=EPSG:4326&BBOX=${bbox}&WIDTH=${q.get("w")}&HEIGHT=${q.get("h")}&FORMAT=image/jpeg`;
        return fetch(u);
      }
      if (p === "/proxy/dem") {
        return fetch(DEM_URL(q.get("z")!, q.get("x")!, q.get("y")!));
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return new Response("Proxy error: " + String(e), { status: 502 });
    }
  },
};
