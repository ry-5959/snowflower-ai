/* 눈의꽃 AI — 기상청 단기예보 조회(공공데이터포털). 키는 Netlify 환경변수 KMA_SERVICE_KEY 에만 있음 */
const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=600" } });
const num = (s) => { const m = String(s == null ? "" : s).match(/[\d.]+/); return m ? parseFloat(m[0]) : 0; };

// 단기예보는 02·05·08·11·14·17·20·23시에 발표되고 약 10분 뒤부터 조회된다(한국 시간 기준).
function baseTime(now) {
  const k = new Date(now.getTime() + 9 * 3600e3 - 15 * 60e3);
  let h = k.getUTCHours(); const slots = [2, 5, 8, 11, 14, 17, 20, 23]; let d = new Date(k.getTime());
  let pick = null; for (const s of slots) if (h >= s) pick = s;
  if (pick === null) { d = new Date(k.getTime() - 24 * 3600e3); pick = 23; }
  const ymd = d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
  return { date: ymd, time: String(pick).padStart(2, "0") + "00" };
}

export default async (request) => {
  try {
    const key = process.env.KMA_SERVICE_KEY || "";
    if (!key) return json({ ok: false, reason: "nokey" });
    const u = new URL(request.url); const nx = parseInt(u.searchParams.get("nx"), 10), ny = parseInt(u.searchParams.get("ny"), 10);
    if (!(nx > 0 && nx < 200 && ny > 0 && ny < 200)) return json({ ok: false, reason: "grid" }, 400);
    const b = baseTime(new Date());
    const sk = /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
    const url = "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getVilageFcst?serviceKey=" + sk +
      "&pageNo=1&numOfRows=1000&dataType=JSON&base_date=" + b.date + "&base_time=" + b.time + "&nx=" + nx + "&ny=" + ny;
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { signal: ctl.signal }); clearTimeout(t);
    const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch (e) { return json({ ok: false, reason: "kma format" }); }
    const items = (((j.response || {}).body || {}).items || {}).item || [];
    if (!items.length) return json({ ok: false, reason: "kma " + (((j.response || {}).header || {}).resultMsg || "empty") });
    const days = {};
    for (const it of items) {
      const d = days[it.fcstDate] || (days[it.fcstDate] = { date: it.fcstDate, pcp: 0, sno: 0, tmin: null });
      if (it.category === "PCP") d.pcp += /없음/.test(it.fcstValue) ? 0 : num(it.fcstValue);
      else if (it.category === "SNO") d.sno += /없음/.test(it.fcstValue) ? 0 : num(it.fcstValue);
      else if (it.category === "TMP") { const v = parseFloat(it.fcstValue); if (!isNaN(v) && (d.tmin === null || v < d.tmin)) d.tmin = v; }
    }
    const out = Object.values(days).sort((a, c) => a.date.localeCompare(c.date)).slice(0, 4).map((d) => ({ date: d.date, pcp: Math.round(d.pcp * 10) / 10, sno: Math.round(d.sno * 10) / 10, tmin: d.tmin }));
    return json({ ok: true, base: b.date.slice(4, 6) + "." + b.date.slice(6) + " " + b.time.slice(0, 2) + "시", days: out });
  } catch (e) { return json({ ok: false, reason: "error" }); }
};
