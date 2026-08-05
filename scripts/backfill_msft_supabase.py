"""
Fix the MSFT dashboard row in Supabase.

Regression: MSFT LTM_2026Q3 (is_latest=true) and FY2025 (historical) are both
missing overview.multiples, overview.*GrowthYoY, and several overview fields
that the Company page renders as "—" (businessModel, fiscalYearEnd, sector,
operatingIncome, cfo, capex, epsDiluted, da, sbc).

We derive as many of those as possible from the JSON already stored in Supabase
(isRows / cfRows / arrays), plus known company constants (business model, HQ,
CEO, sector, FY end).

The row is updated in-place via Supabase MCP execute_sql; no schema change.
"""
import json, os, subprocess, sys

MSFT_CONSTANTS = {
    "sector":       "Software & Cloud Infrastructure",
    "businessModel":"Enterprise software + Cloud (Azure) + Productivity (Microsoft 365) + Gaming + Advertising",
    "fiscalYearEnd":"June 30",
    # Snapshot only — dividendYield fluctuates with price. 0.68% approx at FY2025.
    "dividendYield": 0.0068,
}

def yoy(arr):
    if not arr or len(arr) < 2: return None
    prev, curr = arr[-2], arr[-1]
    if not prev or prev == 0: return None
    return round((curr - prev) / prev, 4)

def build_patch_for_row(ov, fin, is_ltm):
    """Return the JSON merge patch to apply to dashboard_json."""
    # --- Multiples (snapshot) ---
    mcap = ov["marketCap"]; ev = ov["ev"]
    ni = ov["netIncome"]; ebitda = ov["ebitda"]; rev = ov["revenue"]; fcf = ov["fcfLatest"]
    mult = {}
    if mcap and ni: mult["peTtm"] = round(mcap / ni, 2)
    if ev and ebitda: mult["evEbitda"] = round(ev / ebitda, 2)
    if ev and rev: mult["evRevenue"] = round(ev / rev, 2)
    if mcap and fcf: mult["pFcf"] = round(mcap / fcf, 2)
    mult["dividendYield"] = MSFT_CONSTANTS["dividendYield"]
    # priceBook left absent (no book value in current schema)

    # --- YoY growth from arrays ---
    rev_yoy = yoy(fin.get("revenue"))
    ebitda_yoy = yoy(fin.get("ebitda"))
    # fcf array is INCONSISTENT with overview.fcfLatest for MSFT (mixes CFO in some
    # cells because the Columbia Excel CapEx column is broken). Do NOT compute
    # fcfGrowthYoY — leave as null so the dashboard shows "Pending".

    # --- Overview additions ---
    ov_patch = {
        "multiples":        mult,
        "revenueGrowthYoY": rev_yoy,
        "ebitdaGrowthYoY":  ebitda_yoy,
        "fcfGrowthYoY":     None,
        "sector":           MSFT_CONSTANTS["sector"],
        "businessModel":    MSFT_CONSTANTS["businessModel"],
        "fiscalYearEnd":    MSFT_CONSTANTS["fiscalYearEnd"],
    }

    # --- Financial line items pulled from arrays / isRows / cfRows ---
    # These are read directly from Supabase per-row (last element of each array).
    # Caller passes the derived leaf values in `fin` under _tail_ keys.
    tail = fin["_tails"]
    ov_patch["operatingIncome"] = tail.get("operIncome")
    ov_patch["cfo"]             = tail.get("cfo")
    ov_patch["epsDiluted"]      = tail.get("epsDiluted")
    ov_patch["da"]              = tail.get("da")
    # capex and sbc: Columbia Excel is broken/empty for MSFT. Explicit null
    # is better than a wrong number — dashboard will render "—".
    ov_patch["capex"] = None
    ov_patch["sbc"]   = None

    return ov_patch

if __name__ == "__main__":
    # Called from a Supabase execute_sql wrapper; prints JSON patches for both rows.
    # Data comes from the two queries already run interactively.

    # LTM_2026Q3 row
    ov_ltm = {
        "marketCap": 3085506, "ev": 3081680, "netIncome": 125216, "ebitda": 192586,
        "revenue": 318273, "fcfLatest": 72916,
    }
    fin_ltm = {
        "revenue": [168088, 198270, 211915, 245122, 281724, 318273],
        "ebitda":  [90632, 107895, 115870, 138943, 160828, 183351],
        "_tails": {"operIncome": 148957, "cfo": 331047, "epsDiluted": 16.82,
                   "da": 34394},
    }
    patch_ltm = build_patch_for_row(ov_ltm, fin_ltm, is_ltm=True)
    print("LTM_2026Q3 patch:")
    print(json.dumps(patch_ltm, indent=2))
