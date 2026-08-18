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

## Implementation Notes

The server provides:

- `GET /api/defaults`
- `POST /api/simulate`

The browser UI is in `web/`. The server uses `data/PSD.csv`, `configs/default_v60.json`, and the D90-conditioned model helpers in `scripts/`.

This is a process simulator, not a recipe score or sensory predictor.
