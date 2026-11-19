/* 눈의꽃 AI — 대설 피해 예보와 점검 순서표
   2026.11.19~20 한림대 AI 활용 전국 대학생 창업 해커톤 현장 제작 (팀 한라 스마트 메이커즈)
   모델·수치는 data.js(실제 자료로 현장 계산)에서 읽고, 예보는 Open-Meteo에서 실시간으로 받는다. 예시 데이터 없음. */
(function () {
'use strict';
var D = window.DATA, M = D.model;
var GR = [
  { k: '낮음', c: '#8fb8d8', cls: 'g0' },
  { k: '보통', c: '#f0c330', cls: 'g1' },
  { k: '높음', c: '#ef7d2d', cls: 'g2' },
  { k: '매우 높음', c: '#d42f2f', cls: 'g3' }
];
var GN = { k: '강설 없음', c: '#c3ced9', cls: 'gn' };
var EMD = {}; D.emd.forEach(function (e) { EMD[e.id] = e; });
var $ = function (id) { return document.getElementById(id); };
var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
var fmt = function (v, d) { return v == null || isNaN(v) ? '–' : Number(v).toLocaleString('ko-KR', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); };
var eok = function (chun) { return chun / 100000; }; // 천 원 → 억 원
var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

var S = { mode: 'forecast', caseIdx: 0, rows: {}, sel: null, sort: 'expo', fc: null, fcAt: null, fcErr: null,
          base: 'sat', rot: !reduceMotion, aiPins: [], rankPins: [], newsPins: [], repPins: [], sggPins: [], hist: [], kma: {} };

/* ---------- 모델 ---------- */
function prob(P, tw) { var z = M.b0 + M.b1 * Math.log(Math.max(P, 0.5)) + M.b2 * tw; return 1 / (1 + Math.exp(-z)); }
function score(p) {
  var q = M.pq; if (p <= q[0]) return 0; if (p >= q[100]) return 100;
  var lo = 0, hi = 100; while (hi - lo > 1) { var m = (lo + hi) >> 1; if (q[m] <= p) lo = m; else hi = m; }
  var f = (p - q[lo]) / ((q[hi] - q[lo]) || 1); return Math.round((lo + f) * 10) / 10;
}
function gradeOf(s) { return s >= 95 ? 3 : s >= 80 ? 2 : s >= 50 ? 1 : 0; }
function rateOf(g) { var x = M.grades.filter(function (r) { return r.g === g; })[0]; return x ? x.rate : null; }

/* 학습 자료와 같은 규칙으로 예보에서 강설 사건을 뽑는다.
   강설일 = 10~5월, 일강수 0.5mm 이상, 일최저 1.5℃ 이하, 일평균 3.5℃ 이하. 하루 비는 것까지 같은 사건. */
function eventFromDaily(d) {
  var n = d.time.length, best = null, cur = null, gap = 0, days = [], maxSnow = 0;
  function close() { if (cur && (!best || cur.P > best.P)) best = cur; cur = null; gap = 0; }
  for (var i = 0; i < n; i++) {
    var pr = d.precipitation_sum[i], tn = d.temperature_2m_min[i], tm = d.temperature_2m_mean[i], sf = d.snowfall_sum ? d.snowfall_sum[i] : null;
    var mo = +d.time[i].slice(5, 7);
    var snow = pr != null && tn != null && tm != null && (mo >= 10 || mo <= 5) && pr >= 0.5 && tn <= 1.5 && tm <= 3.5;
    days.push({ t: d.time[i], pr: pr, sf: sf, tn: tn, tm: tm, snow: snow });
    if (sf != null && sf > maxSnow) maxSnow = sf;
    if (snow) { if (!cur) cur = { s: i, e: i, P: 0, wt: 0 }; cur.e = i; cur.P += pr; cur.wt += pr * tm; gap = 0; }
    else if (cur) { gap++; if (gap > 1) close(); }
  }
  close();
  var ev = best ? { P: Math.round(best.P * 10) / 10, tw: Math.round(best.wt / best.P * 100) / 100, s: d.time[best.s], e: d.time[best.e] } : null;
  return { ev: ev, days: days, maxSnow: maxSnow };
}

/* ---------- 예보 받기 (Open-Meteo, 키 없음) ---------- */
var FC_KEY = 'snowflower_fc_v1', FC_TTL = 30 * 60 * 1000;
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 불가 환경 */ } }

function fetchBatch(list, withElev) {
  var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + list.map(function (e) { return e.lat; }).join(',') +
    '&longitude=' + list.map(function (e) { return e.lon; }).join(',') +
    (withElev ? '&elevation=' + list.map(function (e) { return e.ef; }).join(',') : '') +
    '&daily=precipitation_sum,snowfall_sum,temperature_2m_min,temperature_2m_mean&timezone=Asia%2FSeoul&forecast_days=4';
  return fetch(u).then(function (r) {
    if (!r.ok) { if (withElev && r.status === 400) return fetchBatch(list, false); throw new Error('예보 서버 응답 ' + r.status); }
    return r.json();
  }).then(function (j) { var a = Array.isArray(j) ? j : [j]; if (a.length !== list.length) throw new Error('예보 지점 수 불일치'); return a.map(function (x) { return x.daily; }); });
}
function loadForecast(force) {
  var c = lsGet(FC_KEY);
  if (!force && c && c.t && Date.now() - c.t < FC_TTL && c.d && c.d.length === D.emd.length) { S.fc = c.d; S.fcAt = c.t; S.fcErr = null; return Promise.resolve(); }
  var half = Math.ceil(D.emd.length / 2), a = D.emd.slice(0, half), b = D.emd.slice(half);
  return fetchBatch(a, true).then(function (ra) { return fetchBatch(b, true).then(function (rb) { return ra.concat(rb); }); })
    .then(function (all) { S.fc = all; S.fcAt = Date.now(); S.fcErr = null; lsSet(FC_KEY, { t: S.fcAt, d: all }); })
    .catch(function (e) {
      S.fcErr = String(e && e.message || e);
      if (c && c.d && c.d.length === D.emd.length) { S.fc = c.d; S.fcAt = c.t; } // 실패하면 직전에 받은 실제 예보를 쓰고 시각을 표시
    });
}

/* ---------- 위험 계산 ---------- */
function computeRows() {
  var rows = {};
  if (S.mode === 'forecast') {
    D.emd.forEach(function (e, i) {
      if (!S.fc) { rows[e.id] = { g: -1, score: 0, none: true }; return; }
      var r = eventFromDaily(S.fc[i]);
      if (!r.ev) { rows[e.id] = { g: -1, score: 0, P: 0, days: r.days, maxSnow: r.maxSnow }; return; }
      var p = prob(r.ev.P, r.ev.tw), sc = score(p);
      rows[e.id] = { P: r.ev.P, tw: r.ev.tw, p: p, score: sc, g: gradeOf(sc), days: r.days, maxSnow: r.maxSnow, s: r.ev.s, e: r.ev.e };
    });
  } else {
    var c = D.cases[S.caseIdx], by = {}; c.rows.forEach(function (r) { by[r.sgg] = r; });
    D.emd.forEach(function (e) {
      var r = by[e.sgg];
      if (!r || r.P == null || r.p == null) { rows[e.id] = { g: -1, score: 0, P: null, dmg: r ? r.dmg : 0 }; return; }
      var sc = score(r.p);
      rows[e.id] = { P: r.P, tw: r.tw, p: r.p, score: sc, g: gradeOf(sc), dmg: r.dmg, sggLevel: true };
    });
  }
  S.rows = rows;
}

/* 순서표의 줄: 읍·면은 하나씩, 시의 동 지역은 시별로 묶는다(팜맵 시설 통계가 법정동 기준이라 행정동과 맞지 않음) */
function units() {
  var out = [], dong = {};
  D.emd.forEach(function (e) {
    var r = S.rows[e.id]; if (!r) return;
    var last = e.nm.charAt(e.nm.length - 1);
    if (last === '읍' || last === '면') {
      out.push({ key: e.id, ids: [e.id], label: e.nm, sgg: e.sgg, p: r.p || 0, score: r.score, g: r.g, P: r.P, tw: r.tw,
                 fha: e.fha, fn: e.fn, pop: e.pop, o65: e.o65, mk: e.mk, lat: e.lat, lon: e.lon });
    } else {
      var d = dong[e.sgg];
      if (!d) { var f = D.dong[e.sgg] || {}; d = dong[e.sgg] = { key: 'dong-' + e.sgg, ids: [], label: '동 지역', sgg: e.sgg, p: 0, score: 0, g: -1, P: null, tw: null, fha: f.fha, fn: f.fn, pop: 0, o65: 0, mk: 0, lat: 0, lon: 0, isDong: true }; out.push(d); }
      d.ids.push(e.id); d.pop += e.pop || 0; d.o65 += e.o65 || 0; d.mk += e.mk || 0; d.lat += e.lat; d.lon += e.lon;
      if ((r.p || 0) >= d.p) { d.p = r.p || 0; d.score = r.score; d.g = r.g; d.P = r.P; d.tw = r.tw; }
    }
  });
  out.forEach(function (u) { if (u.isDong) { u.lat /= u.ids.length; u.lon /= u.ids.length; } u.idx = u.p * (u.fha || 0); });
  out.sort(S.sort === 'expo' ? function (a, b) { return b.idx - a.idx || b.score - a.score; } : function (a, b) { return b.score - a.score || b.idx - a.idx; });
  return out;
}
function unitOf(id) { var e = EMD[id]; var us = units(); for (var i = 0; i < us.length; i++) if (us[i].ids.indexOf(id) >= 0) return { u: us[i], rank: i + 1 }; return null; }

/* ---------- 지도 ---------- */
var SAT_RAW = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/';
var SAT = 'snowsat://tint/{z}/{y}/{x}', SAT_PLAIN = 'snowsat://plain/{z}/{y}/{x}';
/* 위성사진 보정: 숲은 짙게, 밝고 색이 옅은 곳(시가지·마을·도로·맨땅)은 따뜻한 흰색으로 띄운다.
   위성사진 밝기만으로 한 강조이고, 공식 토지피복 분류가 아니다. */
function enhance(d, tint) {
  for (var i = 0; i < d.length; i += 4) {
    var r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0;
    var u = tint ? Math.max(0, Math.min(1, (mx - 92) / 50)) * Math.max(0, Math.min(1, (0.30 - sat) / 0.14)) : 0;
    var l = (r + g + b) / 3; r = l + (r - l) * 1.35; g = l + (g - l) * 1.35; b = l + (b - l) * 1.35;
    r = (r - 70) * 1.32 + 70; g = (g - 70) * 1.32 + 70; b = (b - 70) * 1.32 + 70;
    if (u > 0) { var k = u * 0.9; r = r * (1 - k) + 255 * k; g = g * (1 - k) + 232 * k; b = b * (1 - k) + 170 * k; }
    d[i] = r < 0 ? 0 : r > 255 ? 255 : r; d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}
function satProtocol(params, ac) {
  var m = params.url.match(/^snowsat:\/\/(tint|plain)\/(\d+)\/(\d+)\/(\d+)/);
  if (!m) return Promise.reject(new Error('위성사진 주소 오류'));
  return fetch(SAT_RAW + m[2] + '/' + m[3] + '/' + m[4] + '.jpg', { signal: ac && ac.signal })
    .then(function (r) { if (!r.ok) throw new Error('위성사진 서버 응답 ' + r.status); return r.blob(); })
    .then(function (bl) { return createImageBitmap(bl); })
    .then(function (bm) {
      try {
        var c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bm.width, bm.height) : document.createElement('canvas');
        c.width = bm.width; c.height = bm.height;
        var g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0);
        var id = g.getImageData(0, 0, bm.width, bm.height); enhance(id.data, m[1] === 'tint'); g.putImageData(id, 0, 0);
        return createImageBitmap(c).then(function (o) { return { data: o }; });
      } catch (e) { return { data: bm }; } // 보정에 실패하면 원본 그대로
    });
}
var DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
var RAMP = ['#2f6b4f', '#5a8f5a', '#a7b96b', '#d9c77a', '#c9a063', '#a9775a', '#8d6a6a', '#b9b0b8', '#ffffff'], EXAG = [1.8, 3.2];
var map, ready = false, satOk = false, satErr = 0, demOk = false, demErr = 0, flat = false;

function PAD() { return window.innerWidth > 900 ? { left: 400, top: 50, right: 10, bottom: 30 } : { left: 0, top: 0, right: 0, bottom: 0 }; }
function circlePoly(lon, lat, rM) {
  var pts = [], n = 20, dLat = rM / 111320, dLon = rM / (111320 * Math.cos(lat * Math.PI / 180));
  for (var i = 0; i <= n; i++) { var a = 2 * Math.PI * i / n; pts.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]); }
  return [pts];
}
function initMap() {
  maplibregl.addProtocol('snowsat', satProtocol);
  map = new maplibregl.Map({
    container: 'map', center: [128.35, 37.72], zoom: 8.05, pitch: 60, bearing: -14, padding: PAD(), maxPitch: 78, minZoom: 6.5, maxZoom: 13.5,
    maxBounds: [[125.6, 35.9], [131.2, 39.6]], attributionControl: { compact: true },
    style: {
      version: 8,
      sources: {
        sat: { type: 'raster', tiles: [SAT], tileSize: 256, maxzoom: 14, attribution: '위성사진 <a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX (Copernicus Sentinel 2016 자료 가공, CC BY 4.0)' },
        dem: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 12, encoding: 'terrarium', attribution: '지형 AWS Terrain Tiles(Mapzen)' },
        dem2: { type: 'raster-dem', tiles: [DEM], tileSize: 256, maxzoom: 12, encoding: 'terrarium' }
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#22303f' } },
        { id: 'sat', type: 'raster', source: 'sat' },
        { id: 'relief', type: 'color-relief', source: 'dem2', layout: { visibility: 'none' }, paint: { 'color-relief-opacity': 0.72,
          'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, RAMP[0], 100, RAMP[1], 300, RAMP[2], 500, RAMP[3], 700, RAMP[4], 900, RAMP[5], 1100, RAMP[6], 1300, RAMP[7], 1500, RAMP[8]] } },
        { id: 'hill', type: 'hillshade', source: 'dem2', paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#0d1b2b', 'hillshade-highlight-color': '#ffffff' } }
      ],
      terrain: { source: 'dem', exaggeration: EXAG[0] },
      sky: { 'sky-color': '#7fa6cf', 'horizon-color': '#dbe6f0', 'fog-color': '#dbe6f0', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.75 }
    }
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.on('data', function (e) {
    if (e.sourceId === 'sat' && e.tile && e.dataType === 'source') satOk = true;
    if (e.sourceId === 'dem' && e.tile && e.dataType === 'source') demOk = true;
  });
  map.on('error', function (e) {
    if (e && e.sourceId === 'sat' && !satOk) { satErr++; if (satErr === 4) reliefOn(true); } // 위성사진이 안 오면 고도 색으로 바탕을 채운다
    // 지형 서버에 연결되지 않으면 평면 지도로 바꿔서 위험 지도는 계속 보이게 한다
    if (e && (e.sourceId === 'dem' || e.sourceId === 'dem2') && !demOk) { demErr++; if (demErr >= 4 && !flat) { flat = true; try { map.setTerrain(null); if (map.getLayer('hill')) map.removeLayer('hill'); } catch (x) {} } }
  });
  map.on('load', function () {
    map.addSource('emd', { type: 'geojson', data: D.geo });
    map.addSource('cols', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource('mk', { type: 'geojson', data: { type: 'FeatureCollection', features: D.markets.map(function (m) { return { type: 'Feature', properties: { nm: m.nm, n: m.n }, geometry: { type: 'Point', coordinates: [m.lon, m.lat] } }; }) } });
    map.addLayer({ id: 'emd-fill', type: 'fill', source: 'emd', paint: {
      'fill-color': ['match', ['get', 'g'], 0, GR[0].c, 1, GR[1].c, 2, GR[2].c, 3, GR[3].c, GN.c],
      'fill-opacity': ['match', ['get', 'g'], -1, 0.16, 0, 0.36, 1, 0.56, 2, 0.66, 3, 0.74, 0.16] } });
    map.addLayer({ id: 'emd-line', type: 'line', source: 'emd', paint: { 'line-color': '#ffffff', 'line-opacity': 0.42, 'line-width': 0.7 } });
    map.addLayer({ id: 'sel-line', type: 'line', source: 'emd', filter: ['==', ['get', 'id'], ''], paint: { 'line-color': '#ffffff', 'line-width': 3.2 } });
    map.addLayer({ id: 'cols', type: 'fill-extrusion', source: 'cols', paint: {
      'fill-extrusion-color': ['match', ['get', 'g'], 1, GR[1].c, 2, GR[2].c, 3, GR[3].c, GR[0].c],
      'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': 0.9 } });
    map.addLayer({ id: 'mk', type: 'circle', source: 'mk', layout: { visibility: 'none' }, paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': '#14263b', 'circle-stroke-width': 2 } });
    map.on('click', 'emd-fill', function (e) { if (e.features && e.features[0]) select(e.features[0].properties.id, false, true); });
    map.on('mouseenter', 'emd-fill', function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'emd-fill', function () { map.getCanvas().style.cursor = ''; });
    map.on('click', 'mk', function (e) { var f = e.features[0]; new maplibregl.Popup().setLngLat(f.geometry.coordinates).setHTML('<b>' + esc(f.properties.nm) + '</b><br>전통시장' + (f.properties.n ? ' · 점포 ' + f.properties.n + '곳' : '') + '<br><span style="color:#6b7c8f">적설 취약 구조물 점검 대상 후보</span>').addTo(map); });
    map.on('mousemove', showElev); map.on('click', showElev);
    sggLabels();
    ready = true; paint();
    startIdle(); tryVworld();
  });
}
var DEMZ = 11, demCache = {}, demOrder = [];
function demTile(z, x, y) {
  var k = z + '/' + x + '/' + y; if (demCache[k]) return demCache[k];
  var p = new Promise(function (res) {
    var img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = function () { try { var c = document.createElement('canvas'); c.width = c.height = 256; var g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0); res(g.getImageData(0, 0, 256, 256).data); } catch (e) { res(null); } };
    img.onerror = function () { res(null); };
    img.src = DEM.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  });
  demCache[k] = p; demOrder.push(k); if (demOrder.length > 48) delete demCache[demOrder.shift()];
  return p;
}
function elevAt(lon, lat) {
  var n = Math.pow(2, DEMZ), xf = (lon + 180) / 360 * n, sn = Math.sin(lat * Math.PI / 180), yf = (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * n;
  var x = Math.floor(xf), y = Math.floor(yf), px = Math.min(255, Math.floor((xf - x) * 256)), py = Math.min(255, Math.floor((yf - y) * 256));
  return demTile(DEMZ, x, y).then(function (d) { if (!d) return null; var i = (py * 256 + px) * 4; return d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768; });
}
var elevT = 0, elevSeq = 0;
function showElev(e) {
  var now = Date.now(); if (now - elevT < 70) return; elevT = now; var seq = ++elevSeq, ll = e.lngLat;
  var f = map.queryRenderedFeatures(e.point, { layers: ['emd-fill'] })[0], em = f ? EMD[f.properties.id] : null;
  if (!em) { $('elev').hidden = true; return; }
  elevAt(ll.lng, ll.lat).then(function (h) { if (seq !== elevSeq) return; $('elev').hidden = false; $('elev').innerHTML = '<b class="num">해발 ' + (h == null ? '–' : fmt(Math.max(0, h))) + ' m</b> ' + esc(em.sgg + ' ' + em.nm); });
}
/* 국토교통부 브이월드 항공사진 + 도로·지명. 배포된 사이트에서 키가 설정돼 있을 때만 켜진다. */
function tryVworld() {
  fetch('/api/tile/ping').then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
    if (!j || !j.key || !j.tile || !ready) return;
    S.vw = true;
    var att = '항공사진·지명 <a href="https://www.vworld.kr" target="_blank" rel="noopener">국토교통부 브이월드</a>';
    map.addSource('vsat', { type: 'raster', tiles: [location.origin + '/api/tile/Satellite/{z}/{y}/{x}'], tileSize: 256, minzoom: 6, maxzoom: 19, attribution: att });
    map.addSource('vhyb', { type: 'raster', tiles: [location.origin + '/api/tile/Hybrid/{z}/{y}/{x}'], tileSize: 256, minzoom: 6, maxzoom: 19 });
    map.addLayer({ id: 'vsat', type: 'raster', source: 'vsat' }, 'relief');
    map.addLayer({ id: 'vhyb', type: 'raster', source: 'vhyb' }, 'cols');
    map.getSource('sat').setTiles([SAT_PLAIN]);   // 바다·경계 밖 바탕용
    map.setMaxZoom(17.6);
    $('baseBtn').textContent = '도로·지명'; $('baseBtn').setAttribute('aria-pressed', true);
    $('lgCity').innerHTML = '항공사진·도로·지명: 국토교통부 브이월드'; $('lgCity').hidden = false;
  }).catch(function () { /* 로컬 파일이거나 키가 없으면 기존 위성사진 그대로 */ });
}
function reliefOn(on) {
  $('relBtn').setAttribute('aria-pressed', on); $('lgElev').hidden = !on;
  if (map && map.getLayer('relief')) map.setLayoutProperty('relief', 'visibility', on ? 'visible' : 'none');
}
function setTint(on) {
  if (S.vw) { $('baseBtn').setAttribute('aria-pressed', on); map.setLayoutProperty('vhyb', 'visibility', on ? 'visible' : 'none'); return; }
  S.tint = on; $('baseBtn').setAttribute('aria-pressed', on); $('lgCity').hidden = !on;
  if (map && map.getSource('sat')) map.getSource('sat').setTiles([on ? SAT : SAT_PLAIN]);
}
function sggLabels() {
  var acc = {}; D.emd.forEach(function (e) { var a = acc[e.sgg] || (acc[e.sgg] = { la: 0, lo: 0, w: 0 }); a.la += e.lat * e.km2; a.lo += e.lon * e.km2; a.w += e.km2; });
  Object.keys(acc).forEach(function (k) {
    var el = document.createElement('div'); el.className = 'sggl'; el.textContent = k;
    S.sggPins.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([acc[k].lo / acc[k].w, acc[k].la / acc[k].w]).addTo(map));
  });
}
function clearPins(arr) { arr.forEach(function (m) { m.remove(); }); arr.length = 0; }

function paint() {
  if (!ready) return;
  D.geo.features.forEach(function (f) { var r = S.rows[f.properties.id] || { g: -1, score: 0 }; f.properties.g = r.g; f.properties.score = r.score; });
  map.getSource('emd').setData(D.geo);
  var cols = [];
  D.emd.forEach(function (e) {
    var r = S.rows[e.id]; if (!r || r.g < 1) return;
    cols.push({ type: 'Feature', properties: { g: r.g, h: Math.round((r.score - 42) * 140) }, geometry: { type: 'Polygon', coordinates: circlePoly(e.lon, e.lat, 1150) } });
  });
  map.getSource('cols').setData({ type: 'FeatureCollection', features: cols });
  // 순위 이름표(상위 8곳)
  clearPins(S.rankPins);
  units().filter(function (u) { return u.g >= 1 && u.idx > 0; }).slice(0, 8).forEach(function (u, i) {
    var el = document.createElement('div'); el.className = 'pin ' + GR[u.g].cls; el.innerHTML = '<i>' + (i + 1) + '</i>' + esc(u.isDong ? u.sgg + ' 동 지역' : u.label);
    el.addEventListener('click', function (ev) { ev.stopPropagation(); select(u.ids[0], true, true); });
    S.rankPins.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat([u.lon, u.lat]).addTo(map));
  });
  // 과거 재현: 읍면 단위 피해 보도 표시
  clearPins(S.newsPins);
  if (S.mode === 'past') {
    var per = D.cases[S.caseIdx].period, tag = per.indexOf('2024.11') === 0 ? '2024.11' : per.indexOf('2024.02') === 0 ? '2024.2' : null;
    if (tag) D.news.filter(function (n) { return n.id && n.ev.indexOf(tag) === 0; }).forEach(function (n) {
      var e = EMD[n.id], el = document.createElement('div'); el.className = 'npin'; el.title = n.sgg + ' ' + n.emd + ' 피해 보도';
      el.addEventListener('click', function (ev) { ev.stopPropagation(); select(n.id, false, true); });
      S.newsPins.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([e.lon + (Math.random() - 0.5) * 0.02, e.lat + 0.012]).addTo(map));
    });
  }
  paintReports();
}

/* 대기 중 자동 회전 */
var lastAct = Date.now(), spinning = false;
function startIdle() {
  ['mousedown', 'touchstart', 'wheel', 'keydown'].forEach(function (ev) { document.addEventListener(ev, function () { lastAct = Date.now(); }, { passive: true }); });
  function tick() {
    if (S.rot && !document.hidden && Date.now() - lastAct > 12000 && !map.isMoving()) { spinning = true; map.setBearing(map.getBearing() + 0.035); }
    else if (S.rot && spinning && Date.now() - lastAct > 12000) { map.setBearing(map.getBearing() + 0.035); }
    else spinning = false;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}
function flyTo(lon, lat, z) { lastAct = Date.now(); if (map) map.flyTo({ center: [lon, lat], zoom: z || 10.4, pitch: 62, speed: 0.9, essential: true, padding: PAD() }); }

/* ---------- 화면: 상황 줄 ---------- */
function hm(t) { var d = new Date(t); return (d.getMonth() + 1) + '.' + d.getDate() + ' ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
function renderScen() {
  var h = '';
  if (S.mode === 'forecast') {
    if (!S.fc) h = S.fcErr ? '<span class="warn">예보를 받지 못했습니다 (' + esc(S.fcErr) + ').</span> <button class="btn sm line" id="retry">다시 받기</button>' : '실제 예보를 받는 중<span class="dots"></span>';
    else {
      var d0 = S.fc[0].time[0].slice(5).replace('-', '.'), d1 = S.fc[0].time[S.fc[0].time.length - 1].slice(5).replace('-', '.');
      var n = D.emd.filter(function (e) { return S.rows[e.id] && S.rows[e.id].g >= 1; }).length;
      h = '<b>' + d0 + '~' + d1 + ' 예보</b> · 받은 시각 ' + hm(S.fcAt) + ' · 위험 보통 이상 <b>' + n + '곳</b>' +
        (S.fcErr ? '<br><span class="warn">새 예보를 받지 못해 ' + hm(S.fcAt) + '에 받은 예보를 보여 줍니다.</span>' : '') +
        ' <button class="btn sm line" id="retry">새로 받기</button>';
    }
  } else {
    var c = D.cases[S.caseIdx];
    h = '<b>' + esc(c.period.replace('~', ' ~ ')) + ' 대설 재현</b> · 시군 관측값 · 그 겨울을 빼고 학습한 모델로 계산 · 실제 피해 ' + fmt(eok(c.tot), 1) + '억 원';
  }
  $('scen').innerHTML = h;
  var rb = $("retry"); if (rb) rb.onclick = function () { refresh(true); };
}

/* ---------- 화면: 점검 순서표 ---------- */
function renderRank() {
  var us = units(), act = us.filter(function (u) { return u.g >= 0 && (S.sort === 'expo' ? u.idx > 0 : u.score > 0); });
  var h = '<h2>어디부터 점검할까</h2><p class="hint">순서는 <b>피해 확률 × 시설 면적</b>입니다. 위험이 같으면 시설이 많은 곳이 먼저입니다.</p>' +
    '<div class="row"><span class="seg" role="group" aria-label="정렬"><button data-sort="expo" aria-pressed="' + (S.sort === 'expo') + '">시설 반영</button><button data-sort="score" aria-pressed="' + (S.sort === 'score') + '">위험 점수만</button></span>' +
    '<button class="btn sm" id="repBtn"' + (act.length ? '' : ' disabled') + '>판단 근거 보고서</button></div>';
  if (S.mode === 'forecast' && !S.fc) h += '<div class="empty"><b>예보를 기다리는 중</b>실제 예보가 도착하면 순서가 채워집니다.</div>';
  else if (!act.length) h += '<div class="empty"><b>앞으로 3일, 강설 위험 없음</b>강원 188개 읍면동 모두 피해 위험이 낮습니다.<br><br><button class="btn" id="goPast">과거 대설로 작동 확인</button></div>';
  else {
    var maxIdx = Math.max.apply(null, act.map(function (u) { return S.sort === 'expo' ? u.idx : u.score; })) || 1;
    h += '<ol id="rank">' + act.slice(0, 12).map(function (u) {
      var g = u.g < 0 ? GN : GR[u.g], w = Math.max(4, (S.sort === 'expo' ? u.idx : u.score) / maxIdx * 100);
      var old = u.pop ? Math.round(u.o65 / u.pop * 100) : null;
      return '<li data-id="' + u.ids[0] + '"' + (S.sel && u.ids.indexOf(S.sel) >= 0 ? ' class="on"' : '') + '><div><div class="nm">' + esc(u.isDong ? u.sgg + ' 동 지역' : u.label) + (u.isDong ? '' : '<small>' + esc(u.sgg) + '</small>') + '</div>' +
        '<div class="meta num">시설 ' + fmt(u.fha, 0) + 'ha · 눈 무게 ' + fmt(u.P, 1) + 'mm' + (old != null ? ' · 65세 이상 ' + old + '%' : '') + '</div>' +
        '<div class="bar"><i style="width:' + w + '%;background:' + g.c + '"></i></div></div>' +
        '<div><span class="badge ' + g.cls + '">' + g.k + '</span><span class="sc num">' + fmt(u.score, 0) + '점</span></div></li>';
    }).join('') + '</ol>';
    if (act.length > 12) h += '<p class="hint">상위 12곳만 표시 (위험이 있는 곳 ' + act.length + '곳)</p>';
  }
  if (S.mode === 'past') h += pastResult();
  $('rankP').innerHTML = h;
  Array.prototype.forEach.call($('rankP').querySelectorAll('[data-sort]'), function (b) { b.onclick = function () { S.sort = b.getAttribute('data-sort'); renderRank(); paint(); }; });
  Array.prototype.forEach.call($('rankP').querySelectorAll('#rank li'), function (li) { li.onclick = function () { select(li.getAttribute('data-id'), true, true); }; });
  var rb = $('repBtn'); if (rb) rb.onclick = makeReport;
  var gp = $('goPast'); if (gp) gp.onclick = function () { setMode('past'); };
}
function pastResult() {
  var c = D.cases[S.caseIdx], rs = c.rows.filter(function (r) { return r.p != null; }).map(function (r) { var sc = score(r.p); return { sgg: r.sgg, sc: sc, g: gradeOf(sc), dmg: r.dmg, P: r.P }; }).sort(function (a, b) { return b.sc - a.sc; });
  var nd = c.rows.filter(function (r) { return r.dmg > 0; }).length, k = Math.min(nd, rs.length), hit = rs.slice(0, k).filter(function (r) { return r.dmg > 0; }).length;
  var h = '<h3>실제 결과와 견주기</h3><p>위험 점수 상위 ' + k + '개 시군 가운데 <b>' + hit + '곳</b>에서 실제 피해가 났습니다 (피해 시군 ' + nd + '곳).</p>' +
    '<table class="t num"><tr><th>시군</th><th>눈 무게</th><th>위험</th><th>실제 피해</th></tr>' +
    rs.map(function (r) { return '<tr><td>' + esc(r.sgg) + '</td><td>' + fmt(r.P, 1) + 'mm</td><td><span class="badge ' + GR[r.g].cls + '" style="min-width:0;padding:2px 6px">' + fmt(r.sc, 0) + '</span></td><td>' + (r.dmg > 0 ? '<b>' + fmt(eok(r.dmg), 1) + '억</b>' : '없음') + '</td></tr>'; }).join('') + '</table>' +
    '<p class="hint">피해액은 행정안전부 자연재난상황통계(대설, 시군 단위). 눈 5mm 미만 시군은 표에서 뺐습니다. 과거 재현은 시군 관측값이라 같은 시군의 읍면은 위험 점수가 같고, 순서는 시설 면적으로 갈립니다.</p>';
  return h;
}

/* ---------- 화면: 읍면 정보 ---------- */
function renderInfo() {
  var el = $('infoP');
  if (!S.sel) { el.innerHTML = '<div class="empty"><b>읍면을 골라 주세요</b>지도나 순서표에서 읍면을 누르면 위험 근거가 나옵니다.</div>'; return; }
  var e = EMD[S.sel], r = S.rows[S.sel] || { g: -1, score: 0 }, g = r.g < 0 ? GN : GR[r.g], uo = unitOf(S.sel);
  var rate = r.g >= 0 ? rateOf(r.g) : null, old = e.pop ? Math.round(e.o65 / e.pop * 100) : null;
  var isEm = /[읍면]$/.test(e.nm);
  var h = '<h2>' + esc(e.sgg + ' ' + e.nm) + '</h2>' +
    '<div class="big"><strong class="num">' + fmt(r.score, 0) + '</strong><span>점</span><span class="badge ' + g.cls + '">' + g.k + '</span>' + (uo && uo.u.idx > 0 ? '<span class="hint">순서표 ' + uo.rank + '번째</span>' : '') + '</div>';
  if (r.g >= 0) h += '<p>과거 같은 등급의 대설 100번 중 <b>' + fmt(rate, 0) + '번</b>꼴로 그 시군에 피해가 났습니다.</p>';
  else h += '<p>' + (S.mode === 'forecast' ? '앞으로 3일 동안 눈으로 볼 만한 강수 예보가 없습니다.' : '이 기간 이 시군의 눈은 5mm 미만이었습니다.') + '</p>';
  h += '<dl class="kv num">' +
    '<dt>눈 무게(강설일 강수량 합)</dt><dd>' + (r.P ? fmt(r.P, 1) + ' mm = ㎡당 ' + fmt(r.P, 0) + ' kg' : '–') + '</dd>' +
    '<dt>눈 올 때 평균기온</dt><dd>' + (r.tw != null && r.P ? fmt(r.tw, 1) + ' ℃' + (r.tw > -1 ? ' (젖은 눈)' : '') : '–') + '</dd>' +
    '<dt>시설 면적 (팜맵 2025)</dt><dd>' + (isEm ? fmt(e.fha, 1) + ' ha · ' + fmt(e.fn) + '필지' : e.sgg + ' 동 지역 합계 ' + fmt((D.dong[e.sgg] || {}).fha, 1) + ' ha') + '</dd>' +
    '<dt>인구 (2026.10)</dt><dd>' + fmt(e.pop) + '명' + (old != null ? ' · 65세 이상 ' + old + '%' : '') + '</dd>' +
    '<dt>전통시장</dt><dd>' + (e.mk ? e.mk + '곳' : '없음') + '</dd>' +
    '<dt>해발 고도</dt><dd>농경지 ' + fmt(e.ef) + 'm · 중심 ' + fmt(e.ec) + 'm</dd></dl>';
  if (S.mode === 'forecast' && r.days) {
    var reach = r.maxSnow >= 30;
    h += '<h3>기존 기준과 나란히</h3><div class="cmp num">' +
      '<div><span>기상청 대설 재난문자 붕괴 기준<br><span class="hint">강원 24시간 신적설 30cm (예보로 단순 대조)</span></span><b>' + fmt(r.maxSnow, 1) + ' cm · ' + (reach ? '도달' : '미달') + '</b></div>' +
      '<div class="ours"><span>눈의꽃 AI 피해 위험<br><span class="hint">21년 피해 기록으로 학습·검증</span></span><b>' + g.k + ' · ' + fmt(r.score, 0) + '점</b></div></div>' +
      '<h3>날짜별 예보 <span class="hint">Open-Meteo, 농경지 높이 보정</span></h3><table class="t num"><tr><th>날짜</th><th>강수</th><th>신적설</th><th>최저</th><th>평균</th></tr>' +
      r.days.map(function (d) { return '<tr><td>' + d.t.slice(5).replace('-', '.') + (d.snow ? ' ❄' : '') + '</td><td>' + fmt(d.pr, 1) + 'mm</td><td>' + fmt(d.sf, 1) + 'cm</td><td>' + fmt(d.tn, 1) + '℃</td><td>' + fmt(d.tm, 1) + '℃</td></tr>'; }).join('') + '</table>' +
      '<div id="kmaBox" class="hint">기상청 단기예보 대조 확인 중<span class="dots"></span></div>';
  }
  if (S.mode === 'past') {
    var c = D.cases[S.caseIdx], cr = c.rows.filter(function (x) { return x.sgg === e.sgg; })[0];
    h += '<h3>이 대설의 실제 결과</h3><p>' + esc(e.sgg) + ' 실제 피해 <b>' + (cr && cr.dmg > 0 ? fmt(eok(cr.dmg), 1) + '억 원' : '기록 없음') + '</b> <span class="hint">(시군 단위 통계)</span></p>';
  }
  var ns = D.news.filter(function (n) { return n.id === S.sel; });
  if (ns.length) h += '<h3>이 읍면의 피해 보도</h3>' + ns.map(function (n) { return '<div class="news">' + esc(n.date) + ' · ' + esc(n.fac) + '<br>' + esc(n.txt) + '<br><a href="' + esc(n.url) + '" target="_blank" rel="noopener">' + esc(n.src) + ' 「' + esc(n.title) + '」</a> ' + esc(n.pub) + '</div>'; }).join('');
  h += '<div class="row" style="margin-top:14px"><button class="btn sm" id="notiBtn">주민 안내 문구 만들기</button><button class="btn sm line" id="repHere">이 읍면 제보</button></div><div id="notiBox"></div>';
  el.innerHTML = h;
  $('notiBtn').onclick = makeNotice; $('repHere').onclick = function () { openField(S.sel); };
  if (S.mode === 'forecast' && r.days) loadKma(e);
}
/* 기상청 단기예보(공공데이터포털) 대조: 키는 Netlify 환경변수에만 있고, 함수가 대신 호출한다 */
function loadKma(e) {
  var k = e.nx + '_' + e.ny, box = function () { return $('kmaBox'); };
  function show(j) {
    if (!box() || S.sel !== e.id) return;
    if (j && j.ok) box().innerHTML = '<b style="color:#14263b">기상청 단기예보 대조</b> (발표 ' + esc(j.base) + ', 격자 ' + e.nx + ',' + e.ny + ')<table class="t num"><tr><th>날짜</th><th>강수</th><th>신적설</th><th>최저</th></tr>' +
      j.days.map(function (d) { return '<tr><td>' + esc(d.date.slice(4, 6) + '.' + d.date.slice(6)) + '</td><td>' + fmt(d.pcp, 1) + 'mm</td><td>' + fmt(d.sno, 1) + 'cm</td><td>' + (d.tmin == null ? '–' : fmt(d.tmin, 0) + '℃') + '</td></tr>'; }).join('') + '</table>';
    else box().textContent = j && j.reason === 'nokey' ? '기상청 단기예보 대조: 키가 아직 설정되지 않았습니다.' : '기상청 단기예보 대조: 연결되지 않았습니다 (배포 후 작동).';
  }
  if (S.kma[k]) return show(S.kma[k]);
  fetch('/.netlify/functions/kma?nx=' + e.nx + '&ny=' + e.ny).then(function (r) { return r.json(); }).then(function (j) { if (j && j.ok) S.kma[k] = j; show(j); }).catch(function () { show(null); });
}

/* ---------- 화면: 검증 ---------- */
function renderVal() {
  var w = D.wrn, mx = Math.max.apply(null, M.grades.map(function (g) { return g.rate; }));
  var h = '<h2>이 예측, 얼마나 맞나</h2><p class="hint">겨울을 하나씩 빼고 나머지로 학습해 그 겨울을 맞히는 방식으로 검증했습니다 (' + M.winters[0] + '~' + M.winters[1] + '년 겨울).</p>' +
    '<div class="stat"><div><strong class="num">' + M.auc.toFixed(3) + '</strong><span>구분 정확도(AUC)<br>강설 ' + fmt(M.n) + '건 · 피해 ' + M.pos + '건</span></div><div><strong class="num">' + M.auc_recent.toFixed(3) + '</strong><span>2017년 이후 겨울만<br>' + fmt(M.n_recent) + '건 · 피해 ' + M.pos_recent + '건</span></div></div>' +
    '<h3>등급별 실제 피해율</h3>' + M.grades.map(function (g) { return '<div class="vbar' + (g.g === 3 ? ' top' : '') + '"><span class="badge ' + GR[g.g].cls + '" style="min-width:0">' + GR[g.g].k + '</span><span class="tr"><i style="width:' + (g.rate / mx * 100) + '%;background:' + GR[g.g].c + '"></i></span><b class="num">' + g.rate + '%</b></div>'; }).join('') +
    '<p class="hint">' + M.grades.map(function (g) { return GR[g.g].k + ' ' + fmt(g.n) + '건 중 ' + g.dmg + '건'; }).join(' · ') + '</p>' +
    '<h3>대설특보와 견주기</h3><p>대설특보(주의보 이상)가 나온 강설 ' + fmt(w.adv_n) + '건 중 피해가 난 것은 <b>' + w.adv_hit + '건(' + Math.round(w.adv_hit / w.adv_n * 100) + '%)</b>입니다. 같은 특보 안에서 등급을 나누면:</p>' +
    w.by_grade.map(function (g) { return '<div class="vbar' + (g.g === 3 ? ' top' : '') + '"><span class="badge ' + GR[g.g].cls + '" style="min-width:0">' + GR[g.g].k + '</span><span class="tr"><i style="width:' + (g.rate / 60 * 100) + '%;background:' + GR[g.g].c + '"></i></span><b class="num">' + g.rate + '%</b></div>'; }).join('') +
    '<p class="hint">2005.10~2024.12 강설 ' + fmt(w.n_event) + '건, 피해 ' + w.n_dmg + '건. 특보가 피해를 놓친 경우는 ' + w.miss + '건으로 적습니다. 이 도구는 특보를 대신하지 않고, 특보가 나온 곳들 사이의 순서를 정합니다.</p>' +
    '<h3>모델</h3><p>로지스틱 회귀, 입력 2개: 눈 무게(강설일 강수량 합)의 로그, 눈 올 때 평균기온. 위험 점수는 과거 강설 ' + fmt(M.n) + '건 가운데의 순위(0~100)입니다.</p>' +
    '<h3>한계</h3><ul class="plain">' +
    '<li>피해 기록이 시군 단위라 읍면별 정답으로 검증하지 못했습니다. 읍면 차이는 예보와 시설 면적에서 나옵니다.</li>' +
    '<li>학습은 관측소 자료, 예보는 격자 자료라 눈 무게가 다르게 나올 수 있습니다 (추가 검증 필요).</li>' +
    '<li>0℃ 안팎의 젖은 눈(2024년 11월 영서)은 낮게 평가하는 경향이 있습니다.</li>' +
    '<li>최근 겨울은 정확도가 낮아 따로 공개합니다.</li>' +
    '<li>순서(피해 확률 × 시설 면적)는 읍면 안 시설이 같은 영향을 받는다고 본 가정입니다.</li></ul>' +
    '<h3>자료</h3><ul class="plain">' +
    '<li>피해 기록: 행정안전부 국민재난안전포털 자연재난상황통계(대설, 강원, 2004~2024)</li>' +
    '<li>강설: 기상청 기상자료개방포털 종관·방재 관측 일자료(2003.10~2024.12), 기상특보 이력</li>' +
    '<li>예보: Open-Meteo Forecast API(CC BY 4.0), 기상청 단기예보(공공데이터포털)</li>' +
    '<li>시설: 농림수산식품교육문화정보원 팜맵 통계(2025) · 인구: 행정안전부 주민등록 인구통계(2026.10) · 전통시장: 소상공인시장진흥공단 표준데이터</li>' +
    '<li>경계: admdongkor 행정동 경계 · 지형: AWS Terrain Tiles · 위성사진: Sentinel-2 cloudless(EOX). 시가지 강조는 위성사진의 밝기로 표시한 것으로 공식 토지 분류가 아닙니다.</li></ul>';
  $('valP').innerHTML = h;
}

/* ---------- 선택·탭·전환 ---------- */
function showTab(id) {
  Array.prototype.forEach.call(document.querySelectorAll('#tabs [role=tab]'), function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === id); });
  Array.prototype.forEach.call(document.querySelectorAll('.pane'), function (p) { p.classList.toggle('on', p.id === id); });
  $('board').classList.remove('fold');
}
function select(id, fly, tab) {
  S.sel = id; var e = EMD[id];
  if (ready) map.setFilter('sel-line', ['==', ['get', 'id'], id]);
  if (fly && e) flyTo(e.lon, e.lat);
  renderInfo(); if (tab) showTab('infoP');
  Array.prototype.forEach.call(document.querySelectorAll('#rank li'), function (li) { li.classList.toggle('on', li.getAttribute('data-id') === id); });
}
function renderAll() { computeRows(); renderScen(); renderRank(); renderInfo(); paint(); suggest(); }
function refresh(force) {
  if (S.mode !== 'forecast') return renderAll();
  renderScen();
  loadForecast(force).then(renderAll);
}
function setMode(m) {
  S.mode = m; $('mFc').setAttribute('aria-pressed', m === 'forecast'); $('mPast').setAttribute('aria-pressed', m === 'past');
  $('caseWrap').classList.toggle('on', m === 'past'); clearPins(S.aiPins);
  if (m === 'forecast') refresh(false); else { renderAll(); showTab('rankP'); if (map) map.flyTo({ center: [128.35, 37.72], zoom: 7.9, pitch: 56, speed: 0.8, padding: PAD() }); }
}

/* ---------- 현장 제보 (이 기기에만 저장) ---------- */
var REP_KEY = 'snowflower_reports_v1';
function reports() { return lsGet(REP_KEY) || []; }
function paintReports() {
  if (!ready) return; clearPins(S.repPins);
  reports().forEach(function (r) { var e = EMD[r.id]; if (!e) return;
    var el = document.createElement('div'); el.className = 'rpin'; el.textContent = '제보 · ' + r.type; el.title = e.sgg + ' ' + e.nm + ' ' + (r.memo || '');
    S.repPins.push(new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, 4] }).setLngLat([e.lon, e.lat]).addTo(map)); });
}
function openField(id) {
  var sel = $('fEmd');
  if (!sel.options.length) sel.innerHTML = D.emd.slice().sort(function (a, b) { return (a.sgg + a.nm).localeCompare(b.sgg + b.nm, 'ko'); }).map(function (e) { return '<option value="' + e.id + '">' + esc(e.sgg + ' ' + e.nm) + '</option>'; }).join('');
  if (id) sel.value = id; $('fMemo').value = ''; $('fieldDlg').showModal();
}

/* ---------- 생성형 AI (Gemini, 키는 서버에만) ---------- */
var AI = { state: 'unknown', model: null };
function setAiState(st, txt) { AI.state = st; var el = $('aiState'); el.className = st === 'live' ? 'live' : st === 'off' ? 'off' : ''; el.textContent = txt; }
function pingAI() {
  fetch('/api/ai?ping=1').then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .catch(function () { return fetch('/.netlify/functions/ai?ping=1').then(function (r) { if (!r.ok) throw 0; return r.json(); }); })
    .then(function (j) { if (j && j.key) setAiState('live', '실시간 AI 연결됨 (Gemini)'); else setAiState('off', 'AI 키 미설정 · 규칙 문장으로 답함'); })
    .catch(function () { setAiState('off', 'AI 연결 전 · 규칙 문장으로 답함'); });
}
function callAI(task, payload) {
  var body = JSON.stringify(Object.assign({ task: task }, payload)), eps = [['/api/ai', 30000], ['/.netlify/functions/ai', 10500]], i = 0, last = 'fail';
  function next() {
    if (i >= eps.length) return Promise.resolve({ ok: false, reason: last });
    var ep = eps[i++], ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, ep[1]);
    return fetch(ep[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: body, signal: ctl.signal })
      .then(function (r) { clearTimeout(t); return r.json().catch(function () { return { ok: false, reason: 'HTTP ' + r.status }; }); })
      .then(function (j) { if (j && j.ok) return j; last = (j && j.reason) || last; if (last === 'nokey') return { ok: false, reason: 'nokey' }; return next(); })
      .catch(function (e) { clearTimeout(t); last = e && e.name === 'AbortError' ? 'timeout' : 'network'; return next(); });
  }
  return next();
}
function via(j) {
  if (j && j.ok) { setAiState('live', '실시간 AI 연결됨 (Gemini)'); return '실시간 AI · ' + j.model + ' · ' + hm(Date.now()); }
  if (j && j.reason === 'nokey') { setAiState('off', 'AI 키 미설정 · 규칙 문장으로 답함'); return 'AI 미사용(키 미설정) · 규칙으로 만든 문장'; }
  return 'AI 연결 실패 · 규칙으로 만든 문장';
}
function ctxRows(n) {
  return units().filter(function (u) { return u.g >= 0; }).slice(0, n).map(function (u, i) {
    return { id: 'R' + (i + 1), 순서: i + 1, 시군: u.sgg, 읍면: u.isDong ? '동 지역(합산)' : u.label, 등급: GR[u.g].k, 위험점수: Math.round(u.score), 눈무게_mm: u.P, 눈올때기온: u.tw,
             시설면적_ha: u.fha == null ? null : Math.round(u.fha), 고령비율_pct: u.pop ? Math.round(u.o65 / u.pop * 100) : null, 전통시장: u.mk, _u: u };
  });
}
function aiContext(rows) {
  var cnt = [0, 0, 0, 0], no = 0; D.emd.forEach(function (e) { var r = S.rows[e.id]; if (!r || r.g < 0) no++; else cnt[r.g]++; });
  var c = { 상황: S.mode === 'forecast' ? (S.fc ? S.fc[0].time[0] + '~' + S.fc[0].time[S.fc[0].time.length - 1] + ' 실제 예보(받은 시각 ' + hm(S.fcAt) + ')' : '예보 수신 전') : D.cases[S.caseIdx].period + ' 과거 대설 재현(시군 관측값, 그 겨울을 빼고 학습한 모델)',
    읍면동수: { 매우높음: cnt[3], 높음: cnt[2], 보통: cnt[1], 낮음: cnt[0], 강설없음: no },
    등급별_과거_실제피해율_pct: { 낮음: rateOf(0), 보통: rateOf(1), 높음: rateOf(2), 매우높음: rateOf(3) },
    검증: { 교차검증_AUC: M.auc, 최근겨울_AUC: M.auc_recent, 한계: ['피해 기록이 시군 단위', '젖은 눈은 낮게 평가', '예보 격자와 관측 차이'] },
    순서기준: '피해 확률 × 시설 면적(ha)',
    순서표: rows.map(function (r) { var o = {}; Object.keys(r).forEach(function (k) { if (k !== '_u') o[k] = r[k]; }); return o; }) };
  if (S.mode === 'past') c.실제피해_억원 = D.cases[S.caseIdx].rows.filter(function (r) { return r.dmg > 0; }).map(function (r) { return { 시군: r.sgg, 피해액: Math.round(eok(r.dmg) * 10) / 10 }; });
  if (S.sel) { var e = EMD[S.sel], r = S.rows[S.sel] || {}; c.선택한_읍면 = { 시군: e.sgg, 읍면: e.nm, 등급: r.g >= 0 ? GR[r.g].k : '강설 없음', 위험점수: Math.round(r.score || 0), 눈무게_mm: r.P, 눈올때기온: r.tw, 시설면적_ha: e.fha, 인구: e.pop, 고령_65세이상: e.o65, 전통시장: e.mk }; }
  return c;
}
/* 규칙으로 만든 문장(AI가 없거나 실패했을 때) */
function ruleChat() {
  var rows = ctxRows(3).filter(function (r) { return r._u.g >= 1; });
  if (!rows.length) return { answer: S.mode === 'forecast' ? '지금 받은 3일 예보에는 피해 위험이 보통 이상인 읍면이 없습니다. 위쪽 "과거 대설 재현"을 누르면 실제 대설 때 어떻게 작동하는지 볼 수 있습니다.' : '이 사례에서는 위험이 보통 이상인 읍면이 없습니다.', places: [], follow_ups: [] };
  var t = rows[0];
  return { answer: '점검 순서표 1순위는 ' + t.시군 + ' ' + t.읍면 + '입니다. 등급 ' + t.등급 + ', 위험 점수 ' + t.위험점수 + '점, 시설 면적 ' + fmt(t.시설면적_ha) + 'ha입니다. 과거 같은 등급에서는 100번 중 ' + fmt(rateOf(t._u.g), 0) + '번꼴로 피해가 났습니다.' + (rows[1] ? ' 다음은 ' + rows.slice(1).map(function (r) { return r.시군 + ' ' + r.읍면; }).join(', ') + ' 순입니다.' : ''),
    places: rows.map(function (r) { return { id: r.id, why: r.등급 + ' · 시설 ' + fmt(r.시설면적_ha) + 'ha' }; }), follow_ups: ['이 순서의 근거가 뭐야?', '이 예측은 얼마나 맞아?'] };
}
function addMsg(cls, text, extra) {
  var el = document.createElement('div'); el.className = 'msg ' + cls; el.textContent = text;
  if (extra) el.appendChild(extra); $('log').appendChild(el); $('log').scrollTop = $('log').scrollHeight; return el;
}
function showPlaces(places, rows) {
  clearPins(S.aiPins); var wrap = document.createElement('div'); wrap.className = 'pl'; var first = null;
  (places || []).slice(0, 3).forEach(function (p, i) {
    var r = rows.filter(function (x) { return x.id === p.id; })[0]; if (!r) return; var u = r._u; if (!first) first = u;
    var b = document.createElement('button'); b.type = 'button'; b.innerHTML = '<b>' + (i + 1) + '</b>' + esc(u.sgg + ' ' + (u.isDong ? '동 지역' : u.label)) + (p.why ? ' — ' + esc(p.why) : '');
    b.onclick = function () { select(u.ids[0], true, true); }; wrap.appendChild(b);
    if (ready) { var el = document.createElement('div'); el.className = 'pin ai'; el.innerHTML = '<i>' + (i + 1) + '</i>' + esc(u.isDong ? u.sgg + ' 동 지역' : u.label);
      S.aiPins.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -34] }).setLngLat([u.lon, u.lat]).addTo(map)); }
  });
  if (first) flyTo(first.lon, first.lat, 9.8);
  return wrap.childNodes.length ? wrap : null;
}
function ask(q) {
  q = (q || '').trim(); if (!q) return; addMsg('me', q); $('q').value = '';
  var wait = addMsg('ai', '수치를 확인하는 중'); wait.classList.add('dots');
  var rows = ctxRows(20);
  callAI('chat', { ctx: aiContext(rows), q: q, history: S.hist.slice(-4) }).then(function (j) {
    var out = j.ok && j.data && j.data.answer ? j.data : ruleChat(), src = via(j.ok && j.data && j.data.answer ? j : (j.ok ? { ok: false } : j));
    wait.remove(); var extra = document.createDocumentFragment(), pl = showPlaces(out.places, rows);
    if (pl) extra.appendChild(pl); var v = document.createElement('span'); v.className = 'via'; v.textContent = src; extra.appendChild(v);
    addMsg('ai', out.answer, extra); S.hist.push({ q: q, a: out.answer }); suggest(out.follow_ups);
  });
}
function suggest(list) {
  var base = S.mode === 'forecast' ? ['어디부터 가야 해?', '오늘 예보 요약해 줘', '이 예측은 얼마나 맞아?'] : ['어디부터 가야 해?', '실제 피해와 견주면 어때?', '왜 그곳이 1순위야?'];
  var qs = (list && list.length ? list : base).slice(0, 3);
  $('sugg').innerHTML = ''; qs.forEach(function (t) { var b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.onclick = function () { ask(t); }; $('sugg').appendChild(b); });
}
/* 판단 근거 보고서 */
function ruleReport(rows) {
  var top = rows.slice(0, 5), t = top[0];
  return { headline: t.시군 + ' ' + t.읍면 + '부터 점검', situation: (S.mode === 'forecast' ? '앞으로 3일 예보' : D.cases[S.caseIdx].period + ' 대설 재현') + ' 기준으로 위험이 있는 읍면을 피해 확률과 시설 면적으로 줄 세웠습니다.',
    basis: top.map(function (r) { return r.시군 + ' ' + r.읍면 + ': ' + r.등급 + '(' + r.위험점수 + '점), 눈 무게 ' + fmt(r.눈무게_mm, 1) + 'mm, 시설 ' + fmt(r.시설면적_ha) + 'ha'; }),
    actions: ['순서표 위쪽 읍면부터 연동 하우스·축사·인삼 시설·시장 아케이드 순찰', '위험 높음 이상 읍면에 눈 쓸어내리기와 받침대 보강 안내', '65세 이상 비율이 높은 읍면은 마을 방송과 이장 연락망으로 한 번 더 안내'],
    limits: ['피해 기록이 시군 단위라 읍면 순서는 예보와 시설 면적에서 나옵니다.', '젖은 눈은 위험을 낮게 볼 수 있습니다.'] };
}
function makeReport() {
  var rows = ctxRows(10).filter(function (r) { return r._u.idx > 0 || r._u.score > 0; }); if (!rows.length) return;
  var body = $('reportBody'); body.innerHTML = '<h2>판단 근거 보고서</h2><p>작성 중<span class="dots"></span></p>'; $('reportDlg').showModal();
  callAI('report', { ctx: aiContext(rows) }).then(function (j) {
    var okAi = j.ok && j.data && j.data.headline, r = okAi ? j.data : ruleReport(rows), li = function (a) { return (a || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join(''); };
    body.innerHTML = '<h2>' + esc(r.headline) + '</h2><p class="via">' + esc(via(okAi ? j : (j.ok ? { ok: false } : j))) + ' · ' + esc(aiContext([]).상황) + '</p>' +
      '<p>' + esc(r.situation) + '</p><h3>점검 순서 (피해 확률 × 시설 면적)</h3>' +
      '<table class="t num"><tr><th>순서</th><th>읍면</th><th>등급</th><th>점수</th><th>눈 무게</th><th>시설</th><th>65세 이상</th></tr>' +
      rows.map(function (x) { return '<tr><td>' + x.순서 + '</td><td>' + esc(x.시군 + ' ' + x.읍면) + '</td><td>' + x.등급 + '</td><td>' + x.위험점수 + '</td><td>' + fmt(x.눈무게_mm, 1) + 'mm</td><td>' + fmt(x.시설면적_ha) + 'ha</td><td>' + (x.고령비율_pct == null ? '–' : x.고령비율_pct + '%') + '</td></tr>'; }).join('') + '</table>' +
      '<h3>판단 근거</h3><ul>' + li(r.basis) + '</ul><h3>권장 조치</h3><ol>' + li(r.actions) + '</ol><h3>유의할 점</h3><ul>' + li(r.limits) + '</ul>' +
      '<p class="via">표의 수치는 지도와 같은 계산값입니다. 문장은 ' + (okAi ? 'AI가 이 수치만 보고 썼습니다.' : '정해진 규칙으로 만들었습니다.') + ' 등급별 과거 실제 피해율: 낮음 ' + rateOf(0) + '% · 보통 ' + rateOf(1) + '% · 높음 ' + rateOf(2) + '% · 매우 높음 ' + rateOf(3) + '%</p>' +
      '<div class="foot"><button class="btn line" id="repPrint">인쇄</button><button class="btn" id="repClose">닫기</button></div>';
    $('repPrint').onclick = function () { window.print(); }; $('repClose').onclick = function () { $('reportDlg').close(); };
  });
}
function makeNotice() {
  var e = EMD[S.sel], r = S.rows[S.sel] || { g: -1 }, box = $('notiBox'); box.innerHTML = '<div class="notice">작성 중<span class="dots"></span></div>';
  callAI('notice', { ctx: aiContext([]) }).then(function (j) {
    var okAi = j.ok && j.data && j.data.notice;
    var txt = okAi ? j.data.notice : (r.g >= 2 ? '[' + e.sgg + ' ' + e.nm + '] 눈 피해 위험이 ' + GR[r.g].k + ' 단계입니다. 비닐하우스와 축사 지붕의 눈을 자주 쓸어내리고 받침대를 세워 주세요. 시설 안에 오래 머물지 마세요.'
      : r.g === 1 ? '[' + e.sgg + ' ' + e.nm + '] 눈이 예보되어 있습니다. 비닐하우스와 축사 지붕에 눈이 쌓이는지 살펴 주세요. 낡은 시설은 받침대를 미리 세워 주세요.'
      : '[' + e.sgg + ' ' + e.nm + '] 현재 눈 피해 위험은 낮습니다. 예보가 바뀌면 다시 알려 드리겠습니다.');
    box.innerHTML = '<div class="notice">' + esc(txt) + '<div class="src">' + esc(via(okAi ? j : (j.ok ? { ok: false } : j))) + '</div></div>';
  });
}

/* ---------- 시작 ---------- */
function init() {
  $('lg').innerHTML = GR.map(function (g) { return '<span style="background:' + g.c + ';color:' + (g.cls === 'g2' || g.cls === 'g3' ? '#fff' : '#1a1a1a') + '">' + g.k + '</span>'; }).join('');
  $('lr').innerHTML = M.grades.map(function (g) { return '<span class="num">' + g.rate + '%</span>'; }).join('');
  $('caseSel').innerHTML = D.cases.map(function (c, i) { return '<option value="' + i + '">' + esc(c.period.slice(0, 10).replace(/\./g, '.')) + ' · ' + fmt(eok(c.tot), 0) + '억 · ' + c.n_sgg + '개 시군</option>'; }).join('');
  var def = 0; D.cases.forEach(function (c, i) { if (c.period.indexOf('2024.11') === 0) def = i; }); S.caseIdx = def; $('caseSel').value = def;
  $('caseSel').onchange = function () { S.caseIdx = +this.value; S.sel = null; clearPins(S.aiPins); renderAll(); showTab('rankP'); };
  $('mFc').onclick = function () { setMode('forecast'); }; $('mPast').onclick = function () { setMode('past'); };
  Array.prototype.forEach.call(document.querySelectorAll('#tabs [role=tab]'), function (b) { b.onclick = function () { showTab(b.getAttribute('data-tab')); }; });
  $('foldBtn').onclick = function () { var f = $('board').classList.toggle('fold'); this.textContent = f ? '▸' : '▾'; };
  $('baseBtn').onclick = function () { setTint(this.getAttribute('aria-pressed') !== 'true'); };
  $('mkBtn').onclick = function () { var on = this.getAttribute('aria-pressed') !== 'true'; this.setAttribute('aria-pressed', on); if (ready) map.setLayoutProperty('mk', 'visibility', on ? 'visible' : 'none'); };
  $('rotBtn').setAttribute('aria-pressed', S.rot); $('rotBtn').onclick = function () { S.rot = !S.rot; this.setAttribute('aria-pressed', S.rot); lastAct = S.rot ? 0 : Date.now(); };
  $('relBtn').onclick = function () { reliefOn(this.getAttribute('aria-pressed') !== 'true'); };
  $('exBtn').onclick = function () { var on = this.getAttribute('aria-pressed') !== 'true'; this.setAttribute('aria-pressed', on); if (ready && !flat) map.setTerrain({ source: 'dem', exaggeration: EXAG[on ? 1 : 0] }); };
  $('lgRamp').style.background = 'linear-gradient(90deg,' + RAMP.map(function (c, i) { return c + ' ' + ([0, 100, 300, 500, 700, 900, 1100, 1300, 1500][i] / 15).toFixed(1) + '%'; }).join(',') + ')';
  $('fieldBtn').onclick = function () { openField(S.sel); }; $('fCancel').onclick = function () { $('fieldDlg').close(); };
  $('fieldForm').addEventListener('submit', function () { var a = reports(); a.push({ id: $('fEmd').value, type: $('fType').value, memo: $('fMemo').value.slice(0, 200), t: Date.now() }); lsSet(REP_KEY, a.slice(-50)); paintReports(); var e = EMD[$('fEmd').value]; if (e) flyTo(e.lon, e.lat); });
  $('ask').addEventListener('submit', function (ev) { ev.preventDefault(); ask($('q').value); });
  renderVal(); computeRows(); renderScen(); renderRank(); renderInfo(); suggest();
  addMsg('ai', '안녕하세요. 지도에 보이는 예보와 순서표 수치로 답합니다. 장소를 답하면 지도가 그곳으로 움직입니다.');
  try { initMap(); } catch (e) { $('map').innerHTML = '<p style="color:#fff;padding:120px 24px">이 브라우저에서는 3D 지도를 열 수 없습니다 (WebGL 필요). 순서표와 검증은 그대로 쓸 수 있습니다.</p>'; }
  pingAI(); refresh(false);
}
window.__snow = { S: S, units: units, score: score, prob: prob, eventFromDaily: eventFromDaily, setMode: setMode, select: select };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
