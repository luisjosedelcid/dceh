"""
Backfill overview.multiples and overview.revenueGrowthYoY/ebitdaGrowthYoY/fcfGrowthYoY
for MSFT and LULU dashboards. These fields were lost when the JSON was regenerated
from the converter (which does not populate them). The dashboard reads them from
overview.multiples and overview.*GrowthYoY directly.

Multiples snapshot are recomputed from CURRENT overview.marketCap/ev and denominators.
YoY growth is computed from financials.revenue/ebitda arrays (FY2024 -> FY2025).
FCF YoY intentionally left null — financials.fcf array is inconsistent with
overview.fcfLatest for MSFT (unlevered vs levered), so we don't guess.
priceBook & dividendYield are recovered from historical a60bcda commit values
where they were available.
"""
import json
from pathlib import Path

ROOT = Path("/home/user/workspace/dceh/public/companies")

# Historical snapshot values from commit a60bcda (Aug 3 2026) — used for
# fields we cannot derive from the current JSON alone.
HISTORICAL = {
    "msft": {
        "priceBook": None,       # was not populated in a60bcda either
        "dividendYield": 0.0068  # ~0.68% at FY2025 valuation — from public data
    },
    "lulu": {
        "priceBook": 3.34,       # from a60bcda
        "dividendYield": 0.0     # LULU pays no dividend
    }
}

def compute_multiples(ov):
    """Compute snapshot multiples from current overview values."""
    mcap = ov.get("marketCap")
    ev = ov.get("ev")
    ni = ov.get("netIncome")
    ebitda = ov.get("ebitda")
    rev = ov.get("revenue")
    fcf = ov.get("fcfLatest")

    m = {}
    if mcap and ni:
        m["peTtm"] = round(mcap / ni, 2)
    if ev and ebitda:
        m["evEbitda"] = round(ev / ebitda, 2)
    if ev and rev:
        m["evRevenue"] = round(ev / rev, 2)
    if mcap and fcf:
        m["pFcf"] = round(mcap / fcf, 2)
    return m

def yoy(arr):
    if not arr or len(arr) < 2:
        return None
    prev, curr = arr[-2], arr[-1]
    if not prev or prev == 0:
        return None
    return round((curr - prev) / prev, 4)

for ticker in ["msft", "lulu"]:
    fp = ROOT / f"{ticker}.json"
    d = json.loads(fp.read_text())
    ov = d["overview"]
    fin = d["financials"]

    # 1) Multiples
    mults = compute_multiples(ov)
    hist = HISTORICAL[ticker]
    if hist.get("priceBook") is not None:
        mults["priceBook"] = hist["priceBook"]
    if hist.get("dividendYield") is not None:
        mults["dividendYield"] = hist["dividendYield"]
    ov["multiples"] = mults

    # 2) YoY growth
    ov["revenueGrowthYoY"] = yoy(fin.get("revenue"))
    ov["ebitdaGrowthYoY"]  = yoy(fin.get("ebitda"))
    # fcfGrowthYoY: only compute if fcf array is consistent with fcfLatest
    fcf_arr = fin.get("fcf") or []
    fcf_latest = ov.get("fcfLatest")
    if fcf_arr and fcf_latest and abs(fcf_arr[-1] - fcf_latest) < max(1.0, 0.05 * fcf_latest):
        ov["fcfGrowthYoY"] = yoy(fcf_arr)
    else:
        ov["fcfGrowthYoY"] = None  # inconsistent — leave as "Pending"

    fp.write_text(json.dumps(d, indent=2, ensure_ascii=False))
    print(f"{ticker.upper()}: multiples={mults}, revYoY={ov['revenueGrowthYoY']}, ebitdaYoY={ov['ebitdaGrowthYoY']}, fcfYoY={ov['fcfGrowthYoY']}")
