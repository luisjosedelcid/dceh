#!/usr/bin/env python3
"""
DCE Holdings — Sector Screener (non-Colab JSON edition)

Adapted from DCE_Sector_Screen_v3.py. Outputs a JSON file directly into
public/data/sectors/<slug>.json and updates public/data/sectors/index.json
so the new sector is picked up by /screener.html automatically.

USAGE
─────
  # Manual ticker list:
  python scripts/run_sector_screener.py \
      --slug semiconductors --name "Semiconductors" \
      --tickers NVDA,AMD,AVGO,TSM \
      --api-key YOUR_ROIC_AI_KEY

  # From a roic.ai CSV export (column "Name"):
  python scripts/run_sector_screener.py \
      --slug pharma --name "Pharma" \
      --csv ~/Downloads/pharma.csv \
      --api-key YOUR_ROIC_AI_KEY

  # Reuse env var instead of --api-key flag:
  export ROIC_AI_KEY=...
  python scripts/run_sector_screener.py --slug ... --tickers ...

OUTPUT
──────
  public/data/sectors/<slug>.json    — full per-ticker payload
  public/data/sectors/index.json     — registry consumed by the UI

Notes
─────
• Methodology is identical to v3 (Quality 15 metrics, growth-adjusted
  Valuation, IRR with capped multiple reversion, verdict thresholds).
• Score /10 = quality + valuation (each on /5 scale → sum is on /10).
• 70/30 blend (Absolute / Relative) — Absolute = score from this script,
  Relative = z-score within the sector batch (matches v4 logic).
"""
from __future__ import annotations
import argparse
import csv
import io
import json
import os
import statistics
import sys
import time
from datetime import date
from pathlib import Path

import requests

# ── Paths ─────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
SECTORS_DIR = ROOT / "public" / "data" / "sectors"
INDEX_PATH = SECTORS_DIR / "index.json"

# ── Config (matches v3 / v4) ──────────────────────────────────────────
HURDLE_RATE = 0.12
QUALITY_WEIGHT_BIAS = 1.0
VALUATION_WEIGHT_BIAS = 1.0
GROWTH_THRESHOLD = 0.10
IRR_MULT_REV_CAP = 0.05
BLEND_ABS = 0.70
BLEND_REL = 0.30
BASE_URL = "https://api.roic.ai/v2/fundamental"


# ─── HTTP helpers ─────────────────────────────────────────────────────
def fetch_t10() -> float:
    try:
        url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=2026-01-01"
        r = requests.get(url, timeout=15); r.raise_for_status()
        for line in reversed(r.text.strip().split("\n")):
            parts = line.split(",")
            if len(parts) == 2:
                try: return float(parts[1])
                except ValueError: continue
    except Exception as e:
        print(f"⚠ FRED T10 fetch failed: {e}", file=sys.stderr)
    return 4.30


def fetch_endpoint(endpoint: str, ticker: str, api_key: str):
    url = f"{BASE_URL}/{endpoint}/{ticker}?apikey={api_key}"
    r = requests.get(url, timeout=30); r.raise_for_status()
    data = r.json()
    if isinstance(data, list):
        data.sort(key=lambda x: int(x.get("fiscal_year", 0)))
    return data


def fetch_price(ticker: str, api_key: str):
    try:
        r = requests.get(
            f"https://api.roic.ai/v2/stock-prices/latest/{ticker}?apikey={api_key}",
            timeout=30,
        )
        r.raise_for_status()
        d = r.json()
        if isinstance(d, dict): return float(d.get("close", 0))
        if isinstance(d, list) and d: return float(d[0].get("close", 0))
    except Exception:
        return None
    return None


def fetch_all(ticker: str, api_key: str):
    try:
        return {
            "income":    fetch_endpoint("income-statement", ticker, api_key),
            "balance":   fetch_endpoint("balance-sheet", ticker, api_key),
            "cashflow":  fetch_endpoint("cash-flow", ticker, api_key),
            "ratios":    fetch_endpoint("ratios/profitability", ticker, api_key),
            "credit":    fetch_endpoint("ratios/credit", ticker, api_key),
            "multiples": fetch_endpoint("multiples", ticker, api_key),
            "ev":        fetch_endpoint("enterprise-value", ticker, api_key),
            "price":     fetch_price(ticker, api_key),
        }
    except Exception as e:
        print(f"  ❌ {ticker}: {e}", file=sys.stderr)
        return None


# ─── Stat helpers ─────────────────────────────────────────────────────
def sg(recs, key, idx=-1):
    try:
        v = recs[idx].get(key); return float(v) if v is not None else None
    except Exception: return None


def ss(recs, key):
    out = []
    for r in recs:
        x = r.get(key)
        if x is not None:
            try: out.append(float(x))
            except (TypeError, ValueError): pass
    return out


def avg_last_n(recs, key, n=3):
    vals = ss(recs, key)
    if len(vals) >= n: return statistics.mean(vals[-n:])
    if vals: return statistics.mean(vals)
    return None


def cagr(f, l, y):
    if f and l and y > 0 and f > 0 and l > 0:
        return (l / f) ** (1.0 / y) - 1.0
    return None


def trend_(s):
    if len(s) < 6: return None
    a = statistics.mean(s[:3]); b = statistics.mean(s[-3:])
    return (b - a) / abs(a) if a != 0 else None


def coefvar(s):
    if len(s) < 3: return None
    m = statistics.mean(s)
    return statistics.stdev(s) / abs(m) if m != 0 else None


def calc_nopat(inc, idx=-1):
    op_inc = sg(inc, "is_oper_income", idx)
    pretax = sg(inc, "is_pretax_income", idx)
    tax_exp = sg(inc, "is_inc_tax_exp", idx)
    if op_inc is not None and pretax and tax_exp is not None and pretax != 0:
        eff = tax_exp / pretax
        if 0 <= eff <= 0.5:
            return op_inc * (1 - eff)
    return sg(inc, "is_net_income", idx)


# ─── Scoring (v3 logic, abridged but faithful) ────────────────────────
def score_ticker(d, t10):
    inc, bal, cf = d["income"], d["balance"], d["cashflow"]
    rat, mult, ev = d["ratios"], d["multiples"], d["ev"]
    r = {"price": d["price"]}

    # === QUALITY ===
    qs = qw = 0
    def q(score, w):
        nonlocal qs, qw
        ww = w * QUALITY_WEIGHT_BIAS
        if score is not None: qs += score * ww; qw += ww

    roic_avg = avg_last_n(rat, "return_on_inv_capital", 3)
    r["roic_3yr"] = (roic_avg / 100.0) if roic_avg is not None else None
    s = None
    if roic_avg: s = 5 if roic_avg > 25 else (4 if roic_avg > 15 else (3 if roic_avg > 10 else (2 if roic_avg > 7 else 1)))
    q(s, 3)

    rt = trend_(ss(rat, "return_on_inv_capital")); r["roic_trend"] = rt
    s = None
    if rt is not None: s = 5 if rt > 0.1 else (4 if rt > 0 else (3 if rt > -0.1 else 1))
    q(s, 2)

    gcv = coefvar(ss(rat, "gross_margin")); r["gm_cv"] = gcv
    s = None
    if gcv is not None: s = 5 if gcv < 0.05 else (4 if gcv < 0.10 else (3 if gcv < 0.15 else 2))
    q(s, 2)

    om = sg(rat, "oper_margin"); r["op_margin"] = (om / 100.0) if om else None
    s = None
    if om: s = 5 if om > 25 else (4 if om > 15 else (3 if om > 10 else (2 if om > 5 else 1)))
    q(s, 2)

    # FCF / NOPAT (3yr avg)
    fcv = []
    for i in range(-3, 0):
        f = sg(cf, "cf_free_cash_flow", i); n = calc_nopat(inc, i)
        if f and n and n != 0: fcv.append(f / n)
    fc = statistics.mean(fcv) if fcv else None; r["fcf_conv"] = fc
    s = None
    if fc: s = 5 if fc > 1.0 else (4 if fc > 0.8 else (3 if fc > 0.6 else 2))
    q(s, 3)

    iom = sg(rat, "incremental_operating_margin")
    s = None
    if iom is not None: s = 5 if iom > 40 else (4 if iom > 25 else (3 if iom > 15 else (2 if iom > 0 else 1)))
    q(s, 2)

    sbc = sg(cf, "cf_stock_based_compensation"); fcfl = sg(cf, "cf_free_cash_flow")
    sp = (sbc / fcfl * 100) if sbc and fcfl and fcfl != 0 else None
    s = None
    if sp is not None: s = 5 if sp < 5 else (4 if sp < 10 else (3 if sp < 20 else 1))
    q(s, 1)

    rs = ss(inc, "is_sales_revenue_turnover")
    r5 = cagr(rs[-6], rs[-1], 5) if len(rs) >= 6 else None; r["rev_cagr_5y"] = r5
    s = None
    if r5: s = 5 if r5 > 0.15 else (4 if r5 > 0.08 else (3 if r5 > 0.03 else (2 if r5 > 0 else 1)))
    q(s, 2)

    es = ss(inc, "diluted_eps")
    e5 = cagr(es[-6], es[-1], 5) if len(es) >= 6 else None; r["eps_cagr_5y"] = e5
    s = None
    if e5: s = 5 if e5 > 0.15 else (4 if e5 > 0.08 else (3 if e5 > 0.03 else (2 if e5 > 0 else 1)))
    q(s, 2)

    fs = ss(cf, "free_cash_flow_per_sh")
    f5 = cagr(fs[-6], fs[-1], 5) if len(fs) >= 6 else None; r["fcfps_cagr_5y"] = f5
    s = None
    if f5: s = 5 if f5 > 0.15 else (4 if f5 > 0.08 else (3 if f5 > 0.03 else 2))
    q(s, 2)

    nd = sg(bal, "net_debt"); ebl = sg(inc, "ebitda")
    nde = nd / ebl if nd is not None and ebl and ebl != 0 else None; r["nd_ebitda"] = nde
    s = None
    if nde is not None: s = 5 if nde < 1 else (4 if nde < 2 else (3 if nde < 3 else 1))
    q(s, 2)

    gw = sg(bal, "bs_goodwill"); ta = sg(bal, "bs_tot_asset")
    gwp = (gw / ta * 100) if gw and ta and ta != 0 else None
    r["gw_pct_ta"] = (gwp / 100.0) if gwp is not None else None
    s = None
    if gwp is not None: s = 5 if gwp < 5 else (4 if gwp < 15 else (3 if gwp < 30 else 1))
    q(s, 1)

    crv = []
    for i in range(-3, 0):
        cx = sg(cf, "cf_cap_expenditures", i); rv = sg(inc, "is_sales_revenue_turnover", i)
        if cx and rv and rv != 0: crv.append(abs(cx) / rv * 100)
    cr = statistics.mean(crv) if crv else None
    r["capex_rev"] = (cr / 100.0) if cr else None
    s = None
    if cr: s = 5 if cr < 3 else (4 if cr < 6 else (3 if cr < 10 else 2))
    q(s, 1)

    fcf_series = ss(cf, "cf_free_cash_flow")
    r["fcf_cv"] = coefvar(fcf_series)

    bb = sg(cf, "cf_decr_cap_stock"); dv = sg(cf, "cf_dvd_paid"); nil = sg(inc, "is_net_income")
    tr = abs(bb or 0) + abs(dv or 0)
    rp = (tr / nil * 100) if nil and nil != 0 else None
    s = None
    if rp: s = 4 if rp > 50 else (3 if rp > 30 else 2)
    q(s, 1)

    po = sg(rat, "dvd_payout_ratio")
    s = None
    if po is not None: s = 5 if 10 < po < 40 else (4 if po < 60 else (3 if po < 80 else 2))
    q(s, 1)

    quality = qs / qw if qw > 0 else None
    r["quality"] = quality

    # === VALUATION ===
    vs = vw = 0
    def v(score, w):
        nonlocal vs, vw
        ww = w * VALUATION_WEIGHT_BIAS
        if score is not None: vs += score * ww; vw += ww

    is_hg = r5 is not None and r5 > GROWTH_THRESHOLD

    eve = sg(mult, "ev_to_ttm_ebit"); r["ev_ebit"] = eve
    s = None
    if eve:
        if is_hg: s = 5 if eve < 18 else (4 if eve < 25 else (3 if eve < 35 else (2 if eve < 45 else 1)))
        else:     s = 5 if eve < 12 else (4 if eve < 18 else (3 if eve < 25 else (2 if eve < 35 else 1)))
    v(s, 3)

    pe = sg(mult, "pe_ratio"); r["pe"] = pe
    s = None
    if pe:
        if is_hg: s = 5 if pe < 20 else (4 if pe < 30 else (3 if pe < 40 else (2 if pe < 50 else 1)))
        else:     s = 5 if pe < 15 else (4 if pe < 20 else (3 if pe < 30 else (2 if pe < 40 else 1)))
    v(s, 2)

    eveb = sg(mult, "ev_to_ttm_ebitda"); r["ev_ebitda"] = eveb
    s = None
    if eveb:
        if is_hg: s = 5 if eveb < 12 else (4 if eveb < 18 else (3 if eveb < 25 else (2 if eveb < 35 else 1)))
        else:     s = 5 if eveb <  8 else (4 if eveb < 12 else (3 if eveb < 18 else (2 if eveb < 25 else 1)))
    v(s, 1)

    mc = sg(ev, "market_cap"); tfcf = sg(ev, "ttm_free_cash_flow_firm")
    fy = (tfcf / mc * 100) if tfcf and mc and mc != 0 else None
    r["fcf_yield"] = (fy / 100.0) if fy is not None else None
    s = None
    if fy: s = 5 if fy > 6 else (4 if fy > 4 else (3 if fy > 2.5 else (2 if fy > 1.5 else 1)))
    v(s, 3)

    evv = sg(ev, "enterprise_value"); ebit_ = sg(inc, "is_oper_income")
    ey = (ebit_ / evv * 100) if ebit_ and evv and evv != 0 else None
    r["earn_yield"] = (ey / 100.0) if ey is not None else None
    spr = (ey - t10) if ey is not None else None
    r["ey_spread"] = (spr / 100.0) if spr is not None else None
    s = None
    if spr is not None: s = 5 if spr > 3 else (4 if spr > 1.5 else (3 if spr > 0 else (2 if spr > -1.5 else 1)))
    v(s, 3)

    peg_w = 3 if is_hg else 2
    if pe and e5 and e5 > 0:
        peg = pe / (e5 * 100); r["peg"] = peg
        s = 5 if peg < 1.0 else (4 if peg < 1.5 else (3 if peg < 2.0 else (2 if peg < 3.0 else 1)))
        v(s, peg_w)
    else:
        r["peg"] = None

    valuation = vs / vw if vw > 0 else None
    r["valuation"] = valuation

    # === IRR ===
    fcf_yield_irr = (fy / 100) if fy else None
    base = (fcf_yield_irr + f5) if (fcf_yield_irr is not None and f5 is not None) else None
    r["base_irr"] = base
    pe_s = ss(mult, "pe_ratio")
    pe_avg = statistics.mean(pe_s[-5:]) if len(pe_s) >= 5 else None
    mr_raw = ((pe_avg / pe) ** (1 / 5)) - 1 if (pe and pe_avg and pe_avg > 0) else None
    mr = max(-IRR_MULT_REV_CAP, min(IRR_MULT_REV_CAP, mr_raw)) if mr_raw is not None else None
    full = (base + mr) if (base is not None and mr is not None) else base
    r["full_irr"] = full

    r["mkt_cap_m"] = (mc / 1e6) if mc else None

    # Verdict (Q ≥ 4 & V ≥ 3.5 → DEEP DIVE; Q ≥ 4 & V<3.5 → WATCHLIST; Q<4 & V≥3.5 → REVIEW; else PASS)
    qa, va = quality, valuation
    if qa is not None and va is not None:
        if qa >= 4.0 and va >= 3.5: verdict = "DEEP DIVE"
        elif qa >= 4.0 and va < 3.5: verdict = "WATCHLIST"
        elif qa < 4.0 and va >= 3.5: verdict = "REVIEW"
        else: verdict = "PASS"
    else:
        verdict = "N/A"
    r["verdict"] = verdict
    return r


# ─── Relative blending (z-score within batch) ─────────────────────────
def zscores(values):
    clean = [v for v in values if v is not None]
    if len(clean) < 2: return [None] * len(values)
    mu = statistics.mean(clean); sd = statistics.pstdev(clean) or 1.0
    return [((v - mu) / sd) if v is not None else None for v in values]


def to_5pt(z):
    if z is None: return None
    # Map z in [-2, +2] → [1, 5]
    return max(1.0, min(5.0, 3.0 + z))


def build_payload(slug, name, results, t10):
    qualities = [r["quality"] for r in results]
    valuations = [r["valuation"] for r in results]
    qz = zscores(qualities); vz = zscores(valuations)

    tickers_out = []
    for i, r in enumerate(results):
        q_abs = r["quality"]; v_abs = r["valuation"]
        q_rel = to_5pt(qz[i]); v_rel = to_5pt(vz[i])
        quality_blend   = (BLEND_ABS * q_abs + BLEND_REL * q_rel) if (q_abs is not None and q_rel is not None) else q_abs
        valuation_blend = (BLEND_ABS * v_abs + BLEND_REL * v_rel) if (v_abs is not None and v_rel is not None) else v_abs
        q_delta = (quality_blend - q_abs) if (quality_blend is not None and q_abs is not None) else None
        score10 = round((quality_blend or 0) + (valuation_blend or 0), 2)

        tickers_out.append({
            "ticker": r["ticker"],
            "name":   r.get("name", r["ticker"]),
            "summary": {
                "q_abs": q_abs, "q_rel": q_rel, "quality": quality_blend,
                "q_delta": q_delta,
                "v_abs": v_abs, "v_rel": v_rel, "valuation": valuation_blend,
                "irr": r.get("full_irr"),
                "verdict": r.get("verdict"),
                "score_10": score10,
            },
            "quality_metrics": {
                "roic_3yr": r.get("roic_3yr"), "roic_trend": r.get("roic_trend"),
                "gm_cv": r.get("gm_cv"), "op_margin": r.get("op_margin"),
                "fcf_conv": r.get("fcf_conv"),
                "rev_cagr_5y": r.get("rev_cagr_5y"), "eps_cagr_5y": r.get("eps_cagr_5y"),
                "fcfps_cagr_5y": r.get("fcfps_cagr_5y"),
                "nd_ebitda": r.get("nd_ebitda"), "gw_pct_ta": r.get("gw_pct_ta"),
                "capex_rev": r.get("capex_rev"), "fcf_cv": r.get("fcf_cv"),
            },
            "valuation_metrics": {
                "ev_ebit": r.get("ev_ebit"), "pe": r.get("pe"),
                "ev_ebitda": r.get("ev_ebitda"),
                "fcf_yield": r.get("fcf_yield"), "earn_yield": r.get("earn_yield"),
                "ey_spread": r.get("ey_spread"), "peg": r.get("peg"),
                "base_irr": r.get("base_irr"), "full_irr": r.get("full_irr"),
                "mkt_cap_m": r.get("mkt_cap_m"),
            },
        })

    # Sort by score_10 desc
    tickers_out.sort(key=lambda x: x["summary"]["score_10"] or 0, reverse=True)

    return {
        "slug": slug,
        "name": name,
        "generated_at": date.today().isoformat(),
        "source": "roic.ai API (DCE Sector Screener)",
        "config": {
            "blend_absolute": BLEND_ABS,
            "blend_relative": BLEND_REL,
            "hurdle_rate":    HURDLE_RATE,
            "t10_rate":       round(t10 / 100.0, 4),
        },
        "tickers": tickers_out,
    }


# ─── Index registry ───────────────────────────────────────────────────
def update_index(slug, name, n_tickers):
    SECTORS_DIR.mkdir(parents=True, exist_ok=True)
    if INDEX_PATH.exists():
        with INDEX_PATH.open() as f: idx = json.load(f)
    else:
        idx = {"sectors": []}

    sectors = idx.get("sectors", [])
    sectors = [s for s in sectors if s.get("slug") != slug]
    sectors.append({
        "slug": slug,
        "name": name,
        "generated_at": date.today().isoformat(),
        "tickers": n_tickers,
    })
    sectors.sort(key=lambda s: s["name"].lower())
    idx["sectors"] = sectors
    with INDEX_PATH.open("w") as f: json.dump(idx, f, indent=2)
    print(f"📚 Updated index: {INDEX_PATH.relative_to(ROOT)}")


# ─── Ticker resolution from CSV ───────────────────────────────────────
def resolve_tickers_from_csv(csv_path: Path, api_key: str):
    out = []
    with csv_path.open(encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = (row.get("Name") or "").strip()
            if not name: continue
            term = name.split(",")[0].split("(")[0].strip()
            try:
                r = requests.get(
                    f"https://api.roic.ai/v2/company/search/{requests.utils.quote(term)}?apikey={api_key}",
                    timeout=15,
                )
                if r.ok:
                    data = r.json()
                    if isinstance(data, list) and data:
                        best = next(
                            (m for m in data if m.get("exchange", "").upper() in (
                                "NASDAQ", "NYSE", "NEW YORK STOCK EXCHANGE", "NASDAQ CAPITAL MARKET",
                                "NASDAQ GLOBAL SELECT", "NASDAQ GLOBAL MARKET", "NYQ", "NMS", "NGM",
                            )),
                            data[0],
                        )
                        tk = (best.get("ticker") or "").split(".")[0]
                        if tk and tk not in [t for t, _ in out]:
                            out.append((tk, name))
                            print(f"  ✓ {name} → {tk}")
                            continue
                print(f"  ✗ {name} → not resolved")
            except Exception as e:
                print(f"  ✗ {name} → {e}")
            time.sleep(0.2)
    return out


# ─── Main ─────────────────────────────────────────────────────────────
def main():
    p = argparse.ArgumentParser(description="DCE Sector Screener → JSON for /screener UI")
    p.add_argument("--slug", required=True, help="URL-safe slug (e.g. 'semiconductors')")
    p.add_argument("--name", required=True, help="Display name (e.g. 'Semiconductors')")
    p.add_argument("--tickers", help="Comma-separated tickers, e.g. NVDA,AMD,AVGO")
    p.add_argument("--csv", help="Path to roic.ai CSV export (column 'Name')")
    p.add_argument("--api-key", default=os.environ.get("ROIC_AI_KEY"),
                   help="roic.ai API key (or set ROIC_AI_KEY env var)")
    args = p.parse_args()

    if not args.api_key:
        sys.exit("❌ Missing API key. Use --api-key or export ROIC_AI_KEY=...")

    if not (args.tickers or args.csv):
        sys.exit("❌ Provide --tickers or --csv")

    SECTORS_DIR.mkdir(parents=True, exist_ok=True)

    # Resolve ticker list
    if args.csv:
        path = Path(args.csv).expanduser()
        if not path.exists(): sys.exit(f"❌ CSV not found: {path}")
        pairs = resolve_tickers_from_csv(path, args.api_key)
        ticker_pairs = pairs
    else:
        ticker_pairs = [(t.strip().upper(), t.strip().upper())
                        for t in args.tickers.split(",") if t.strip()]

    if not ticker_pairs:
        sys.exit("❌ No tickers to process")

    print(f"\n📊 Screening {len(ticker_pairs)} companies...\n")
    t10 = fetch_t10()
    print(f"📈 T10Y: {t10:.2f}%\n")

    results = []
    for i, (tk, nm) in enumerate(ticker_pairs):
        print(f"  [{i+1}/{len(ticker_pairs)}] {tk}...", end=" ", flush=True)
        d = fetch_all(tk, args.api_key)
        if d:
            try:
                row = score_ticker(d, t10)
                row["ticker"] = tk
                row["name"]   = nm
                results.append(row)
                q = row.get("quality") or 0; vv = row.get("valuation") or 0
                irr = row.get("full_irr"); irr_s = f"{irr*100:.1f}%" if irr is not None else "N/A"
                print(f"Q:{q:.1f} V:{vv:.1f} IRR:{irr_s} → {row['verdict']}")
            except Exception as e:
                print(f"⚠ scoring error: {e}")
        else:
            print("skipped")
        if i < len(ticker_pairs) - 1: time.sleep(0.3)

    if not results:
        sys.exit("❌ No results to write")

    payload = build_payload(args.slug, args.name, results, t10)

    out_path = SECTORS_DIR / f"{args.slug}.json"
    with out_path.open("w") as f:
        json.dump(payload, f, indent=2)
    print(f"\n✅ Wrote {out_path.relative_to(ROOT)}")

    update_index(args.slug, args.name, len(results))
    print(f"\n👉 Next: git add public/data/sectors/ && git commit && git push\n")


if __name__ == "__main__":
    main()
