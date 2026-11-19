/* 눈의꽃 AI — Gemini 호출 (키는 Netlify 환경변수 GEMINI_API_KEY 에만 있음. 화면 소스·저장소에는 없음) */
const env = (k) => {
  try { if (globalThis.Netlify && Netlify.env && Netlify.env.get(k)) return Netlify.env.get(k); } catch (e) {}
  try { if (typeof process !== "undefined" && process.env && process.env[k]) return process.env[k]; } catch (e) {}
  return "";
};
const API = "https://generativelanguage.googleapis.com/v1beta/models";
const PREF = [/^gemini-3\.5-flash$/, /^gemini-3\.6-flash$/, /^gemini-3\.5-flash-lite$/, /^gemini-[\d.]+-flash-lite$/, /^gemini-[\d.]+-flash$/, /flash/];
const STATIC = ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-flash-latest"];
let MODELS = null, MODELS_AT = 0;

const SYSTEM = [
  "너는 강원 지자체 재난 담당 공무원을 돕는 '눈의꽃 AI' 상황 도우미다.",
  "규칙:",
  "1) [데이터]에 있는 지명과 수치만 쓴다. 없는 기관, 부서, 수치, 날짜, 지원 제도를 만들지 않는다.",
  "2) 위험 점수는 과거 대설과 견준 상대 순위(0~100)다. '무너진다'처럼 단정하지 말고 '위험이 높다', '과거 같은 등급에서 100번 중 N번꼴로 피해'처럼 쓴다.",
  "3) 눈 무게는 mm(㎡당 kg과 같음), 기온은 ℃, 시설 면적은 ha로 쓴다.",
  "4) 순서의 근거는 '피해 확률 × 시설 면적'이다. 값이 없는 항목은 없다고 밝힌다.",
  "5) 본문에서 장소는 id(R1 등)로 부르지 말고 '횡성군 둔내면'처럼 지명으로 부른다.",
  "6) [데이터]로 답할 수 없는 질문이면 places를 비우고, 답할 수 있는 범위와 예시 질문을 알려 준다.",
  "7) 지자체가 무엇을 해 주겠다는 약속 문구를 쓰지 않는다. 행동 안내는 순찰·점검, 눈 쓸어내리기, 받침대 보강, 대피 안내처럼 일반적인 것만 쓴다.",
  "8) 정확도나 한계를 물으면 [데이터]의 검증 수치와 한계를 그대로 말한다.",
  "9) 쉬운 한국어, 짧은 문장. 지정한 JSON 하나만 출력한다."
].join("\n");

const SCHEMA = {
  chat: '출력 JSON: {"answer":"5문장 이내 답","places":[{"id":"순서표의 id","why":"12자 안팎 이유"}],"follow_ups":["이 데이터로 답할 수 있는 다음 질문"]} places는 최대 3개, follow_ups는 최대 3개.',
  report: '출력 JSON: {"headline":"20자 안팎 결론","situation":"상황 2~3문장","basis":["순서의 근거 3~5개, 각 항목에 지명과 수치"],"actions":["권장 조치 3~5개"],"limits":["유의할 점 2~3개"]}',
  notice: '[데이터]의 선택한_읍면 주민에게 보낼 안내 문구를 쓴다. 출력 JSON: {"notice":"3문장 이내, 읍면 이름으로 시작, 위험 등급에 맞는 행동 안내"}'
};

async function listModels(key, fast) {
  if (!MODELS || Date.now() - MODELS_AT > 3600e3) {
    try {
      const r = await fetch(API + "?pageSize=200", { headers: { "x-goog-api-key": key } });
      if (!r.ok) throw new Error("models " + r.status);
      const j = await r.json();
      const names = (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => String(m.name).replace("models/", "")).filter((n) => /^gemini/.test(n) && !/(image|tts|audio|embedding|live|vision|robotics|computer)/.test(n));
      names.sort((a, b) => (/(preview|exp)/.test(a) ? 1 : 0) - (/(preview|exp)/.test(b) ? 1 : 0));
      const out = [];
      for (const re of PREF) for (const n of names) if (re.test(n) && !out.includes(n)) out.push(n);
      MODELS = out.length ? out : STATIC; MODELS_AT = Date.now();
    } catch (e) { MODELS = STATIC; MODELS_AT = Date.now() - 3300e3; }
  }
  const list = MODELS.slice();
  if (fast) list.sort((a, b) => (/lite/.test(a) ? 0 : 1) - (/lite/.test(b) ? 0 : 1));
  return list;
}

async function generate(model, user, key, ms, think) {
  const body = { systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: { temperature: 0.3, responseMimeType: "application/json", maxOutputTokens: 4096 } };
  if (think) body.generationConfig.thinkingConfig = { thinkingLevel: "low" };
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(API + "/" + model + ":generateContent", { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) { const e = new Error("gemini " + r.status); e.status = r.status; throw e; }
    const j = await r.json();
    const text = ((((j.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || "").join("").trim();
    if (!text) throw new Error("empty");
    return JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
  } finally { clearTimeout(t); }
}

const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function handle(request, opt) {
  const key = env("GEMINI_API_KEY");
  const url = new URL(request.url);
  if (request.method === "GET") return json({ ok: true, key: !!key, via: opt.name });
  if (request.method !== "POST") return json({ ok: false, reason: "method" }, 405);
  const origin = request.headers.get("origin");
  if (origin) { try { if (new URL(origin).host !== url.host) return json({ ok: false, reason: "origin" }, 403); } catch (e) { return json({ ok: false, reason: "origin" }, 403); } }
  if (!key) return json({ ok: false, reason: "nokey" });
  let b; try { b = await request.json(); } catch (e) { return json({ ok: false, reason: "body" }, 400); }
  const task = SCHEMA[b.task] ? b.task : null;
  if (!task) return json({ ok: false, reason: "task" }, 400);
  const ctx = JSON.stringify(b.ctx || {});
  if (ctx.length > 16000) return json({ ok: false, reason: "too long" }, 413);
  let user = "[데이터]\n" + ctx + "\n\n";
  if (task === "chat") {
    const hist = (Array.isArray(b.history) ? b.history : []).slice(-4).map((h) => "질문: " + String(h.q || "").slice(0, 200) + "\n답: " + String(h.a || "").slice(0, 400)).join("\n");
    if (hist) user += "[이전 대화]\n" + hist + "\n\n";
    user += "[질문]\n" + String(b.q || "").slice(0, 400) + "\n\n";
  } else if (task === "report") user += "[요청]\n위 순서표로 지자체 재난 담당자가 결재에 붙일 판단 근거 보고서를 쓴다.\n\n";
  user += SCHEMA[task];
  const t0 = Date.now(); const models = await listModels(key, opt.fast); let last = "fail";
  for (const m of models.slice(0, opt.tries)) {
    const left = opt.budget - (Date.now() - t0); if (left < 2500) break;
    const think = /^gemini-3/.test(m) && !/lite/.test(m);
    try { const data = await generate(m, user, key, Math.min(opt.per, left - 300), think); return json({ ok: true, model: m, ms: Date.now() - t0, data }); }
    catch (e) {
      last = String(e && e.message || e);
      if (think && e && e.status === 400) { try { const left2 = opt.budget - (Date.now() - t0); if (left2 > 2500) { const data = await generate(m, user, key, Math.min(opt.per, left2 - 300), false); return json({ ok: true, model: m, ms: Date.now() - t0, data }); } } catch (e2) { last = String(e2 && e2.message || e2); } }
    }
  }
  return json({ ok: false, reason: last, ms: Date.now() - t0 });
}

// Netlify Edge Function: 응답을 오래 기다릴 수 있어 주 경로로 쓴다.
export default async (request) => {
  try { return await handle(request, { name: "edge", fast: false, tries: 3, per: 16000, budget: 34000 }); }
  catch (e) { return json({ ok: false, reason: "error" }, 500); }
};
export const config = { path: "/api/ai" };
