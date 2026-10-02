/* Карта УИК Новосибирской области — клиентская логика */
(function () {
"use strict";

const OSM_STYLE = {
  version: 8,
  sources: { osm: {
    type: "raster",
    tiles: [
      "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
      "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"
    ],
    tileSize: 256, maxzoom: 19,
    attribution: "© OpenStreetMap contributors"
  }},
  layers: [{ id: "osm", type: "raster", source: "osm" }]
};

/* Цвета */
const COLOR_KPRF    = "#dc2626"; // красный — лидер КПРФ
const COLOR_OTHER   = "#2563eb"; // синий — лидер другая партия
const COLOR_NODATA  = "#94a3b8"; // серый — нет результатов
const COLOR_ANOMALY = "#000000"; // чёрный — аномалия (ЕР > 80%)

const KPRF_KEY = "kprf";

/** Возвращает партию-лидера по числу голосов, либо null */
function getLeader(perUik){
  if (!perUik || !perUik.has_results || !perUik.results || !perUik.results.length){
    return null;
  }
  let best = perUik.results[0];
  for (const r of perUik.results){
    if ((r.votes || 0) > (best.votes || 0)) best = r;
  }
  return best;
}

/** true, если в здании хотя бы у одного УИК лидер — КПРФ */
function hasKprfLeader(item){
  for (const p of item.per_uik){
    if (!p.has_results) continue;
    const leader = getLeader(p);
    if (leader && leader.key === KPRF_KEY) return true;
  }
  return false;
}

/** true, если хотя бы у одного УИК в здании ЕР набрала > 80% */
function hasAnomaly(item){
  for (const p of item.per_uik){
    if (!p.has_results) continue;
    if (p.is_anomaly) return true;
  }
  return false;
}

/**
 * Минимальное (лучшее) место КПРФ среди всех УИК в здании.
 * Если данных нет — вернётся null.
 */
function bestKprfRank(item){
  let best = null;
  for (const p of item.per_uik){
    if (!p.has_results) continue;
    if (p.kprf_rank == null) continue;
    if (best === null || p.kprf_rank < best) best = p.kprf_rank;
  }
  return best;
}

const $ = id => document.getElementById(id);
let MAP = null, DATA = null;
let POINTS_BY_GIS = new Map();
let UIK_INDEX = new Map();

function toast(t, ms=2500){
  const el = $("toast"); el.textContent = t; el.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(()=>el.classList.remove("show"), ms);
}
const esc = s => String(s==null?"":s)
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;").replace(/'/g,"&#39;");

async function loadData(){
  try {
    const r = await fetch("data/map-data.json", { cache: "no-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    DATA = await r.json();
  } catch (e){
    document.body.innerHTML =
      '<div style="padding:40px;font-family:system-ui">' +
      '<h2>Не найден файл data/map-data.json</h2>' +
      '<p>Сначала запустите <b>run.bat</b> — он подготовит данные.</p>' +
      '<p style="color:#666">Техническая ошибка: ' + esc(e.message) + '</p>' +
      '</div>';
    return;
  }
  start();
}

function start(){
  buildIndexes();
  buildMap();
  fillTikFilter();
  updateStats();
  setupSearch();
  setupControls();
}

function buildIndexes(){
  POINTS_BY_GIS.clear();
  UIK_INDEX.clear();
  for (const it of DATA.items){
    POINTS_BY_GIS.set(it.uik_gis_id, it);
    for (const p of it.per_uik){
      UIK_INDEX.set(p.uik_number, { item: it, perUik: p });
    }
  }
}

function buildMap(){
  MAP = new maplibregl.Map({
    container: "map",
    style: OSM_STYLE,
    center: [82.9, 55.0],
    zoom: 6,
    attributionControl: { compact: true }
  });
  MAP.addControl(new maplibregl.NavigationControl({ showCompass:false }), "top-right");
  MAP.addControl(new maplibregl.ScaleControl({ maxWidth:100, unit:"metric" }), "bottom-right");
  setTimeout(() => MAP.resize(), 100);

  MAP.on("load", () => {
    MAP.addSource("uik", {
      type: "geojson",
      data: buildGeoJSON(DATA.items),
      cluster: true,
      clusterRadius: 55,
      clusterMaxZoom: 11,
      clusterProperties: {
        kprf_count: ["+", ["case", ["get","is_kprf"], 1, 0]]
      }
    });

    /* Кластеры */
    MAP.addLayer({
      id: "clusters", type: "circle", source: "uik",
      filter: ["has", "point_count"],
      paint: {
        "circle-color": [
          "case",
          [">=", ["/", ["get","kprf_count"], ["get","point_count"]], 0.5],
          COLOR_KPRF,
          COLOR_OTHER
        ],
        "circle-radius": ["step", ["get","point_count"],
          16, 20, 20, 100, 24, 500, 30],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#fff"
      }
    });

    /* Точки */
    MAP.addLayer({
      id: "points", type: "circle", source: "uik",
      filter: ["!", ["has","point_count"]],
      paint: {
        "circle-color": [
          "case",
          ["==", ["get","is_anomaly"], true], COLOR_ANOMALY,
          ["==", ["get","is_kprf"], true],    COLOR_KPRF,
          ["==", ["get","has_data"], false],  COLOR_NODATA,
          COLOR_OTHER
        ],
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 6, 14, 9, 18, 12],
        "circle-stroke-width": 2,
        "circle-stroke-color": "#fff"
      }
    });

    /* Цифра — место КПРФ на точке */
    MAP.addLayer({
      id: "points-rank", type: "symbol", source: "uik",
      filter: [
        "all",
        ["!", ["has","point_count"]],
        ["==", ["get","is_anomaly"], false],
        ["!=", ["get","kprf_rank_label"], ""]
      ],
      layout: {
        "text-field": ["get","kprf_rank_label"],
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 14, 13, 18, 16],
        "text-allow-overlap": true,
        "text-ignore-placement": true
      },
      paint: {
        "text-color": "#ffffff"
      }
    });

    MAP.on("click", "clusters", e => {
      const f = MAP.queryRenderedFeatures(e.point, { layers:["clusters"] })[0];
      const src = MAP.getSource("uik");
      src.getClusterExpansionZoom(f.properties.cluster_id, (err, zoom) => {
        if (err) return;
        MAP.easeTo({ center: f.geometry.coordinates, zoom });
      });
    });
    MAP.on("click", "points", e => {
      const f = e.features[0];
      const gid = f.properties.uik_gis_id;
      const it = POINTS_BY_GIS.get(gid);
      if (!it) return;
      showCard(it, null);
    });
    for (const l of ["clusters","points"]){
      MAP.on("mouseenter", l, () => MAP.getCanvas().style.cursor = "pointer");
      MAP.on("mouseleave", l, () => MAP.getCanvas().style.cursor = "");
    }
  });
}

function buildGeoJSON(items){
  const features = items.map(it => {
    const anyData = it.per_uik.some(p => p.has_results);
    const isKprf  = hasKprfLeader(it);
    const anomaly = hasAnomaly(it);
    const rank    = bestKprfRank(it);
    return {
      type: "Feature",
      geometry: { type:"Point", coordinates:[it.longitude, it.latitude] },
      properties: {
        uik_gis_id: it.uik_gis_id,
        is_kprf:    isKprf,
        has_data:   anyData,
        is_anomaly: anomaly,
        kprf_rank:  rank,
        kprf_rank_label: rank == null ? "" : String(rank),
        uik_count:  Math.max(1, it.uik_numbers.length)
      }
    };
  });
  return { type:"FeatureCollection", features };
}

function fillTikFilter(){
  const sel = $("tik-filter");
  const tiks = DATA.tik.slice().sort((a,b)=>a.tik_id.localeCompare(b.tik_id));
  for (const t of tiks){
    const o = document.createElement("option");
    o.value = t.tik_id;
    o.textContent = `${t.tik_id} — ${t.tik_name}`;
    sel.appendChild(o);
  }
}

function updateStats(){
  const d = DATA.diagnostics;
  const kprfCount = DATA.items.filter(hasKprfLeader).length;
  const anomalCount = DATA.items.filter(hasAnomaly).length;
  $("stats").innerHTML =
    `ТИК: <b>${d.tik_count}</b> · ` +
    `точек: <b>${d.points_count}</b> · ` +
    `УИК с результатами: <b>${d.uik_with_results}</b> · ` +
    `без: <b>${d.uik_without_results}</b> · ` +
    `КПРФ-лидеров: <b>${kprfCount}</b> · ` +
    `аномалий: <b>${anomalCount}</b>`;
}

function setupControls(){
  $("tik-filter").addEventListener("change", applyFilter);
  $("only-with-results").addEventListener("change", applyFilter);
  $("only-kprf").addEventListener("change", applyFilter);
  $("only-anomaly").addEventListener("change", applyFilter);
  $("kprf-third").addEventListener("change", applyFilter);

  $("reset-btn").addEventListener("click", () => {
    $("tik-filter").value = "";
    $("only-with-results").checked = false;
    $("only-kprf").checked = false;
    $("only-anomaly").checked = false;
    $("kprf-third").checked = false;
    $("search").value = "";
    $("search-results").hidden = true;
    applyFilter();
  });
}

function applyFilter(){
  const tik = $("tik-filter").value;
  const onlyRes = $("only-with-results").checked;
  const onlyKprf = $("only-kprf").checked;
  const onlyAnomaly = $("only-anomaly").checked;
  const kprfThird = $("kprf-third").checked;

  const items = DATA.items.filter(it => {
    if (tik && it.tik_id !== tik) return false;
    if (onlyRes && !it.per_uik.some(p=>p.has_results)) return false;
    if (onlyKprf && !hasKprfLeader(it)) return false;
    if (onlyAnomaly && !hasAnomaly(it)) return false;
    if (kprfThird){
      const anyThird = it.per_uik.some(p =>
        p.has_results && p.kprf_rank != null && p.kprf_rank >= 3
      );
      if (!anyThird) return false;
    }
    return true;
  });

  const src = MAP.getSource("uik");
  if (src) src.setData(buildGeoJSON(items));
  $("stats").innerHTML =
    `Показано точек: <b>${items.length}</b> из ${DATA.diagnostics.points_count}`;
}

function setupSearch(){
  const inp = $("search");
  const box = $("search-results");
  let timer = null;
  inp.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => doSearch(inp.value.trim()), 150);
  });
  inp.addEventListener("focus", () => { if (inp.value.trim()) doSearch(inp.value.trim()); });
  document.addEventListener("click", e => {
    if (!box.contains(e.target) && e.target !== inp) box.hidden = true;
  });
}

function doSearch(q){
  const box = $("search-results");
  if (!q){ box.hidden = true; box.innerHTML = ""; return; }
  const ql = q.toLowerCase();
  const results = [];

  const qNum = parseInt(q.replace(/\D/g,""),10);
  if (!isNaN(qNum) && UIK_INDEX.has(qNum)){
    const { item } = UIK_INDEX.get(qNum);
    results.push({ label:`УИК №${qNum}`,
                   sub:`${item.tik_name} · ${item.address}`,
                   action:() => focusUik(qNum) });
  }
  const maxAddr = 25;
  for (const it of DATA.items){
    if (results.length >= maxAddr) break;
    const hay = (it.address + " " + it.building + " " + it.tik_name + " " + it.tik_id).toLowerCase();
    if (hay.includes(ql)){
      const u = it.uik_numbers.join(", ");
      results.push({
        label: u ? `УИК ${u}` : `Точка #${it.uik_gis_id}`,
        sub: `${it.tik_name} · ${it.address}`,
        action: () => {
          MAP.flyTo({ center:[it.longitude,it.latitude], zoom:15 });
          showCard(it, null);
        }
      });
    }
  }
  if (!results.length){
    box.innerHTML = '<div class="empty">Ничего не найдено</div>';
    box.hidden = false;
    return;
  }
  box.innerHTML = results.slice(0,40).map((r,i) =>
    `<div class="item" data-i="${i}"><div class="num">${esc(r.label)}</div>
     <div class="sub">${esc(r.sub)}</div></div>`).join("");
  box.hidden = false;
  box.querySelectorAll(".item").forEach(el => {
    el.addEventListener("click", () => {
      const i = +el.dataset.i;
      results[i].action();
      box.hidden = true;
    });
  });
}

function focusUik(num){
  const rec = UIK_INDEX.get(num);
  if (!rec) return;
  MAP.flyTo({ center:[rec.item.longitude, rec.item.latitude], zoom:16 });
  setTimeout(() => showCard(rec.item, num), 350);
}

function showCard(item, preselect){
  const card = $("card");
  const inner = $("card-inner");
  card.hidden = false;

  const uiks = item.per_uik;
  const activeIdx = (() => {
    if (preselect != null){
      const i = uiks.findIndex(p => p.uik_number === preselect);
      if (i >= 0) return i;
    }
    const i = uiks.findIndex(p => p.has_results);
    return i >= 0 ? i : 0;
  })();

  let html = "";
  html += `<h2>${uiks.length>1 ? "Здание с УИК" : "УИК №"+uiks[0].uik_number}</h2>`;
  html += `<div class="meta">`;
  html += `<div><b>ТИК:</b> ${esc(item.tik_name || item.tik_id)}</div>`;
  if (item.address) html += `<div><b>Адрес:</b> ${esc(item.address)}</div>`;
  if (item.building) html += `<div><b>Здание:</b> ${esc(item.building)}</div>`;
  html += `<div><b>Координаты:</b> ${item.latitude.toFixed(6)}, ${item.longitude.toFixed(6)}</div>`;
  html += `<div><b>GIS ID:</b> ${item.uik_gis_id}</div>`;
  html += `</div>`;

  if (uiks.length > 1){
    html += `<div class="uik-tabs">`;
    uiks.forEach((p, i) => {
      html += `<button class="${i===activeIdx?'active':''}" data-idx="${i}">`;
      html += `УИК №${p.uik_number}${p.has_results?'':' ⚠'}`;
      html += `</button>`;
    });
    html += `</div>`;
  }

  html += `<div id="uik-body"></div>`;
  inner.innerHTML = html;

  const renderBody = (idx) => {
    const p = uiks[idx];
    const body = $("uik-body");
    if (!p){
      body.innerHTML = '<div class="empty">Нет данных по этому УИК.</div>';
      return;
    }

    let h = "";

    /* Лидер по голосам */
    const leader = getLeader(p);
    if (leader){
      const color = leader.key === KPRF_KEY ? COLOR_KPRF : COLOR_OTHER;
      h += `<div class="results-title" style="margin-top:0">
              Лидер по голосам:
              <span style="color:${color};font-weight:600">${esc(leader.party)}</span>
              <span style="color:#64748b;font-weight:400">(${leader.votes} · ${leader.pct.toFixed(2)}%)</span>
            </div>`;
    }

    /* Место КПРФ */
    if (p.has_results && p.kprf_rank != null){
      h += `<div class="results-title" style="margin-top:4px">
              КПРФ на <b>${p.kprf_rank}</b>-м месте
            </div>`;
    }

    /* Плашка «Аномалия» */
    if (p.has_results && p.is_anomaly){
      h += `<div style="margin:6px 0;padding:6px 10px;background:#000;color:#fff;
                       border-radius:6px;font-size:12px;font-weight:600">
              ⚠ Аномалия: ЕР набрала больше 80%
            </div>`;
    }

    h += `<div class="results-title">РЕЗУЛЬТАТЫ ВЫБОРОВ`;
    if (!p.has_results) h += ` <span class="warn">(нет данных для УИК №${p.uik_number})</span>`;
    h += `</div>`;

    if (!p.results || !p.results.length){
      h += `<div class="empty">Результаты для этого УИК отсутствуют в файле.</div>`;
    } else {
      const maxPct = Math.max(...p.results.map(r => r.pct || 0), 1);
      h += `<table class="results"><thead><tr>
              <th>Партия</th><th style="text-align:right">Голоса</th>
              <th style="text-align:right">%</th>
            </tr></thead><tbody>`;
      for (const r of p.results){
        const w = Math.round((r.pct / maxPct) * 100);
        const barColor = (leader && r.key === leader.key)
          ? (r.key === KPRF_KEY ? COLOR_KPRF : COLOR_OTHER)
          : "#94a3b8";
        h += `<tr>
          <td>${esc(r.party)}<div class="bar"><i style="width:${w}%;background:${barColor}"></i></div></td>
          <td class="num">${r.votes}</td>
          <td class="pct">${r.pct.toFixed(2)}%</td>
        </tr>`;
      }
      h += `</tbody></table>`;
      if (p.voters != null){
        h += `<div class="voters">Приняло участие: <b>${p.voters}</b></div>`;
      }
    }
    body.innerHTML = h;
  };
  renderBody(activeIdx);

  inner.querySelectorAll(".uik-tabs button").forEach(btn => {
    btn.addEventListener("click", () => {
      inner.querySelectorAll(".uik-tabs button").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      renderBody(+btn.dataset.idx);
    });
  });
}

$("card-close").addEventListener("click", () => { $("card").hidden = true; });

loadData();
})();