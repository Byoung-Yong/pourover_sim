# Filter Coffee Web Simulator

This folder contains the interactive web-service version of the calibrated filter-coffee simulator.

It is intentionally separate from `../publiccode`, which contains manuscript reproduction scripts and data.

## Scope

The web app exposes practical inputs:

- grind size as mass-fraction D90
- coffee dose
- pour schedule
- simulation end time
- numerical grid

The current public UI enables V60 conical geometry only. The Kalita option is intentionally disabled until a separate Kalita geometry and outlet-resistance calibration is implemented.

## Run Locally

Use Python 3.10 or later.

```bash
pip install -r requirements.txt
python scripts/serve_web_simulator.py --host 127.0.0.1 --port 8765
```

Open:

```text
http://127.0.0.1:8765/
```

## Deploy on Vercel

Set the Vercel project root directory to this `webpage/` folder. The deployment uses:

- `vercel.json` to route `/` to `web/index.html`
- `api/defaults.py` for `GET /api/defaults`
- `api/simulate.py` for `POST /api/simulate`

## Implementation Notes

The server provides:

- `GET /api/defaults`
- `POST /api/simulate`

For water inventories, `bed_water_g` is the total water held in the coffee bed. It is the sum of `mobile_bed_water_g` (mobile pore water) and `immobile_retained_water_g` (immobile retained water). `retained_water_g` is retained as a backward-compatible alias of total `bed_water_g`.

The browser UI is in `web/`. The server uses `data/PSD.csv`, `configs/default_v60.json`, and the D90-conditioned model helpers in `scripts/`.

`data/PSD.csv` is the current manuscript PSD input copied from `../data_2/data2_volume_psd_mass_fraction.csv`. It is already a volume-PSD-derived mass-fraction table, so the web simulator reads it directly as mass fraction. No surface-area-to-mass conversion is applied.

The D90-conditioned coefficients use the current manuscript anchors:

- fine: D90 = 592.06 um
- medium: D90 = 1010.10 um
- coarse: D90 = 1814.61 um

Intermediate D90 inputs are handled by log-space interpolation of the measured PSD classes and piecewise log-linear interpolation of the calibrated D90 closure coefficients.

This is a process simulator, not a recipe score or sensory predictor.
