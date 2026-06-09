"""Shared calibrated model helpers for the rebuilt V60 simulator.

The matched in-house pour-over experiment is used to calibrate coefficients
inside the existing governing equations. These helpers keep the calibrated
coefficient set explicit and separate from the original first-principles
configuration.
"""

from __future__ import annotations

from dataclasses import replace
import math
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from run_measured_psd_analysis import (  # noqa: E402
    load_psd_scenario,
    mass_percentile_diameter_um,
)
from v60_physics.parameters import ModelConfig, Scenario  # noqa: E402
from v60_physics.solver import derive_scenario  # noqa: E402


CALIBRATED_SCENARIOS = ("coarse", "medium", "fine")
HYDRAULIC_MASS_PERCENTILE = 90.0

CALIBRATED_COEFFICIENTS: dict[str, dict[str, float]] = {
    "coarse": {
        "retained_water_capacity_g_per_g_coffee": 1.75,
        "hydraulic_correction_multiplier": 0.48,
        "diffusion_rate_ref_s_inv": 0.000239580384784,
        "surface_rate_ref_s_inv": 0.00299475480981,
    },
    "medium": {
        "retained_water_capacity_g_per_g_coffee": 2.00,
        "hydraulic_correction_multiplier": 1.29,
        "diffusion_rate_ref_s_inv": 0.000186021166749,
        "surface_rate_ref_s_inv": 0.00232526458437,
    },
    "fine": {
        "retained_water_capacity_g_per_g_coffee": 2.39,
        "hydraulic_correction_multiplier": 2.95,
        "diffusion_rate_ref_s_inv": 0.000102734343293,
        "surface_rate_ref_s_inv": 0.00128417929116,
    },
}

SHARED_CALIBRATED_COEFFICIENTS: dict[str, float] = {
    "retained_water_capacity_g_per_g_coffee": 1.8968857956857748,
    "hydraulic_correction_multiplier": 1.48327126825424,
    "diffusion_rate_ref_s_inv": 0.00019072379097058052,
    "surface_rate_ref_s_inv": 0.003638303167924794,
}

D90_CLOSURE_FITS: dict[str, dict[str, float]] = {
    "retained_water_capacity_g_per_g_coffee": {
        "prefactor": 13.905546489543006,
        "exponent": -0.27747161984196594,
        "anchor_D90_um": (592.061439794, 1010.09723511, 1814.6060645),
        "anchor_values": (2.39, 2.00, 1.75),
    },
    "hydraulic_correction_multiplier": {
        "prefactor": 94024.81542501571,
        "exponent": -1.6222737560768634,
        "anchor_D90_um": (592.061439794, 1010.09723511, 1814.6060645),
        "anchor_values": (2.95, 1.29, 0.48),
    },
    "diffusion_rate_ref_s_inv": {
        "prefactor": 9.097866127601769e-07,
        "exponent": 0.7508053120777172,
        "anchor_D90_um": (592.061439794, 1010.09723511, 1814.6060645),
        "anchor_values": (0.000102734343293, 0.000186021166749, 0.000239580384784),
    },
    "surface_rate_ref_s_inv": {
        "prefactor": 1.1372332659502172e-05,
        "exponent": 0.7508053120777177,
        "anchor_D90_um": (592.061439794, 1010.09723511, 1814.6060645),
        "anchor_values": (0.00128417929116, 0.00232526458437, 0.00299475480981),
    },
}


def piecewise_log_interpolate(d90_um: float, anchors: tuple[float, ...], values: tuple[float, ...]) -> float:
    """Log-linear interpolation through the calibrated data_2 D90 anchors."""

    if len(anchors) != len(values):
        raise ValueError("D90 closure anchors and values have different lengths.")
    ordered = sorted(zip(anchors, values), key=lambda item: item[0])
    if d90_um <= ordered[0][0]:
        return ordered[0][1]
    if d90_um >= ordered[-1][0]:
        return ordered[-1][1]
    for (x0, y0), (x1, y1) in zip(ordered[:-1], ordered[1:]):
        if x0 <= d90_um <= x1:
            weight = (math.log(d90_um) - math.log(x0)) / (math.log(x1) - math.log(x0))
            return math.exp((1.0 - weight) * math.log(y0) + weight * math.log(y1))
    raise ValueError("D90 is outside calibrated closure range.")


def load_calibrated_psd_scenarios() -> tuple[Scenario, ...]:
    """Load measured PSD scenarios used by the calibrated model."""

    return tuple(load_psd_scenario(name) for name in CALIBRATED_SCENARIOS)


def calibrated_config_for_scenario(
    config: ModelConfig,
    scenario: Scenario,
) -> ModelConfig:
    """Apply calibrated coefficients for one measured PSD grind class.

    The governing equations are unchanged. This function only replaces
    coefficients already present in the rebuilt model: retained-water capacity,
    permeability scale, and the two solute-release rate coefficients.
    """

    if scenario.name not in CALIBRATED_COEFFICIENTS:
        raise ValueError(f"No calibrated coefficients for scenario {scenario.name!r}.")
    coefficients = CALIBRATED_COEFFICIENTS[scenario.name]
    run_config = replace(
        config,
        scenarios=(scenario,),
        material=replace(
            config.material,
            retained_water_capacity_g_per_g_coffee=coefficients[
                "retained_water_capacity_g_per_g_coffee"
            ],
        ),
        release=replace(
            config.release,
            diffusion_rate_ref_s_inv=coefficients["diffusion_rate_ref_s_inv"],
            surface_rate_ref_s_inv=coefficients["surface_rate_ref_s_inv"],
        ),
    )
    derived = derive_scenario(run_config, scenario)
    sauter_um = derived.characteristic_diameter_m * 1e6
    hydraulic_um = mass_percentile_diameter_um(scenario, HYDRAULIC_MASS_PERCENTILE)
    hydraulic_multiplier = (
        (hydraulic_um / sauter_um) ** 2
        * coefficients["hydraulic_correction_multiplier"]
    )
    return replace(
        run_config,
        hydraulics=replace(
            run_config.hydraulics,
            permeability_scale=run_config.hydraulics.permeability_scale * hydraulic_multiplier,
        ),
    )


def shared_calibrated_config_for_scenario(
    config: ModelConfig,
    scenario: Scenario,
) -> ModelConfig:
    """Apply one shared coefficient set to a measured PSD scenario.

    This is the calibrated model to use when PSD effects should be separated
    from grind-specific empirical coefficient overlays. The coefficient set was
    fitted only to the matched in-house pour-over experiment.
    """

    coefficients = SHARED_CALIBRATED_COEFFICIENTS
    run_config = replace(
        config,
        scenarios=(scenario,),
        material=replace(
            config.material,
            retained_water_capacity_g_per_g_coffee=coefficients[
                "retained_water_capacity_g_per_g_coffee"
            ],
        ),
        release=replace(
            config.release,
            diffusion_rate_ref_s_inv=coefficients["diffusion_rate_ref_s_inv"],
            surface_rate_ref_s_inv=coefficients["surface_rate_ref_s_inv"],
        ),
    )
    derived = derive_scenario(run_config, scenario)
    sauter_um = derived.characteristic_diameter_m * 1e6
    hydraulic_um = mass_percentile_diameter_um(scenario, HYDRAULIC_MASS_PERCENTILE)
    hydraulic_multiplier = (
        (hydraulic_um / sauter_um) ** 2
        * coefficients["hydraulic_correction_multiplier"]
    )
    return replace(
        run_config,
        hydraulics=replace(
            run_config.hydraulics,
            permeability_scale=run_config.hydraulics.permeability_scale * hydraulic_multiplier,
        ),
    )


def d90_closure_coefficients_for_scenario(
    scenario: Scenario,
) -> dict[str, float]:
    """Calculate calibrated coefficients from the measured mass D90.

    The closure functions were fitted to the class-conditioned matched
    experiment coefficients. D90 is in micrometers.
    """

    d90_um = mass_percentile_diameter_um(scenario, HYDRAULIC_MASS_PERCENTILE)
    return {
        key: piecewise_log_interpolate(
            d90_um,
            values["anchor_D90_um"],
            values["anchor_values"],
        )
        for key, values in D90_CLOSURE_FITS.items()
    }


def d90_closure_config_for_scenario(
    config: ModelConfig,
    scenario: Scenario,
) -> ModelConfig:
    """Apply PSD-conditioned D90 closure coefficients to one scenario."""

    coefficients = d90_closure_coefficients_for_scenario(scenario)
    run_config = replace(
        config,
        scenarios=(scenario,),
        material=replace(
            config.material,
            retained_water_capacity_g_per_g_coffee=coefficients[
                "retained_water_capacity_g_per_g_coffee"
            ],
        ),
        release=replace(
            config.release,
            diffusion_rate_ref_s_inv=coefficients["diffusion_rate_ref_s_inv"],
            surface_rate_ref_s_inv=coefficients["surface_rate_ref_s_inv"],
        ),
    )
    derived = derive_scenario(run_config, scenario)
    sauter_um = derived.characteristic_diameter_m * 1e6
    hydraulic_um = mass_percentile_diameter_um(scenario, HYDRAULIC_MASS_PERCENTILE)
    hydraulic_multiplier = (
        (hydraulic_um / sauter_um) ** 2
        * coefficients["hydraulic_correction_multiplier"]
    )
    return replace(
        run_config,
        hydraulics=replace(
            run_config.hydraulics,
            permeability_scale=run_config.hydraulics.permeability_scale * hydraulic_multiplier,
        ),
    )


def calibrated_scenario_from_grind_description(
    recipe_id: str,
    grind_description: str,
) -> str:
    """Map recipe grind language to measured PSD classes.

    If particle size is not specified, the calibrated model uses the medium PSD
    class. Artificial bimodal scenarios are no longer used because measured PSDs
    are available for all three grind classes.
    """

    text = f"{recipe_id} {grind_description}".lower()
    if "coarse" in text or "kasuya" in text or "_46_" in text or "4:6" in text:
        return "coarse"
    medium_fine_terms = ("medium-fine", "medium fine", "moderately fine")
    if "fine" in text and not any(term in text for term in medium_fine_terms):
        return "fine"
    return "medium"
