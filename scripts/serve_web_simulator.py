"""Serve a small web UI for the calibrated filter-coffee simulator.

The server uses only the Python standard library for HTTP handling and calls
the current repository model directly. It does not alter calibration data or
governing equations.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from dataclasses import replace
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
SCRIPTS = ROOT / "scripts"
for path in (SRC, SCRIPTS):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from calibrated_v60_model import (  # noqa: E402
    D90_CLOSURE_FITS,
    HYDRAULIC_MASS_PERCENTILE,
)
from run_measured_psd_analysis import coarsen_mass_psd, mass_percentile_diameter_um  # noqa: E402
from v60_physics.parameters import (  # noqa: E402
    GeometryConfig,
    ModelConfig,
    PourSegment,
    Scenario,
    load_config,
)
from v60_physics.solver import run_simulation  # noqa: E402


WEB_DIR = ROOT / "web"
PSD_FILE = ROOT / "data" / "PSD.csv"
CONFIG_FILE = ROOT / "configs" / "default_v60.json"
PSD_CLASSES = ("fine", "medium", "coarse")
TARGET_CLASS_COUNT = 24

GEOMETRY_PRESETS = {
    "v60": {
        "label": "V60 conical",
        "bottom_radius_m": 0.008,
        "cone_half_angle_deg": 30.0,
    },
}

GRID_PRESETS = {
    "fast": {"label": "fast 16 x 4", "axial_layers": 16, "radial_bins": 4, "dt_s": 0.10},
    "standard": {"label": "standard 24 x 6", "axial_layers": 24, "radial_bins": 6, "dt_s": 0.05},
    "fine": {"label": "fine 48 x 12", "axial_layers": 48, "radial_bins": 12, "dt_s": 0.025},
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the calibrated coffee simulator web UI.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    handler = make_handler(WEB_DIR)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving simulator at http://{args.host}:{args.port}/")
    print("Press Ctrl+C to stop.")
    server.serve_forever()


def make_handler(web_dir: Path):
    class SimulatorHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(web_dir), **kwargs)

        def do_GET(self):  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/api/defaults":
                self._send_json(defaults_payload())
                return
            super().do_GET()

        def do_POST(self):  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path != "/api/simulate":
                self.send_error(HTTPStatus.NOT_FOUND, "Unknown endpoint")
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                response = simulate_from_payload(payload)
            except ValueError as exc:
                self._send_json({"ok": False, "error": str(exc)}, status=HTTPStatus.BAD_REQUEST)
                return
            except Exception as exc:  # pragma: no cover - defensive API boundary.
                self._send_json(
                    {"ok": False, "error": f"Simulation failed: {exc}"},
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )
                return
            self._send_json({"ok": True, **response})

        def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return SimulatorHandler


def defaults_payload() -> dict[str, object]:
    anchors = psd_anchor_d90_values()
    return {
        "d90_min_um": min(anchors.values()),
        "d90_max_um": max(anchors.values()),
        "d90_anchors_um": anchors,
        "geometry_presets": GEOMETRY_PRESETS,
        "grid_presets": GRID_PRESETS,
        "default_payload": {
            "d90_um": anchors["medium"],
            "coffee_dose_g": 20.0,
            "simulation_end_s": 300.0,
            "geometry": "v60",
            "grid": "standard",
            "pours": [
                {"start_s": 0.0, "end_s": 15.0, "water_g": 60.0},
                {"start_s": 30.0, "end_s": 70.0, "water_g": 120.0},
                {"start_s": 80.0, "end_s": 120.0, "water_g": 120.0},
            ],
        },
    }


def simulate_from_payload(payload: dict[str, object]) -> dict[str, object]:
    d90_um = finite_float(payload.get("d90_um"), "D90", minimum=1.0)
    coffee_dose_g = finite_float(payload.get("coffee_dose_g"), "Coffee dose", minimum=1.0)
    simulation_end_s = finite_float(
        payload.get("simulation_end_s", 700.0),
        "Simulation end",
        minimum=60.0,
        maximum=1800.0,
    )
    geometry_key = str(payload.get("geometry", "v60"))
    grid_key = str(payload.get("grid", "standard"))
    if geometry_key not in GEOMETRY_PRESETS:
        raise ValueError(f"Unknown geometry preset: {geometry_key}")
    if grid_key not in GRID_PRESETS:
        raise ValueError(f"Unknown grid preset: {grid_key}")
    pours = parse_pours(payload.get("pours"))
    if not pours:
        raise ValueError("At least one pour segment is required.")
    final_pour_end = max(segment.end_s for segment in pours)
    if simulation_end_s <= final_pour_end + 20.0:
        simulation_end_s = final_pour_end + 300.0

    anchors = psd_anchor_d90_values()
    min_d90 = min(anchors.values())
    max_d90 = max(anchors.values())
    if d90_um < min_d90 or d90_um > max_d90:
        raise ValueError(f"D90 must be within measured interpolation range {min_d90:.1f}-{max_d90:.1f} um.")

    scenario, interpolation = interpolated_scenario_for_d90(d90_um)
    config = config_for_request(coffee_dose_g, simulation_end_s, pours, geometry_key, grid_key, scenario)
    result = run_simulation(config, scenario.name)
    summary = result.summary
    coeff = coefficients_from_d90(d90_um)
    status = solver_status(summary)
    time_series = selected_time_series(result.timeseries)
    validation = validation_checks(summary, result.timeseries)
    return {
        "summary": {
            "solver_status": status,
            "coffee_dose_g": coffee_dose_g,
            "total_water_g": sum(segment.water_g for segment in pours),
            "brew_ratio_g_g": sum(segment.water_g for segment in pours) / coffee_dose_g,
            "d90_um": d90_um,
            "psd_interpolation": interpolation,
            "geometry": GEOMETRY_PRESETS[geometry_key]["label"],
            "outlet_factor": float(GEOMETRY_PRESETS[geometry_key].get("outlet_factor", 1.0)),
            "grid": GRID_PRESETS[grid_key]["label"],
            "cup_water_g": float(summary["cup_mass_g"]),
            "retained_water_g": float(summary["bed_water_g"]),
            "mobile_bed_water_g": float(summary["retained_pore_water_g"]),
            "immobile_retained_water_g": float(summary["retained_immobile_water_g"]),
            "pool_water_g": float(summary["pool_water_g"]),
            "drawdown_time_s": float(summary["drawdown_time_s"]),
            "tds_percent": float(summary["tds_percent"]),
            "extraction_yield_percent": float(summary["ey_percent"]),
            "cup_dissolved_solids_g": float(summary["cup_dissolved_solids_g"]),
            "bed_height_mm": float(summary["bed_height_mm"]),
            "porosity": float(summary["porosity"]),
            "permeability_m2": float(summary["permeability_m2"]),
            "max_water_balance_residual_g": float(summary["max_water_residual_abs_g"]),
            "max_dissolved_solids_balance_residual_g": float(summary["max_solids_residual_abs_g"]),
            "retained_water_capacity_g_g": coeff["retained_water_capacity_g_per_g_coffee"],
            "hydraulic_correction": coeff["hydraulic_correction_multiplier"],
            "diffusion_like_coefficient_s_1": coeff["diffusion_rate_ref_s_inv"],
            "surface_like_coefficient_s_1": coeff["surface_rate_ref_s_inv"],
        },
        "checks": validation,
        "time_series": time_series,
    }


def config_for_request(
    coffee_dose_g: float,
    simulation_end_s: float,
    pours: tuple[PourSegment, ...],
    geometry_key: str,
    grid_key: str,
    scenario: Scenario,
) -> ModelConfig:
    base = load_config(CONFIG_FILE)
    grid = GRID_PRESETS[grid_key]
    geom = GEOMETRY_PRESETS[geometry_key]
    coeff = coefficients_from_d90(mass_percentile_diameter_um(scenario, HYDRAULIC_MASS_PERCENTILE))
    config = replace(
        base,
        recipe=replace(
            base.recipe,
            coffee_mass_g=coffee_dose_g,
            total_time_s=simulation_end_s,
            dt_s=float(grid["dt_s"]),
            sample_every_s=1.0,
            pours=pours,
        ),
        geometry=GeometryConfig(
            bottom_radius_m=float(geom["bottom_radius_m"]),
            cone_half_angle_deg=float(geom["cone_half_angle_deg"]),
            axial_layers=int(grid["axial_layers"]),
            radial_bins=int(grid["radial_bins"]),
        ),
        material=replace(
            base.material,
            retained_water_capacity_g_per_g_coffee=coeff[
                "retained_water_capacity_g_per_g_coffee"
            ],
        ),
        release=replace(
            base.release,
            diffusion_rate_ref_s_inv=coeff["diffusion_rate_ref_s_inv"],
            surface_rate_ref_s_inv=coeff["surface_rate_ref_s_inv"],
        ),
        scenarios=(scenario,),
    )
    # Apply the D90-conditioned hydraulic correction in the same way as the
    # calibrated helper: D90 adjusts the PSD-derived permeability scale.
    from v60_physics.solver import derive_scenario

    derived = derive_scenario(config, scenario)
    sauter_um = derived.characteristic_diameter_m * 1e6
    hydraulic_um = mass_percentile_diameter_um(scenario, HYDRAULIC_MASS_PERCENTILE)
    hydraulic_multiplier = (hydraulic_um / sauter_um) ** 2 * coeff[
        "hydraulic_correction_multiplier"
    ]
    outlet_factor = float(geom.get("outlet_factor", 1.0))
    return replace(
        config,
        hydraulics=replace(
            config.hydraulics,
            permeability_scale=config.hydraulics.permeability_scale
            * hydraulic_multiplier
            * outlet_factor,
        ),
    )


def coefficients_from_d90(d90_um: float) -> dict[str, float]:
    return {
        key: values["prefactor"] * d90_um ** values["exponent"]
        for key, values in D90_CLOSURE_FITS.items()
    }


def parse_pours(value: object) -> tuple[PourSegment, ...]:
    if not isinstance(value, list):
        raise ValueError("Pour schedule must be a list.")
    segments = []
    for index, item in enumerate(value, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"Pour segment {index} is not an object.")
        start = finite_float(item.get("start_s"), f"Pour {index} start", minimum=0.0, maximum=1800.0)
        end = finite_float(item.get("end_s"), f"Pour {index} end", minimum=0.0, maximum=1800.0)
        water = finite_float(item.get("water_g"), f"Pour {index} water", minimum=0.0, maximum=2000.0)
        if end <= start:
            raise ValueError(f"Pour {index} end time must be greater than start time.")
        if water <= 0.0:
            continue
        segments.append(PourSegment(start_s=start, end_s=end, water_g=water))
    segments.sort(key=lambda segment: (segment.start_s, segment.end_s))
    if sum(segment.water_g for segment in segments) <= 0.0:
        raise ValueError("Total water must be positive.")
    return tuple(segments)


def finite_float(value: object, label: str, minimum: float | None = None, maximum: float | None = None) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a number.") from exc
    if not math.isfinite(number):
        raise ValueError(f"{label} must be finite.")
    if minimum is not None and number < minimum:
        raise ValueError(f"{label} must be at least {minimum}.")
    if maximum is not None and number > maximum:
        raise ValueError(f"{label} must be at most {maximum}.")
    return number


def load_surface_psd() -> tuple[list[float], dict[str, list[float]]]:
    sizes: list[float] = []
    values = {name: [] for name in PSD_CLASSES}
    with PSD_FILE.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            size = float(row["size"])
            sizes.append(size)
            for name in PSD_CLASSES:
                values[name].append(max(float(row[name]), 0.0))
    return sizes, {name: normalize(vals) for name, vals in values.items()}


def normalize(values: list[float]) -> list[float]:
    total = sum(values)
    if total <= 0.0:
        raise ValueError("PSD contains no positive values.")
    return [value / total for value in values]


def mass_bins_from_surface(sizes: list[float], surface: list[float]) -> list[tuple[float, float]]:
    weights = [size * fraction for size, fraction in zip(sizes, surface)]
    total = sum(weights)
    return [(size, weight / total) for size, weight in zip(sizes, weights) if weight > 0.0]


def scenario_from_surface(name: str, sizes: list[float], surface: list[float]) -> Scenario:
    return Scenario(
        name=name,
        particle_classes=coarsen_mass_psd(mass_bins_from_surface(sizes, surface), TARGET_CLASS_COUNT),
    )


def psd_anchor_d90_values() -> dict[str, float]:
    sizes, surfaces = load_surface_psd()
    return {
        name: mass_percentile_diameter_um(scenario_from_surface(name, sizes, surfaces[name]), 90.0)
        for name in PSD_CLASSES
    }


def interpolated_scenario_for_d90(target_d90_um: float) -> tuple[Scenario, dict[str, object]]:
    sizes, surfaces = load_surface_psd()
    anchors = {
        name: mass_percentile_diameter_um(scenario_from_surface(name, sizes, surfaces[name]), 90.0)
        for name in PSD_CLASSES
    }
    nearest_name, nearest_d90 = min(
        anchors.items(),
        key=lambda item: abs(item[1] - target_d90_um),
    )
    if abs(nearest_d90 - target_d90_um) <= 0.5:
        scenario = scenario_from_surface(nearest_name, sizes, surfaces[nearest_name])
        return scenario, {
            "target_D90_um": target_d90_um,
            "actual_coarsened_D90_um": mass_percentile_diameter_um(scenario, 90.0),
            "lower_anchor": nearest_name,
            "upper_anchor": nearest_name,
            "upper_anchor_weight": 0.0,
        }
    lower, upper = bracketing_anchors(target_d90_um, anchors)
    weight = solve_weight_for_coarsened_d90(sizes, surfaces[lower], surfaces[upper], target_d90_um)
    surface = [
        (1.0 - weight) * low + weight * high
        for low, high in zip(surfaces[lower], surfaces[upper])
    ]
    surface = normalize(surface)
    scenario = scenario_from_surface(f"D90_{target_d90_um:.0f}um", sizes, surface)
    actual_d90 = mass_percentile_diameter_um(scenario, 90.0)
    return scenario, {
        "target_D90_um": target_d90_um,
        "actual_coarsened_D90_um": actual_d90,
        "lower_anchor": lower,
        "upper_anchor": upper,
        "upper_anchor_weight": weight,
    }


def bracketing_anchors(target_d90_um: float, anchors: dict[str, float]) -> tuple[str, str]:
    ordered = sorted(anchors.items(), key=lambda item: item[1])
    for (lower_name, lower_value), (upper_name, upper_value) in zip(ordered[:-1], ordered[1:]):
        if lower_value <= target_d90_um <= upper_value:
            return lower_name, upper_name
    raise ValueError("D90 is outside measured anchor range.")


def solve_weight_for_coarsened_d90(
    sizes: list[float],
    lower_surface: list[float],
    upper_surface: list[float],
    target_d90_um: float,
) -> float:
    lo = 0.0
    hi = 1.0
    best_weight = 0.5
    best_error = float("inf")
    for _ in range(36):
        mid = 0.5 * (lo + hi)
        surface = normalize(
            [(1.0 - mid) * low + mid * high for low, high in zip(lower_surface, upper_surface)]
        )
        scenario = scenario_from_surface("candidate", sizes, surface)
        d90 = mass_percentile_diameter_um(scenario, 90.0)
        error = abs(d90 - target_d90_um)
        if error < best_error:
            best_error = error
            best_weight = mid
        if error <= 0.05:
            return mid
        if d90 < target_d90_um:
            lo = mid
        else:
            hi = mid
    return best_weight


def selected_time_series(series: list[dict[str, float | str]]) -> list[dict[str, float]]:
    output = []
    for row in series:
        time_s = float(row["time_s"])
        output.append(
            {
                "time_s": time_s,
                "inlet_flow_g_s": float(row["inlet_flow_g_s"]),
                "outlet_flow_g_s": float(row["outlet_flow_g_s"]),
                "cup_water_g": float(row["cup_water_g"]),
                "retained_water_g": float(row["retained_water_g"]),
                "pool_water_g": float(row["pool_water_g"]),
                "tds_percent": float(row["tds_percent"]),
                "extraction_yield_percent": float(row["ey_percent"]),
                "water_residual_g": float(row["water_residual_g"]),
                "solids_residual_g": float(row["solids_residual_g"]),
            }
        )
    return output


def solver_status(summary: dict[str, object]) -> str:
    if not math.isfinite(float(summary["drawdown_time_s"])):
        return "no_drawdown"
    if float(summary["max_water_residual_abs_g"]) > 1e-6:
        return "water_balance_warning"
    if float(summary["max_solids_residual_abs_g"]) > 1e-8:
        return "solids_balance_warning"
    return "ok"


def validation_checks(
    summary: dict[str, object],
    series: list[dict[str, float | str]],
) -> dict[str, object]:
    cup_within_input = float(summary["cup_mass_g"]) <= float(summary["total_recipe_water_g"]) + 1e-9
    nonnegative = True
    for row in series:
        for key in ("cup_water_g", "retained_water_g", "pore_water_g", "pool_water_g", "cup_solids_g"):
            if float(row[key]) < -1e-9:
                nonnegative = False
                break
    return {
        "water_balance_closed": float(summary["max_water_residual_abs_g"]) <= 1e-6,
        "solids_balance_closed": float(summary["max_solids_residual_abs_g"]) <= 1e-8,
        "cup_water_within_input": cup_within_input,
        "nonnegative_inventories": nonnegative,
    }


if __name__ == "__main__":
    main()
