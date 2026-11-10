#!/usr/bin/env python3
"""Eudaimon reality feed: pulls real US + Texas + peer-country data into reality.json.

Sources (no API keys needed):
  FRED   https://fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES
  World Bank API v2
  UNDP Human Development Report composite indices (HDI)
Run weekly by .github/workflows/refresh.yml. Standard library only.
"""
import csv, io, json, os, subprocess, sys, time, urllib.request
from datetime import datetime, timezone

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reality.json")
START = "2000-01-01"

# id, label, region, category, unit, transform, good (+1 higher is better, -1 lower is better, 0 neutral)
FRED = [
    ("GDPC1", "Real GDP growth", "US", "Economic", "%", "yoy", +1),
    ("CPIAUCSL", "Inflation (CPI)", "US", "Economic", "%", "yoy", -1),
    ("UNRATE", "Unemployment", "US", "Social", "%", "level", -1),
    ("PAYEMS", "Job growth", "US", "Economic", "%", "yoy", +1),
    ("FEDFUNDS", "Fed funds rate", "US", "Economic", "%", "level", 0),
    ("DGS10", "10-year Treasury", "US", "Economic", "%", "level", 0),
    ("MORTGAGE30US", "30-year mortgage", "US", "Social", "%", "level", -1),
    ("CUSR0000SEHF01", "Electricity prices", "US", "Power", "%", "yoy", -1),
    ("GFDEGDQ188S", "Federal debt / GDP", "US", "Fiscal", "%", "level", -1),
    ("A091RC1Q027SBEA", "Federal interest paid", "US", "Fiscal", "$B/yr", "level", -1),
    ("GDP", "Nominal GDP", "US", "Fiscal", "$B/yr", "level", 0),
    ("WFRBSB50215", "Bottom 50% wealth share", "US", "Ownership", "%", "level", +1),
    ("WFRBST01134", "Top 1% wealth share", "US", "Ownership", "%", "level", -1),
    ("LABSHPUSA156NRUG", "Labor share of income", "US", "Ownership", "share", "level", +1),
    ("MEHOINUSA672N", "Median household income (real)", "US", "Social", "$", "level", +1),
    ("LNS11300002", "Women's labor-force participation", "US", "Social", "%", "level", +1),
    ("POPTHM", "Population growth", "US", "Demographic", "%", "yoy", 0),
    ("TXUR", "Unemployment", "TX", "Social", "%", "level", -1),
    ("TXNA", "Job growth", "TX", "Economic", "%", "yoy", +1),
    ("TXRGSP", "Real GDP growth", "TX", "Economic", "%", "yoy", +1),
    ("TXPOP", "Population growth", "TX", "Demographic", "%", "yoy", 0),
    ("MEHOINUSTXA672N", "Median household income", "TX", "Social", "$", "level", +1),
    ("TXSTHPI", "Home prices", "TX", "Social", "%", "yoy", -1),
]
WB_COUNTRIES = ["USA", "CHN", "DEU", "JPN", "IND", "MEX", "WLD"]
WB = [
    ("NY.GDP.MKTP.CD", "GDP (US$)", "Economic"),
    ("FP.CPI.TOTL.ZG", "Inflation, consumer prices (%)", "Economic"),
    ("SP.URB.TOTL.IN.ZS", "Urbanization (%)", "Economic"),
    ("SP.DYN.TFRT.IN", "Fertility rate (births per woman)", "Demographic"),
    ("SP.POP.TOTL", "Total population", "Demographic"),
    ("SP.DYN.LE00.IN", "Life expectancy at birth (years)", "Demographic"),
    ("SP.DYN.CDRT.IN", "Crude death rate (per 1,000)", "Demographic"),
    ("SL.TLF.CACT.FE.ZS", "Female labor force participation (%)", "Social"),
    ("SL.UEM.TOTL.ZS", "Unemployment (% of labor force)", "Social"),
    ("SE.ADT.LITR.ZS", "Literacy rate (%)", "Social"),
]
HDR_URL = "https://hdr.undp.org/sites/default/files/2025_HDR/HDR25_Composite_indices_complete_time_series.csv"


def get(url, tries=3):
    for k in range(tries):
        try:  # curl first (works everywhere we run); urllib as the fallback
            out = subprocess.run(["curl", "-sfL", "-m", "60", url],
                                 capture_output=True, check=True).stdout.decode("utf-8", "replace")
            if out:
                return out
        except Exception:
            pass
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/8.7.1"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception:
            time.sleep(2 * (k + 1))
    raise RuntimeError("fetch failed: " + url)


def fred(sid):
    rows = list(csv.reader(io.StringIO(get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={sid}&cosd=1990-01-01"))))
    out = []
    for r in rows[1:]:
        try:
            out.append((r[0], float(r[1])))
        except (ValueError, IndexError):
            pass
    return out


def yoy(obs):
    by = dict(obs)
    out = []
    for d, v in obs:
        prev = f"{int(d[:4]) - 1}{d[4:]}"
        if prev in by and by[prev]:
            out.append((d, round((v / by[prev] - 1) * 100, 3)))
    return out


def main():
    data = {"fetched": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "fred": {}, "wb": {}, "hdi": {}, "errors": []}
    for sid, label, region, cat, unit, tr, good in FRED:
        try:
            obs = fred(sid)
            if sid in ("DGS10", "MORTGAGE30US"):  # daily/weekly → monthly average keeps the file small
                m = {}
                for d, v in obs:
                    m.setdefault(d[:7], []).append(v)
                obs = [(k + "-01", round(sum(v) / len(v), 3)) for k, v in sorted(m.items())]
            series = yoy(obs) if tr == "yoy" else obs
            series = [(d, round(v, 4)) for d, v in series if d >= START]
            data["fred"][sid] = {"label": label, "region": region, "category": cat, "unit": unit, "transform": tr, "good": good, "obs": series}
            print(f"FRED {sid}: {len(series)} obs, last {series[-1] if series else None}")
        except Exception as e:
            data["errors"].append(f"FRED {sid}: {e}")
    # derived: interest / GDP
    try:
        i = dict(data["fred"]["A091RC1Q027SBEA"]["obs"]); g = dict(data["fred"]["GDP"]["obs"])
        obs = [(d, round(i[d] / g[d] * 100, 3)) for d in sorted(i) if d in g]
        data["fred"]["INT_GDP"] = {"label": "Federal interest / GDP", "region": "US", "category": "Fiscal", "unit": "%", "transform": "ratio", "good": -1, "obs": obs}
    except Exception as e:
        data["errors"].append(f"INT_GDP: {e}")
    for ind, label, cat in WB:
        try:
            j = json.loads(get(f"https://api.worldbank.org/v2/country/{';'.join(WB_COUNTRIES)}/indicator/{ind}?format=json&per_page=2000&date=1990:2026"))
            per = {}
            for r in j[1] or []:
                if r["value"] is not None:
                    per.setdefault(r["countryiso3code"], []).append((int(r["date"]), r["value"]))
            data["wb"][ind] = {"label": label, "category": cat, "series": {k: sorted(v) for k, v in per.items()}}
            print(f"WB {ind}: {', '.join(f'{k}:{v[-1]}' for k, v in per.items() if v)}")
        except Exception as e:
            data["errors"].append(f"WB {ind}: {e}")
    try:
        rows = list(csv.DictReader(io.StringIO(get(HDR_URL))))
        cols = sorted(k for k in rows[0] if k.startswith("hdi_") and k[4:].isdigit())
        for r in rows:
            if r["iso3"] in WB_COUNTRIES:
                data["hdi"][r["iso3"]] = [(int(c[4:]), float(r[c])) for c in cols if r[c] not in ("", None)]
        print("HDI", {k: v[-1] for k, v in data["hdi"].items()})
    except Exception as e:
        data["errors"].append(f"HDI: {e}")
    with open(OUT, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    print("wrote", OUT, os.path.getsize(OUT), "bytes;", len(data["errors"]), "errors", data["errors"])
    return 0 if len(data["fred"]) > 10 else 1


if __name__ == "__main__":
    sys.exit(main())
