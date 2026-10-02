# -*- coding: utf-8 -*-
"""
Подготовка данных для карты УИК Новосибирской области.

Читает:
  map_data_v7.xlsx               (листы: Карта_УИК, ТИК, Polling_stations_RAW)
  ФО_Новосибирская область.xlsx  (лист: Единый пропорциональный)

Пишет:
  data/map-data.json

Структура листа "Единый пропорциональный" (реальные столбцы Excel):
  A  — Наименование территориальной избирательной комиссии
  B  — Количество УИК
  C  — № УИК
  D..S — служебные показатели (скрыты в UI, но есть в файле)
  T  — ЕР          голоса    U  — ЕР          %
  V  — ЛДПР        голоса    W  — ЛДПР        %
  X  — ППД         голоса    Y  — ППД         %
  Z  — ЗЕЛЁНЫЕ     голоса    AA — ЗЕЛЁНЫЕ     %
  AB — СР          голоса    AC — СР          %
  AD — РОДИНА      голоса    AE — РОДИНА      %
  AF — КПРФ        голоса    AG — КПРФ        %
  AH — ПЕНСИОНЕРЫ  голоса    AI — ПЕНСИОНЕРЫ  %
  AJ — КР          голоса    AK — КР          %
  AL — НОВЫЕ ЛЮДИ  голоса    AM — НОВЫЕ ЛЮДИ  %

В 0-индексации pandas:
  столбец C (№ УИК)         = 2
  первый столбец партий (T) = 19
  каждый следующий: +2
"""

import sys, json, re
from pathlib import Path
from collections import defaultdict

try:
    import pandas as pd
except ImportError:
    print("Нужен pandas. Установите: pip install pandas openpyxl")
    sys.exit(1)

BASE = Path(__file__).resolve().parent
OUT_DIR = BASE / "data"
OUT_DIR.mkdir(exist_ok=True)

XLSX_MAP = BASE / "map_data_v7.xlsx"
XLSX_FO  = BASE / "ФО_Новосибирская область.xlsx"

# --- 0-индексы ключевых столбцов в листе "Единый пропорциональный" ---
COL_UIK           = 2    # C  — № УИК
PARTY_COLS_START  = 19   # T  — голоса первой партии (ЕР)

# Порядок партий строго как в таблице (T, V, X, Z, AB, AD, AF, AH, AJ, AL)
PARTIES = [
    ("er",     "ЕДИНАЯ РОССИЯ"),
    ("ldpr",   "ЛДПР"),
    ("ppd",    "Партия прямой демократии"),
    ("green",  "ЗЕЛЁНЫЕ"),
    ("sr",     "СПРАВЕДЛИВАЯ РОССИЯ"),
    ("rodina", "РОДИНА"),
    ("kprf",   "КПРФ"),
    ("pens",   "ПАРТИЯ ПЕНСИОНЕРОВ"),
    ("kr",     "КОММУНИСТЫ РОССИИ"),
    ("new",    "НОВЫЕ ЛЮДИ"),
]

# Регэкспы для проверки шапки (строка 5 в Excel, 4 в pandas)
PARTY_PATTERNS = {
    "er":     r"ЕДИНАЯ\s+РОССИЯ",
    "ldpr":   r"ЛДПР",
    "ppd":    r"прямой\s+демократ",
    "green":  r"ЗЕЛ[ЁЕ]НЫЕ",
    "sr":     r"СПРАВЕДЛИВАЯ\s+РОССИЯ",
    "rodina": r"РОДИНА",
    "kprf":   r"КПРФ",
    "pens":   r"ПЕНСИОНЕР",
    "kr":     r"КОММУНИСТЫ\s+РОССИИ",
    "new":    r"НОВЫЕ\s+ЛЮДИ",
}


def norm_num(v):
    if v is None: return None
    s = str(v).strip()
    if not s or s.lower() == "nan": return None
    s = re.sub(r"\.0$", "", s)
    m = re.search(r"(\d+)", s)
    return int(m.group(1)) if m else None


def norm_float(v):
    if v is None: return None
    try:
        s = (str(v).strip()
             .replace(",", ".")
             .replace("%", "")
             .replace("\xa0", "")
             .replace(" ", ""))
        if not s or s.lower() == "nan": return None
        return float(s)
    except (ValueError, TypeError):
        return None


def split_desc(desc):
    if not desc: return []
    out = []
    for p in re.split(r"[,\s;]+", str(desc)):
        n = norm_num(p)
        if n is not None: out.append(n)
    return out


def main():
    print("=" * 60)
    print("Подготовка данных для карты УИК")
    print("=" * 60)

    if not XLSX_MAP.exists():
        print(f"ОШИБКА: не найден {XLSX_MAP.name}")
        return
    if not XLSX_FO.exists():
        print(f"ОШИБКА: не найден {XLSX_FO.name}")
        return

    print(f"\n[1/4] Читаю {XLSX_MAP.name} ...")
    df_karta = pd.read_excel(XLSX_MAP, sheet_name="Карта_УИК")
    df_tik   = pd.read_excel(XLSX_MAP, sheet_name="ТИК")
    try:
        df_ps = pd.read_excel(XLSX_MAP, sheet_name="Polling_stations_RAW")
    except Exception:
        df_ps = pd.DataFrame(columns=["OBJECTID", "NUM_PRECINCT"])
    print(f"      точек карты: {len(df_karta)}")
    print(f"      ТИК:         {len(df_tik)}")
    print(f"      PS:          {len(df_ps)}")

    print(f"\n[2/4] Читаю {XLSX_FO.name} ...")
    raw = pd.read_excel(XLSX_FO, sheet_name="Единый пропорциональный", header=None)
    print(f"      размер таблицы: {raw.shape[0]} строк × {raw.shape[1]} столбцов")

    # --- Проверяем, что в столбцах 19, 21, 23, ... действительно партии ---
    print("      Проверяю шапку (столбцы T..AM, 0-индексы 19..38):")
    ok_parties = 0
    for idx, (key, name) in enumerate(PARTIES):
        votes_col = PARTY_COLS_START + idx * 2
        pct_col   = votes_col + 1
        pat = PARTY_PATTERNS[key]

        found = False
        for r_i in range(min(10, len(raw))):
            for c in (votes_col, pct_col):
                if c >= raw.shape[1]:
                    continue
                v = str(raw.iloc[r_i, c] or "").strip()
                if v and re.search(pat, v, re.IGNORECASE):
                    found = True
                    break
            if found:
                break

        mark = "OK " if found else "!! "
        print(f"        {mark}{key:6s} голоса_col={votes_col:3d}  "
              f"pct_col={pct_col:3d}  ({name})")
        if found:
            ok_parties += 1

    if ok_parties < len(PARTIES):
        print(f"\n      ВНИМАНИЕ: найдено только {ok_parties} из {len(PARTIES)} партий.")
        print("      Столбцы могут быть сдвинуты — проверьте вручную.")
    else:
        print(f"      Все {len(PARTIES)} партий найдены в ожидаемых столбцах.")

    # --- Ищем строку заголовка (где "Наименование территориальной") ---
    header_row = None
    for i in range(min(30, len(raw))):
        if raw.shape[1] and "Наименование территориальной" in str(raw.iloc[i, 0]):
            header_row = i
            break
    if header_row is None:
        print("ОШИБКА: не найдена строка заголовка.")
        return
    print(f"      строка заголовка: {header_row}")

    # --- Читаем данные, начиная со строки после заголовка ---
    pat_uik_a = re.compile(r"^\s*УИК\s*№\s*(\d+)\s*$", re.IGNORECASE)

    fo_by_num = {}
    skipped_rows = 0
    for i in range(header_row + 1, len(raw)):
        row = raw.iloc[i]
        name_a = str(row.iloc[0] or "").strip()
        uik_c  = row.iloc[COL_UIK] if COL_UIK < len(row) else None

        m = pat_uik_a.match(name_a)
        num = None
        if m:
            num = int(m.group(1))
        else:
            if re.search(r"ДЭГ|округ|муниципальный|область", name_a, re.IGNORECASE):
                skipped_rows += 1
                continue
            n_c = norm_num(uik_c)
            if n_c is not None:
                num = n_c

        if num is None:
            continue
        if num in fo_by_num:
            continue

        # --- Читаем результаты по партиям ---
        results = []
        for idx, (key, name) in enumerate(PARTIES):
            votes_col = PARTY_COLS_START + idx * 2
            pct_col   = votes_col + 1
            votes = norm_num(row.iloc[votes_col]) if votes_col < len(row) else None
            pct   = norm_float(row.iloc[pct_col]) if pct_col < len(row) else None
            if votes is None and pct is None:
                continue
            results.append({
                "key": key,
                "party": name,
                "votes": votes if votes is not None else 0,
                "pct": pct if pct is not None else 0.0,
            })

        # --- Место КПРФ (1 = первое, 2 = второе, ...) ---
        sorted_results = sorted(
            results,
            key=lambda r: (r["votes"] or 0),
            reverse=True
        )
        kprf_rank = None
        for pos, r in enumerate(sorted_results, start=1):
            if r["key"] == "kprf":
                kprf_rank = pos
                break

        # --- Аномалия: ЕР > 80% ---
        er_pct = 0.0
        for r in results:
            if r["key"] == "er":
                er_pct = r["pct"] or 0.0
                break
        is_anomaly = er_pct > 80.0

        voters = norm_num(row.iloc[3]) if 3 < len(row) else None

        fo_by_num[num] = {
            "uik_number": num,
            "results": results,
            "voters": voters,
            "kprf_rank": kprf_rank,
            "is_anomaly": is_anomaly,
        }

    print(f"      УИК в ФО:    {len(fo_by_num)}  (пропущено сводных строк: {skipped_rows})")

    # --- Диагностика: покажем один УИК ---
    if fo_by_num:
        sample_num = sorted(fo_by_num.keys())[0]
        s = fo_by_num[sample_num]
        print(f"\n      Пример УИК №{sample_num}:")
        for r in s["results"]:
            print(f"        {r['party']:35s}  голоса={r['votes']:>6}  %={r['pct']:>6.2f}")
        print(f"        приняло участие: {s['voters']}")
        print(f"        место КПРФ:      {s['kprf_rank']}")
        print(f"        аномалия:        {s['is_anomaly']}")

    print(f"\n[3/4] Определяю ключ объединения ...")
    fo_nums = set(fo_by_num.keys())

    ps_map = defaultdict(list)
    for _, r in df_ps.iterrows():
        o = norm_num(r.get("OBJECTID"))
        n = norm_num(r.get("NUM_PRECINCT"))
        if o is None or n is None: continue
        ps_map[o].append(n)
    ps_nums = {n for lst in ps_map.values() for n in lst}
    h1 = len(ps_nums & fo_nums)

    desc_map = {}
    desc_nums = set()
    for _, r in df_karta.iterrows():
        g = norm_num(r.get("uik_gis_id"))
        nums = split_desc(r.get("uik_description"))
        if g is not None: desc_map[g] = nums
        desc_nums.update(nums)
    h2 = len(desc_nums & fo_nums)

    gid_set = {norm_num(r.get("uik_gis_id")) for _, r in df_karta.iterrows()}
    gid_set.discard(None)
    h3 = len(gid_set & fo_nums)

    print(f"      NUM_PRECINCT:    {h1}")
    print(f"      uik_description: {h2}")
    print(f"      uik_gis_id:      {h3}")

    candidates = [
        ("NUM_PRECINCT",    h1, len(ps_nums),  lambda g: ps_map.get(g, [])),
        ("uik_description", h2, len(desc_nums), lambda g: desc_map.get(g, [])),
        ("uik_gis_id",      h3, len(gid_set),  lambda g: ([g] if g is not None else [])),
    ]
    candidates.sort(key=lambda x: x[1], reverse=True)
    win_name, win_hits, win_total, win_get = candidates[0]
    print(f"      ВЫБРАН КЛЮЧ: {win_name} ({win_hits} из {win_total})")

    print(f"\n[4/4] Собираю map-data.json ...")

    tik_by_id = {}
    for _, r in df_tik.iterrows():
        tid = str(r.get("tik_id") or "").strip()
        if not tid: continue
        tik_by_id[tid] = {
            "tik_id": tid,
            "tik_name": str(r.get("tik_name") or "").strip(),
            "tik_phone": str(r.get("tik_phone") or "").strip(),
        }

    items = []
    unmatched = []
    with_results = 0
    seen = set()

    for _, r in df_karta.iterrows():
        gid = norm_num(r.get("uik_gis_id"))
        if gid is not None:
            if gid in seen: continue
            seen.add(gid)

        lat = norm_float(r.get("latitude"))
        lon = norm_float(r.get("longitude"))
        if lat is None or lon is None: continue

        tik_id = str(r.get("tik_id") or "").strip()
        nums = win_get(gid)
        per_uik = []
        for n in nums:
            rec = fo_by_num.get(n)
            if rec is None:
                unmatched.append({"uik_gis_id": gid, "uik_number": n, "tik_id": tik_id})
                per_uik.append({
                    "uik_number": n, "has_results": False,
                    "results": [], "voters": None,
                    "kprf_rank": None, "is_anomaly": False,
                })
            else:
                per_uik.append({
                    "uik_number": n, "has_results": True,
                    "results": rec["results"], "voters": rec["voters"],
                    "kprf_rank": rec["kprf_rank"],
                    "is_anomaly": rec["is_anomaly"],
                })
                with_results += 1

        items.append({
            "uik_gis_id": gid,
            "tik_id": tik_id,
            "tik_name": tik_by_id.get(tik_id, {}).get("tik_name", ""),
            "address": str(r.get("uik_address") or "").strip(),
            "building": str(r.get("uik_building") or "").strip(),
            "latitude": lat,
            "longitude": lon,
            "uik_numbers": list(nums),
            "per_uik": per_uik,
        })

    tik_agg = {}
    for it in items:
        t = tik_agg.get(it["tik_id"])
        if not t:
            t = {
                "tik_id": it["tik_id"], "tik_name": it["tik_name"],
                "uik_count": 0, "points": 0,
                "minLat": it["latitude"], "maxLat": it["latitude"],
                "minLon": it["longitude"], "maxLon": it["longitude"],
            }
            tik_agg[it["tik_id"]] = t
        t["points"] += 1
        t["uik_count"] += max(1, len(it["uik_numbers"]))
        t["minLat"] = min(t["minLat"], it["latitude"])
        t["maxLat"] = max(t["maxLat"], it["latitude"])
        t["minLon"] = min(t["minLon"], it["longitude"])
        t["maxLon"] = max(t["maxLon"], it["longitude"])

    out = {
        "meta": {
            "match_key": win_name,
            "match_hits": win_hits,
            "match_total": win_total,
            "parties": [{"key": k, "name": n} for k, n in PARTIES],
        },
        "tik": list(tik_agg.values()),
        "items": items,
        "unmatched": unmatched[:500],
        "diagnostics": {
            "tik_count": len(tik_agg),
            "points_count": len(items),
            "uik_in_fo": len(fo_by_num),
            "uik_with_results": with_results,
            "uik_without_results": len(unmatched),
        },
    }

    out_path = OUT_DIR / "map-data.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = out_path.stat().st_size / 1024
    print(f"      записан {out_path.name}  ({size_kb:.1f} KB)")

    print()
    print("=" * 60)
    print("ГОТОВО. Итоговый отчёт:")
    print("=" * 60)
    print(f"  ТИК:                           {len(tik_agg)}")
    print(f"  Точек на карте:                {len(items)}")
    print(f"  УИК в файле результатов:       {len(fo_by_num)}")
    print(f"  УИК с найденными результатами: {with_results}")
    print(f"  УИК без результатов:           {len(unmatched)}")
    print()


if __name__ == "__main__":
    main()