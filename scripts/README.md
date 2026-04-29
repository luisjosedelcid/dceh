# DCE Sector Screener — Add a New Sector

The Sector Screener tab on `/screener` reads from JSON files in
`public/data/sectors/`. Adding a new sector is a 3-step workflow.

## Files at play

```
public/data/sectors/
├── index.json          # registry — UI auto-builds tabs from this
├── car-parts.json      # one file per sector, named after its slug
└── <new-sector>.json   # drop new sectors here
```

`index.json` shape:
```json
{
  "sectors": [
    { "slug": "car-parts", "name": "Car Parts", "generated_at": "2026-03-04", "tickers": 10 }
  ]
}
```

Per-sector JSON shape (per ticker):
```json
{
  "ticker": "NVDA",
  "name": "NVIDIA",
  "summary":           { "q_abs": …, "q_rel": …, "quality": …, "q_delta": …, "v_abs": …, "v_rel": …, "valuation": …, "irr": …, "verdict": "DEEP DIVE", "score_10": 8.4 },
  "quality_metrics":   { "roic_3yr": …, "roic_trend": …, "gm_cv": …, "op_margin": …, "fcf_conv": …, "rev_cagr_5y": …, "eps_cagr_5y": …, "fcfps_cagr_5y": …, "nd_ebitda": …, "gw_pct_ta": …, "capex_rev": …, "fcf_cv": … },
  "valuation_metrics": { "ev_ebit": …, "pe": …, "ev_ebitda": …, "fcf_yield": …, "earn_yield": …, "ey_spread": …, "peg": …, "base_irr": …, "full_irr": …, "mkt_cap_m": … }
}
```

> All ratio / yield / margin fields are **decimals**, not percentages
> (e.g. `0.215` for 21.5%). The UI multiplies by 100 when rendering.
> EV/EBIT, P/E, EV/EBITDA, ND/EBITDA, PEG, FCF Conv are raw multiples.
> `mkt_cap_m` is **millions of USD**.

## Workflow — local command

### 0. Prerequisites

```bash
python3 -m pip install requests
export ROIC_AI_KEY=your_roic_ai_key   # one-time per shell
```

### 1. Run the screener

**From a manual ticker list:**
```bash
python scripts/run_sector_screener.py \
    --slug semiconductors --name "Semiconductors" \
    --tickers NVDA,AMD,AVGO,TSM,INTC,QCOM
```

**From a roic.ai CSV export** (a column named `Name` with full company names):
```bash
python scripts/run_sector_screener.py \
    --slug pharma --name "Pharma" \
    --csv ~/Downloads/pharma_screen.csv
```

The script:
1. Pulls fundamentals for every ticker via the roic.ai API
2. Pulls the 10Y Treasury rate from FRED (used for the EY-Spread metric)
3. Scores Quality (15 metrics, weighted /5), Valuation (6 metrics, growth-adjusted /5)
4. Computes **Absolute** + **Relative** (z-score within batch) and blends 70/30
5. Computes IRR with capped multiple reversion (±5%)
6. Assigns a verdict: `DEEP DIVE` / `WATCHLIST` / `REVIEW` / `PASS`
7. Writes `public/data/sectors/<slug>.json` and registers the sector in `index.json`

### 2. Verify locally (optional)

Open `index.json` and the new sector JSON, sanity-check a few values.

### 3. Commit and push

```bash
git -c user.email="luis@dceholdings.com" -c user.name="Luis del Cid" \
    add public/data/sectors/

git -c user.email="luis@dceholdings.com" -c user.name="Luis del Cid" \
    commit -m "feat(screener): add <Sector Name> sector"

git push origin main
```

Vercel auto-deploys. Within ~30s the new tab will show up on
[/screener](https://www.dceholdings.app/screener) — no UI code changes needed.

## API key — local only

The roic.ai key never leaves your machine. The script reads it from the
`ROIC_AI_KEY` env var (or `--api-key`). It is **not** stored in the repo
or in Vercel. The deployed site only reads the static JSON outputs.

## Methodology summary

- **Quality (weighted, /5)**: ROIC 3yr (w=3), ROIC trend (w=2), GM CV (w=2),
  Op Margin (w=2), FCF Conv = FCF/NOPAT (w=3), Inc Op Margin (w=2),
  SBC/FCF (w=1), Rev CAGR 5y (w=2), EPS CAGR 5y (w=2), FCF/sh CAGR (w=2),
  ND/EBITDA (w=2), Goodwill % TA (w=1), Capex/Rev (w=1), Sh Return (w=1),
  Payout (w=1).
- **Valuation (growth-adjusted, /5)**: EV/EBIT (w=3), P/E (w=2),
  EV/EBITDA (w=1), FCF Yield (w=3), EY Spread vs T10 (w=3),
  PEG (w=2 normal, w=3 if high-growth).
- **High-growth flag**: Rev CAGR 5y > 10% → relaxed valuation thresholds.
- **IRR**: Base = FCF Yield + FCF/sh CAGR. Full = Base + capped multiple reversion (±5%).
- **Verdict**:
  - Q ≥ 4.0 & V ≥ 3.5 → `DEEP DIVE`
  - Q ≥ 4.0 & V <  3.5 → `WATCHLIST`
  - Q <  4.0 & V ≥ 3.5 → `REVIEW`
  - else → `PASS`
- **Score /10** = Quality (blended) + Valuation (blended).

## Updating an existing sector

Run the same command with the same `--slug`. The JSON and the index entry
will be overwritten.

## Removing a sector

Delete the JSON file and the matching entry in `index.json`, then commit.
