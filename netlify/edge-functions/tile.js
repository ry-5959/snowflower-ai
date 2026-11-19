/* 눈의꽃 AI — 국토교통부 브이월드 항공사진·지명 타일 전달
   키는 Netlify 환경변수 VWORLD_KEY 에만 있다(화면 소스·저장소에는 없음). 타일은 저장하지 않고 그대로 전달만 한다. */
const env = (k) => {
  try { if (globalThis.Netlify && Netlify.env && Netlify.env.get(k)) return Netlify.env.get(k); } catch (e) {}
  return "";
};
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const VW = "https://api.vworld.kr/req/wmts/1.0.0/";

async function getTile(key, layer, z, y, x, origin) {
  const ext = layer === "Satellite" ? "jpeg" : "png";
  const r = await fetch(VW + key + "/" + layer + "/" + z + "/" + y + "/" + x + "." + ext, { headers: { referer: origin + "/" } });
  const ct = r.headers.get("content-type") || "";
  return { r, ok: r.ok && /^image\//.test(ct), ct };
}

export default async (request) => {
  try {
    const url = new URL(request.url);
    const key = env("VWORLD_KEY");
    if (url.pathname === "/api/tile/ping") {
      if (!key) return json({ ok: true, key: false });
      const t = await getTile(key, "Satellite", 8, 99, 219, url.origin); // 강원 영서 한 장으로 키가 통하는지 확인
      return json({ ok: true, key: true, tile: t.ok, status: t.r.status });
    }
    const m = url.pathname.match(/^\/api\/tile\/(Satellite|Hybrid)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/);
    if (!m) return new Response("bad request", { status: 400 });
    const ref = request.headers.get("referer");
    if (ref) { try { if (new URL(ref).host !== url.host) return new Response("forbidden", { status: 403 }); } catch (e) { return new Response("forbidden", { status: 403 }); } }
    if (!key) return new Response("no key", { status: 404 });
    const z = parseInt(m[2], 10); if (z < 6 || z > 19) return new Response("zoom", { status: 404 });
    const t = await getTile(key, m[1], m[2], m[3], m[4], url.origin);
    if (!t.ok) return new Response("tile " + t.r.status, { status: t.r.status === 404 ? 404 : 502 });
    return new Response(t.r.body, { status: 200, headers: { "content-type": t.ct, "cache-control": "private, max-age=86400" } });
  } catch (e) { return new Response("error", { status: 502 }); }
};
export const config = { path: "/api/tile/*" };
