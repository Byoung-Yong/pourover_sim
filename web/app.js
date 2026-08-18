"use strict";

const state = {
  defaults: null,
  lastResult: null,
  lastPayload: null,
};

const fallbackDefaults = {
  d90_min_um: 592,
  d90_max_um: 1815,
  default_payload: {
    d90_um: 1010,
    coffee_dose_g: 20,
    grid: "fast",
    simulation_end_s: 300,
    pours: [
      { start_s: 0, end_s: 15, water_g: 60 },
      { start_s: 30, end_s: 70, water_g: 120 },
      { start_s: 80, end_s: 120, water_g: 120 },
    ],
  },
};

const elements = {
  runButton: document.getElementById("runButton"),
  d90: document.getElementById("d90"),
  d90Value: document.getElementById("d90Value"),
  grindLanguage: document.getElementById("grindLanguage"),
  coffeeDose: document.getElementById("coffeeDose"),
  geometry: document.getElementById("geometry"),
  grid: document.getElementById("grid"),
  simulationEnd: document.getElementById("simulationEnd"),
  pourRows: document.getElementById("pourRows"),
  pourTemplate: document.getElementById("pourTemplate"),
  addPour: document.getElementById("addPour"),
  totalWater: document.getElementById("totalWater"),
  status: document.getElementById("status"),
  statusCopy: document.querySelector("#status .status-copy"),
  cupWater: document.getElementById("cupWater"),
  retainedWater: document.getElementById("retainedWater"),
  drawdown: document.getElementById("drawdown"),
  tds: document.getElementById("tds"),
  ey: document.getElementById("ey"),
  bedHeight: document.getElementById("bedHeight"),
  waterCheck: document.getElementById("waterCheck"),
  solidsCheck: document.getElementById("solidsCheck"),
  cupCheck: document.getElementById("cupCheck"),
  nonnegativeCheck: document.getElementById("nonnegativeCheck"),
  brewVisual: document.getElementById("brewVisual"),
  visualTime: document.getElementById("visualTime"),
  visualPhase: document.getElementById("visualPhase"),
  visualHint: document.getElementById("visualHint"),
  brewCanvas: document.getElementById("brewCanvas"),
  brewPhoto: document.getElementById("brewPhoto"),
  chart: document.getElementById("chart"),
  chartTooltip: document.getElementById("chartTooltip"),
};

const brewAnimation = createBrewAnimation(elements);

const CHART_COLORS = {
  cup: "#6f3e23",
  bed: "#66745f",
  mobile: "#93a18b",
  immobile: "#7c6d5f",
  pool: "#7897a0",
  ey: "#b16f3b",
  grid: "rgba(86, 68, 54, 0.10)",
  gridSoft: "rgba(86, 68, 54, 0.055)",
  text: "#6f655c",
  textStrong: "#41342a",
  pour: "#7897a0",
};

const chartView = {
  series: [],
  pours: [],
  hoverIndex: null,
  logicalWidth: 980,
  logicalHeight: 390,
  geometry: null,
  resizeFrame: null,
  hoverFrame: null,
};

async function init() {
  bindEvents();
  bindChartInteraction();
  applyDefaults(fallbackDefaults);
  try {
    const response = await fetch("/api/defaults");
    const defaultsData = await readJsonResponse(response);
    if (!response.ok || defaultsData.ok === false) throw new Error(defaultsData.error || "default request failed");
    state.defaults = defaultsData;
    applyDefaults(state.defaults);
    setStatus("Ready.");
    drawEmptyChart();
  } catch (error) {
    setStatus(`Could not load defaults: ${error.message}`, true);
    drawEmptyChart();
  }
}

function bindEvents() {
  elements.runButton.addEventListener("click", runSimulation);
  elements.d90.addEventListener("input", updateD90Label);
  elements.addPour.addEventListener("click", () => {
    addPourRow({ start_s: 130, end_s: 160, water_g: 50 });
    updateTotalWater();
  });
  elements.pourRows.addEventListener("input", updateTotalWater);
}

function applyDefaults(defaults) {
  const payload = defaults.default_payload;
  elements.d90.min = Math.round(defaults.d90_min_um);
  elements.d90.max = Math.round(defaults.d90_max_um);
  elements.d90.value = Math.round(payload.d90_um);
  elements.coffeeDose.value = payload.coffee_dose_g;
  elements.geometry.value = "v60";
  elements.grid.value = payload.grid;
  elements.simulationEnd.value = payload.simulation_end_s;
  elements.pourRows.innerHTML = "";
  for (const pour of payload.pours) addPourRow(pour);
  updateD90Label();
  updateTotalWater();
}

function addPourRow(pour) {
  const node = elements.pourTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".pour-start").value = pour.start_s;
  node.querySelector(".pour-end").value = pour.end_s;
  node.querySelector(".pour-water").value = pour.water_g;
  node.querySelector(".remove-pour").addEventListener("click", () => {
    node.remove();
    updateTotalWater();
  });
  elements.pourRows.appendChild(node);
}

function updateD90Label() {
  const d90 = Number(elements.d90.value);
  elements.d90Value.textContent = `${d90.toFixed(0)} um`;
  elements.grindLanguage.textContent = grindLanguageForD90(d90);
}

function updateTotalWater() {
  const water = readPours().reduce((sum, pour) => sum + pour.water_g, 0);
  elements.totalWater.textContent = `${water.toFixed(0)} g`;
}

function readPours() {
  return [...elements.pourRows.querySelectorAll(".pour-row")]
    .map((row) => ({
      start_s: Number(row.querySelector(".pour-start").value),
      end_s: Number(row.querySelector(".pour-end").value),
      water_g: Number(row.querySelector(".pour-water").value),
    }))
    .filter((pour) => pour.water_g > 0);
}

function buildPayload() {
  return {
    d90_um: Number(elements.d90.value),
    coffee_dose_g: Number(elements.coffeeDose.value),
    geometry: "v60",
    grid: elements.grid.value,
    simulation_end_s: Number(elements.simulationEnd.value),
    pours: readPours(),
  };
}

async function runSimulation() {
  const payload = buildPayload();
  state.lastPayload = payload;
  setStatus("Calculating...", false, "running");
  brewAnimation.start(payload);
  elements.runButton.disabled = true;
  elements.runButton.setAttribute("aria-busy", "true");
  const runLabel = elements.runButton.querySelector("span:last-child");
  if (runLabel) runLabel.textContent = "Calculating...";

  try {
    const response = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.ok) throw new Error(data.error || "Simulation failed.");
    state.lastResult = data;
    renderResult(data);
    brewAnimation.finish(data);
    setStatus("Complete.");
  } catch (error) {
    brewAnimation.fail();
    setStatus(error.message, true);
  } finally {
    elements.runButton.disabled = false;
    elements.runButton.removeAttribute("aria-busy");
    if (runLabel) runLabel.textContent = "Run simulation";
  }
}

async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (error) {
    const preview = text.trim().slice(0, 220) || "empty response";
    throw new Error(`API returned non-JSON response (${response.status}). ${preview}`);
  }
}

function renderResult(data) {
  const summary = data.summary;
  elements.cupWater.textContent = `${format(summary.cup_water_g, 1)} g`;
  elements.retainedWater.textContent = `${format(summary.bed_water_g ?? summary.retained_water_g, 1)} g`;
  elements.drawdown.textContent = Number.isFinite(summary.drawdown_time_s)
    ? `${format(summary.drawdown_time_s, 0)} s`
    : "not reached";
  elements.tds.textContent = `${format(summary.tds_percent, 2)} %`;
  elements.ey.textContent = `${format(summary.extraction_yield_percent, 2)} %`;
  elements.bedHeight.textContent = `${format(summary.bed_height_mm, 1)} mm`;
  renderCheck(elements.waterCheck, "Water balance", data.checks.water_balance_closed);
  renderCheck(elements.solidsCheck, "Solids balance", data.checks.solids_balance_closed);
  renderCheck(elements.cupCheck, "Cup <= input", data.checks.cup_water_within_input);
  renderCheck(elements.nonnegativeCheck, "Nonnegative", data.checks.nonnegative_inventories);
  drawChart(data.time_series, state.lastPayload?.pours || []);
}

function renderCheck(element, label, ok) {
  element.textContent = `${label}: ${ok ? "ok" : "check"}`;
  element.dataset.state = ok ? "ok" : "warn";
}

function bindChartInteraction() {
  const canvas = elements.chart;
  const tooltip = elements.chartTooltip;
  if (!canvas) return;

  const redrawHover = () => {
    chartView.hoverFrame = null;
    if (chartView.series.length) drawChart(chartView.series, chartView.pours, true);
  };

  canvas.addEventListener("pointermove", (event) => {
    if (!chartView.series.length || !chartView.geometry) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(rect.width, 1)) * chartView.logicalWidth;
    const { margin, plotW, maxTime } = chartView.geometry;
    const normalized = clamp((x - margin.left) / Math.max(plotW, 1), 0, 1);
    const index = nearestTimeIndex(chartView.series, normalized * maxTime);
    if (index === chartView.hoverIndex) {
      positionChartTooltip(index, event.clientY);
      return;
    }
    chartView.hoverIndex = index;
    positionChartTooltip(index, event.clientY);
    if (chartView.hoverFrame === null) chartView.hoverFrame = requestAnimationFrame(redrawHover);
  });

  canvas.addEventListener("pointerleave", () => {
    chartView.hoverIndex = null;
    hideChartTooltip();
    if (chartView.series.length) drawChart(chartView.series, chartView.pours, true);
  });

  canvas.addEventListener("focus", () => {
    if (!chartView.series.length) return;
    if (chartView.hoverIndex === null) chartView.hoverIndex = chartView.series.length - 1;
    positionChartTooltip(chartView.hoverIndex);
    drawChart(chartView.series, chartView.pours, true);
  });

  canvas.addEventListener("blur", () => {
    chartView.hoverIndex = null;
    hideChartTooltip();
    if (chartView.series.length) drawChart(chartView.series, chartView.pours, true);
  });

  canvas.addEventListener("keydown", (event) => {
    if (!chartView.series.length || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Home") chartView.hoverIndex = 0;
    else if (event.key === "End") chartView.hoverIndex = chartView.series.length - 1;
    else {
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const current = chartView.hoverIndex ?? chartView.series.length - 1;
      chartView.hoverIndex = clamp(current + direction, 0, chartView.series.length - 1);
    }
    positionChartTooltip(chartView.hoverIndex);
    drawChart(chartView.series, chartView.pours, true);
  });

  const resizeObserver = typeof ResizeObserver !== "undefined"
    ? new ResizeObserver(() => {
        if (chartView.resizeFrame !== null) cancelAnimationFrame(chartView.resizeFrame);
        chartView.resizeFrame = requestAnimationFrame(() => {
          chartView.resizeFrame = null;
          if (chartView.series.length) drawChart(chartView.series, chartView.pours, true);
          else drawEmptyChart(true);
        });
      })
    : null;

  if (resizeObserver) resizeObserver.observe(canvas.parentElement);
  else window.addEventListener("resize", () => {
    if (chartView.series.length) drawChart(chartView.series, chartView.pours, true);
    else drawEmptyChart(true);
  }, { passive: true });

  if (tooltip) tooltip.setAttribute("aria-hidden", "true");
}

function prepareChartCanvas() {
  const canvas = elements.chart;
  const rect = canvas.getBoundingClientRect();
  const isCompact = window.matchMedia?.("(max-width: 620px)").matches ?? false;
  const logicalWidth = Math.max(isCompact ? 300 : 720, Math.round(rect.width || 980));
  const fallbackHeight = isCompact ? 330 : 300;
  const logicalHeight = Math.max(isCompact ? 280 : 170, Math.round(rect.height || fallbackHeight));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.round(logicalWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(logicalHeight * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  chartView.logicalWidth = logicalWidth;
  chartView.logicalHeight = logicalHeight;
  return { ctx, width: logicalWidth, height: logicalHeight };
}

function drawEmptyChart(fromResize = false) {
  if (!fromResize) {
    chartView.series = [];
    chartView.pours = [];
    chartView.hoverIndex = null;
    hideChartTooltip();
  }

  const { ctx, width, height } = prepareChartCanvas();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbf8f3";
  ctx.fillRect(0, 0, width, height);

  const margin = chartMargins(width);
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  drawChartTexture(ctx, margin, plotW, plotH);

  ctx.strokeStyle = CHART_COLORS.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = margin.top + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + plotW, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#6f655c";
  ctx.font = "650 13px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Run simulation to render process dynamics", width / 2, height / 2 - 3);
  ctx.fillStyle = "#9a8f85";
  ctx.font = "500 10px Inter, system-ui, sans-serif";
  ctx.fillText("Pour windows and model outputs will appear here", width / 2, height / 2 + 19);
}

function drawChart(series, pours = [], preserveHover = false) {
  if (!Array.isArray(series) || !series.length) {
    drawEmptyChart();
    return;
  }

  if (!preserveHover) chartView.hoverIndex = null;
  chartView.series = series;
  chartView.pours = Array.isArray(pours) ? pours : [];

  const { ctx, width, height } = prepareChartCanvas();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbf8f3";
  ctx.fillRect(0, 0, width, height);

  const margin = chartMargins(width);
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const maxTime = Math.max(...series.map((point) => Number(point.time_s) || 0), 1);
  const maxWaterRaw = Math.max(
    ...series.map((point) => Math.max(
      Number(point.cup_water_g) || 0,
      Number(point.bed_water_g ?? point.retained_water_g) || 0,
      Number(point.mobile_bed_water_g) || 0,
      Number(point.immobile_retained_water_g) || 0,
      Number(point.pool_water_g) || 0,
    )),
    1,
  );
  const maxEyRaw = Math.max(...series.map((point) => Number(point.extraction_yield_percent) || 0), 1);
  const maxWater = niceCeiling(maxWaterRaw * 1.05);
  const maxEy = niceCeiling(maxEyRaw * 1.08);

  chartView.geometry = { margin, plotW, plotH, maxTime, maxWater, maxEy, width, height };

  drawChartTexture(ctx, margin, plotW, plotH);
  drawPourWindows(ctx, chartView.pours, margin, plotW, plotH, maxTime);
  drawProfessionalAxes(ctx, margin, plotW, plotH, maxTime, maxWater, maxEy);
  drawAreaSeries(ctx, series, "cup_water_g", CHART_COLORS.cup, margin, plotW, plotH, maxTime, maxWater);
  drawChartLine(ctx, series, "cup_water_g", CHART_COLORS.cup, 3.0, [], margin, plotW, plotH, maxTime, maxWater);
  drawChartLine(ctx, series, "bed_water_g", CHART_COLORS.bed, 2.8, [], margin, plotW, plotH, maxTime, maxWater, "retained_water_g");
  drawChartLine(ctx, series, "mobile_bed_water_g", CHART_COLORS.mobile, 1.45, [5, 5], margin, plotW, plotH, maxTime, maxWater);
  drawChartLine(ctx, series, "immobile_retained_water_g", CHART_COLORS.immobile, 1.45, [1.5, 4.5], margin, plotW, plotH, maxTime, maxWater);
  drawChartLine(ctx, series, "pool_water_g", CHART_COLORS.pool, 2.15, [], margin, plotW, plotH, maxTime, maxWater);
  drawChartLine(ctx, series, "extraction_yield_percent", CHART_COLORS.ey, 2.35, [7, 6], margin, plotW, plotH, maxTime, maxEy);

  if (chartView.hoverIndex !== null) drawChartHover(ctx, series, chartView.hoverIndex, chartView.geometry);
}

function drawChartTexture(ctx, margin, plotW, plotH) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, plotW, plotH);
  ctx.clip();
  ctx.fillStyle = "rgba(111, 62, 35, 0.045)";
  for (let y = margin.top + 7; y < margin.top + plotH; y += 14) {
    const offset = ((Math.floor((y - margin.top) / 14) % 2) * 7);
    for (let x = margin.left + 7 + offset; x < margin.left + plotW; x += 14) {
      ctx.beginPath();
      ctx.arc(x, y, 0.65, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawPourWindows(ctx, pours, margin, plotW, plotH, maxTime) {
  if (!pours?.length) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, plotW, plotH);
  ctx.clip();

  pours.forEach((pour, index) => {
    const start = clamp(Number(pour.start_s) || 0, 0, maxTime);
    const end = clamp(Number(pour.end_s) || 0, 0, maxTime);
    if (end <= start) return;
    const x0 = margin.left + (start / maxTime) * plotW;
    const x1 = margin.left + (end / maxTime) * plotW;
    const bandW = Math.max(1, x1 - x0);

    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, margin.top, bandW, plotH);
    ctx.clip();
    ctx.fillStyle = "rgba(120, 151, 160, 0.065)";
    ctx.fillRect(x0, margin.top, bandW, plotH);

    ctx.strokeStyle = "rgba(120, 151, 160, 0.13)";
    ctx.lineWidth = 1;
    for (let x = x0 - plotH; x < x1 + plotH; x += 12) {
      ctx.beginPath();
      ctx.moveTo(x, margin.top + plotH);
      ctx.lineTo(x + plotH, margin.top);
      ctx.stroke();
    }
    ctx.restore();

    if (bandW > 42) {
      ctx.fillStyle = "rgba(79, 111, 121, 0.72)";
      ctx.font = "800 9px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`POUR ${index + 1}`, x0 + bandW / 2, margin.top + 14);
    }
  });
  ctx.restore();
}

function drawProfessionalAxes(ctx, margin, plotW, plotH, maxTime, maxWater, maxEy) {
  const compact = chartView.logicalWidth < 500;
  const yTicks = compact ? 4 : 5;
  const xTicks = compact ? 4 : 6;

  ctx.save();
  ctx.font = `${compact ? 10 : 11}px Inter, system-ui, sans-serif`;
  ctx.textBaseline = "middle";

  for (let i = 0; i <= yTicks; i += 1) {
    const ratio = i / yTicks;
    const y = margin.top + plotH - ratio * plotH;
    ctx.strokeStyle = i === 0 ? "rgba(86, 68, 54, 0.16)" : CHART_COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + plotW, y);
    ctx.stroke();

    const waterValue = maxWater * ratio;
    const eyValue = maxEy * ratio;
    ctx.fillStyle = CHART_COLORS.text;
    ctx.textAlign = "right";
    ctx.fillText(formatAxisValue(waterValue), margin.left - 10, y);
    ctx.fillStyle = "#9a6a45";
    ctx.textAlign = "left";
    ctx.fillText(formatAxisValue(eyValue), margin.left + plotW + 10, y);
  }

  for (let i = 0; i <= xTicks; i += 1) {
    const ratio = i / xTicks;
    const x = margin.left + plotW * ratio;
    ctx.strokeStyle = CHART_COLORS.gridSoft;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, margin.top);
    ctx.lineTo(x, margin.top + plotH);
    ctx.stroke();

    ctx.fillStyle = CHART_COLORS.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(`${Math.round(maxTime * ratio)}`, x, margin.top + plotH + 13);
  }

  ctx.fillStyle = CHART_COLORS.textStrong;
  ctx.font = "700 10px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("WATER INVENTORY · g", margin.left, margin.top - 16);
  ctx.fillStyle = "#9a6a45";
  ctx.textAlign = "right";
  ctx.fillText("EXTRACTION YIELD · %", margin.left + plotW, margin.top - 16);
  ctx.fillStyle = CHART_COLORS.text;
  ctx.textAlign = "center";
  ctx.fillText("TIME · s", margin.left + plotW / 2, margin.top + plotH + 42);
  ctx.restore();
}

function drawAreaSeries(ctx, series, key, color, margin, plotW, plotH, maxTime, maxY) {
  ctx.save();
  ctx.beginPath();
  series.forEach((point, index) => {
    const x = margin.left + ((Number(point.time_s) || 0) / maxTime) * plotW;
    const y = margin.top + plotH - ((Number(point[key]) || 0) / maxY) * plotH;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  const last = series[series.length - 1];
  const first = series[0];
  ctx.lineTo(margin.left + ((Number(last.time_s) || 0) / maxTime) * plotW, margin.top + plotH);
  ctx.lineTo(margin.left + ((Number(first.time_s) || 0) / maxTime) * plotW, margin.top + plotH);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, margin.top, 0, margin.top + plotH);
  gradient.addColorStop(0, "rgba(111, 62, 35, 0.15)");
  gradient.addColorStop(0.68, "rgba(111, 62, 35, 0.045)");
  gradient.addColorStop(1, "rgba(111, 62, 35, 0.008)");
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.restore();
}

function drawChartLine(ctx, series, key, color, width, dash, margin, plotW, plotH, maxTime, maxY, fallbackKey = null) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.setLineDash(dash);
  ctx.beginPath();
  series.forEach((point, index) => {
    const x = margin.left + ((Number(point.time_s) || 0) / maxTime) * plotW;
    const rawValue = point[key] ?? (fallbackKey ? point[fallbackKey] : 0);
    const y = margin.top + plotH - ((Number(rawValue) || 0) / maxY) * plotH;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawChartHover(ctx, series, index, geometry) {
  const point = series[clamp(index, 0, series.length - 1)];
  const { margin, plotW, plotH, maxTime, maxWater, maxEy } = geometry;
  const x = margin.left + ((Number(point.time_s) || 0) / maxTime) * plotW;
  ctx.save();
  ctx.strokeStyle = "rgba(63, 49, 38, 0.28)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(x, margin.top);
  ctx.lineTo(x, margin.top + plotH);
  ctx.stroke();
  ctx.setLineDash([]);

  const values = [
    ["cup_water_g", null, CHART_COLORS.cup, maxWater],
    ["bed_water_g", "retained_water_g", CHART_COLORS.bed, maxWater],
    ["mobile_bed_water_g", null, CHART_COLORS.mobile, maxWater],
    ["immobile_retained_water_g", null, CHART_COLORS.immobile, maxWater],
    ["pool_water_g", null, CHART_COLORS.pool, maxWater],
    ["extraction_yield_percent", null, CHART_COLORS.ey, maxEy],
  ];
  for (const [key, fallbackKey, color, maxY] of values) {
    const rawValue = point[key] ?? (fallbackKey ? point[fallbackKey] : 0);
    const y = margin.top + plotH - ((Number(rawValue) || 0) / maxY) * plotH;
    ctx.fillStyle = "#fffdf9";
    ctx.beginPath();
    ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 3.1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function nearestTimeIndex(series, time) {
  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((Number(series[mid].time_s) || 0) <= time) lo = mid;
    else hi = mid;
  }
  if (hi === lo) return lo;
  return Math.abs((Number(series[lo].time_s) || 0) - time) <= Math.abs((Number(series[hi].time_s) || 0) - time) ? lo : hi;
}

function positionChartTooltip(index, pointerClientY = null) {
  const tooltip = elements.chartTooltip;
  const canvas = elements.chart;
  if (!tooltip || !chartView.series.length || !chartView.geometry) return;
  const point = chartView.series[clamp(index, 0, chartView.series.length - 1)];
  const { margin, plotW, plotH, maxTime, maxWater } = chartView.geometry;
  const xLogical = margin.left + ((Number(point.time_s) || 0) / maxTime) * plotW;
  const cupYLogical = margin.top + plotH - ((Number(point.cup_water_g) || 0) / maxWater) * plotH;
  const xCss = (xLogical / chartView.logicalWidth) * canvas.clientWidth;
  let yCss = (cupYLogical / chartView.logicalHeight) * canvas.clientHeight;
  if (pointerClientY !== null) {
    const rect = canvas.getBoundingClientRect();
    yCss = clamp(pointerClientY - rect.top, 66, canvas.clientHeight - 66);
  }

  const isLeft = xCss > canvas.clientWidth - 220;
  tooltip.style.left = `${xCss}px`;
  tooltip.style.top = `${yCss}px`;
  tooltip.style.transform = isLeft ? "translate(calc(-100% - 10px), -50%)" : "translate(10px, -50%)";
  tooltip.innerHTML = chartTooltipMarkup(point);
  tooltip.dataset.visible = "true";
  tooltip.setAttribute("aria-hidden", "false");
}

function hideChartTooltip() {
  if (!elements.chartTooltip) return;
  elements.chartTooltip.dataset.visible = "false";
  elements.chartTooltip.setAttribute("aria-hidden", "true");
}

function chartTooltipMarkup(point) {
  const rows = [
    ["Cup water", Number(point.cup_water_g) || 0, "g", CHART_COLORS.cup, 1],
    ["Bed water", Number(point.bed_water_g ?? point.retained_water_g) || 0, "g", CHART_COLORS.bed, 1],
    ["Mobile pore", Number(point.mobile_bed_water_g) || 0, "g", CHART_COLORS.mobile, 1],
    ["Immobile retained", Number(point.immobile_retained_water_g) || 0, "g", CHART_COLORS.immobile, 1],
    ["Pooled", Number(point.pool_water_g) || 0, "g", CHART_COLORS.pool, 1],
    ["Extraction yield", Number(point.extraction_yield_percent) || 0, "%", CHART_COLORS.ey, 2],
  ];
  return `
    <div class="chart-tooltip-time">${(Number(point.time_s) || 0).toFixed(0)} s</div>
    ${rows.map(([label, value, unit, color, digits]) => `
      <div class="chart-tooltip-row" style="color:${color}">
        <span class="chart-tooltip-dot"></span>
        <span>${label}</span>
        <strong>${value.toFixed(digits)} ${unit}</strong>
      </div>
    `).join("")}
  `;
}

function niceCeiling(value) {
  const positive = Math.max(Number(value) || 0, 1e-9);
  const exponent = Math.floor(Math.log10(positive));
  const scale = 10 ** exponent;
  const fraction = positive / scale;
  const steps = [1, 2, 2.5, 3, 4, 5, 7.5, 10];
  const niceFraction = steps.find((step) => fraction <= step) ?? 10;
  return niceFraction * scale;
}

function chartMargins(width) {
  const shortChart = chartView.logicalHeight < 245;
  if (width < 500) {
    return shortChart
      ? { left: 42, right: 42, top: 30, bottom: 42 }
      : { left: 44, right: 44, top: 36, bottom: 50 };
  }
  return shortChart
    ? { left: 62, right: 62, top: 31, bottom: 43 }
    : { left: 72, right: 72, top: 38, bottom: 56 };
}

function formatAxisValue(value) {
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}

function grindLanguageForD90(d90) {
  if (d90 >= 1600) return "coarse";
  if (d90 >= 1300) return "medium-coarse";
  if (d90 >= 900) return "medium";
  if (d90 >= 700) return "medium-fine";
  return "fine";
}

function createBrewAnimation(dom) {
  if (!dom.brewVisual || !dom.brewCanvas || !dom.brewPhoto) {
    return {
      start() {},
      finish() {},
      fail() {},
    };
  }

  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const renderer = createBrewCanvasRenderer(dom.brewCanvas, dom.brewPhoto, reduceMotion);
  const animation = {
    frame: null,
    payload: null,
    startedAt: 0,
  };

  renderer.render({
    cupRatio: 0,
    wetness: 0,
    pour: 0,
    drip: 0,
    bloom: 0,
    time: 0,
  });

  function start(payload) {
    stop();
    animation.payload = normalizeBrewPayload(payload);
    animation.startedAt = performance.now();
    dom.brewVisual.dataset.state = "running";
    dom.brewVisual.setAttribute("aria-busy", "true");
    dom.visualPhase.textContent = "Calculating process model";
    dom.visualTime.textContent = "...";
    if (dom.visualHint) dom.visualHint.textContent = "Brewing motion indicates that the calculation is in progress";

    // This is intentionally an indeterminate loading animation. It starts
    // immediately when the request is sent and stops as soon as the solver
    // returns. No intermediate visual value is presented as calculated data.
    renderer.render({
      cupRatio: 0,
      wetness: 0.35,
      pour: 0.9,
      drip: 0.34,
      bloom: 0.42,
      time: 0,
    });

    if (reduceMotion) return;

    const tick = (now) => {
      const elapsedS = Math.max(0, (now - animation.startedAt) / 1000);

      // Monotonic, asymptotic fill: it reads as ongoing work without ever
      // pretending to know the solver's actual completion percentage.
      const cupRatio = 0.68 * (1 - Math.exp(-elapsedS / 2.6));
      const pulse = 0.5 + 0.5 * Math.sin(elapsedS * 2.15);
      const slowPulse = 0.5 + 0.5 * Math.sin(elapsedS * 1.12 + 0.8);

      renderer.render({
        cupRatio,
        wetness: clamp(0.42 + cupRatio * 0.45, 0, 1),
        pour: 0.82 + pulse * 0.16,
        drip: 0.30 + slowPulse * 0.34,
        bloom: Math.max(0, 0.52 - elapsedS * 0.055),
        time: elapsedS,
      });

      animation.frame = requestAnimationFrame(tick);
    };

    animation.frame = requestAnimationFrame(tick);
  }

  function finish(data) {
    stop();
    dom.brewVisual.removeAttribute("aria-busy");
    renderFinalState(data);
  }

  function renderFinalState(data) {
    dom.brewVisual.dataset.state = "complete";
    const finalPoint = data.time_series?.[data.time_series.length - 1] || {};
    const totalWater = Math.max(Number(data.summary?.total_water_g) || animation.payload?.total_water_g || 1, 1);
    const retainedScale = Math.max(
      Number(data.summary?.bed_water_g ?? data.summary?.retained_water_g) || 0,
      animation.payload?.coffee_dose_g ? animation.payload.coffee_dose_g * 2.2 : 1,
      1,
    );
    const cupWater = Math.max(0, Number(finalPoint.cup_water_g ?? data.summary?.cup_water_g) || 0);
    dom.visualTime.textContent = `${cupWater.toFixed(1)} g`;
    dom.visualPhase.textContent = "Calculation complete";
    if (dom.visualHint) dom.visualHint.textContent = "Estimated liquid collected in the server";
    renderer.render({
      cupRatio: clamp(cupWater / totalWater, 0, 1),
      wetness: clamp((Number(finalPoint.bed_water_g ?? finalPoint.retained_water_g ?? data.summary?.bed_water_g ?? data.summary?.retained_water_g) || 0) / retainedScale, 0, 1),
      pour: 0,
      drip: 0,
      bloom: 0,
      time: 0,
    });
  }

  function fail() {
    stop();
    dom.brewVisual.removeAttribute("aria-busy");
    dom.brewVisual.dataset.state = "error";
    dom.visualPhase.textContent = "Simulation stopped";
    dom.visualTime.textContent = "--";
    if (dom.visualHint) dom.visualHint.textContent = "The calculation did not complete";
    const current = renderer.getState();
    renderer.render({ ...current, pour: 0, drip: 0, bloom: 0 });
  }

  function stop() {
    if (animation.frame !== null) cancelAnimationFrame(animation.frame);
    animation.frame = null;
  }

  return { start, finish, fail };
}

function createBrewCanvasRenderer(canvas, photo, reduceMotion) {
  const ctx = canvas.getContext("2d", { alpha: false });
  const logical = { width: 1122, height: 1402 };
  const sourceCanvas = document.createElement("canvas");
  const cleanCanvas = document.createElement("canvas");
  sourceCanvas.width = cleanCanvas.width = logical.width;
  sourceCanvas.height = cleanCanvas.height = logical.height;
  const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  const cleanCtx = cleanCanvas.getContext("2d", { willReadFrequently: true });
  const state = {
    cupRatio: 0,
    wetness: 0,
    pour: 0,
    drip: 0,
    bloom: 0,
    time: 0,
  };
  let cssWidth = logical.width;
  let cssHeight = logical.height;
  let dpr = 1;
  let photoReady = false;

  function preparePhoto() {
    if (!photo.naturalWidth || !photo.naturalHeight) return;
    sourceCtx.clearRect(0, 0, logical.width, logical.height);
    sourceCtx.drawImage(photo, 0, 0, logical.width, logical.height);
    cleanCtx.clearRect(0, 0, logical.width, logical.height);
    cleanCtx.drawImage(sourceCanvas, 0, 0);
    removeEmbeddedWaterStream();
    softenStaticCoffee();
    photoReady = true;
    draw();
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    cssWidth = rect.width;
    cssHeight = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const nextWidth = Math.max(1, Math.round(cssWidth * dpr));
    const nextHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
    }
    draw();
  }

  function render(next) {
    Object.assign(state, next);
    if (reduceMotion) state.time = 0;
    draw();
  }

  function getState() {
    return { ...state };
  }

  function draw() {
    const sx = cssWidth / logical.width;
    const sy = cssHeight / logical.height;
    ctx.setTransform(dpr * sx, 0, 0, dpr * sy, 0, 0);
    ctx.clearRect(0, 0, logical.width, logical.height);

    if (!photoReady) {
      ctx.fillStyle = "#8b542e";
      ctx.fillRect(0, 0, logical.width, logical.height);
      return;
    }

    ctx.drawImage(cleanCanvas, 0, 0);
    drawCoffeeLevel();
    drawPhotoWaterStream();
    drawExtractionDrops();
    drawBedResponse();
    drawSteam();
  }

  function streamPoint(progress) {
    const p = clamp(progress, 0, 1);
    const oneMinus = 1 - p;
    const p0 = { x: 490, y: -18 };
    const p1 = { x: 502, y: 72 };
    const p2 = { x: 524, y: 170 };
    const p3 = { x: 551, y: 306 };
    return {
      x: oneMinus ** 3 * p0.x + 3 * oneMinus ** 2 * p * p1.x + 3 * oneMinus * p ** 2 * p2.x + p ** 3 * p3.x,
      y: oneMinus ** 3 * p0.y + 3 * oneMinus ** 2 * p * p1.y + 3 * oneMinus * p ** 2 * p2.y + p ** 3 * p3.y,
    };
  }

  function streamTangent(progress) {
    const p = clamp(progress, 0, 1);
    const oneMinus = 1 - p;
    const p0 = { x: 490, y: -18 };
    const p1 = { x: 502, y: 72 };
    const p2 = { x: 524, y: 170 };
    const p3 = { x: 551, y: 306 };
    return {
      x: 3 * oneMinus ** 2 * (p1.x - p0.x) + 6 * oneMinus * p * (p2.x - p1.x) + 3 * p ** 2 * (p3.x - p2.x),
      y: 3 * oneMinus ** 2 * (p1.y - p0.y) + 6 * oneMinus * p * (p2.y - p1.y) + 3 * p ** 2 * (p3.y - p2.y),
    };
  }

  function streamHalfWidth(progress) {
    const p = clamp(progress, 0, 1);
    return 27 - 13 * p + 2.4 * Math.sin(p * Math.PI * 3.0);
  }

  function removeEmbeddedWaterStream() {
    const image = cleanCtx.getImageData(0, 0, logical.width, logical.height);
    const data = image.data;
    const maxY = 316;
    for (let y = 0; y <= maxY; y += 1) {
      const p = clamp((y + 18) / 324, 0, 1);
      const center = streamPoint(p).x;
      const radius = Math.max(12, streamHalfWidth(p) + 8);
      const edge = 16;
      const leftSampleX = Math.max(0, Math.round(center - radius - edge));
      const rightSampleX = Math.min(logical.width - 1, Math.round(center + radius + edge));
      const li = (y * logical.width + leftSampleX) * 4;
      const ri = (y * logical.width + rightSampleX) * 4;
      for (let x = Math.floor(center - radius - 6); x <= Math.ceil(center + radius + 6); x += 1) {
        if (x < 0 || x >= logical.width) continue;
        const distance = Math.abs(x - center);
        const feather = clamp((radius + 6 - distance) / 12, 0, 1);
        if (feather <= 0) continue;
        const t = clamp((x - leftSampleX) / Math.max(rightSampleX - leftSampleX, 1), 0, 1);
        const idx = (y * logical.width + x) * 4;
        for (let c = 0; c < 3; c += 1) {
          const interpolated = data[li + c] * (1 - t) + data[ri + c] * t;
          data[idx + c] = Math.round(data[idx + c] * (1 - feather) + interpolated * feather);
        }
      }
    }
    cleanCtx.putImageData(image, 0, 0);
  }

  function softenStaticCoffee() {
    cleanCtx.save();
    carafeInteriorPath(cleanCtx, 1128, 1218);
    cleanCtx.clip();
    cleanCtx.globalAlpha = 0.98;
    cleanCtx.drawImage(sourceCanvas, 275, 1015, 570, 112, 275, 1115, 570, 112);
    const glassWash = cleanCtx.createLinearGradient(0, 1110, 0, 1225);
    glassWash.addColorStop(0, "rgba(214,196,170,0.10)");
    glassWash.addColorStop(0.58, "rgba(157,128,98,0.18)");
    glassWash.addColorStop(1, "rgba(70,49,34,0.30)");
    cleanCtx.fillStyle = glassWash;
    cleanCtx.fillRect(250, 1110, 620, 120);
    cleanCtx.restore();
  }

  const liquidRegion = {
    topY: 995,
    bottomY: 1218,
  };
  const volumeTable = buildLiquidVolumeTable();

  function carafeHalfWidthAt(y) {
    if (y <= 660) return 194;
    if (y <= 760) return lerp(194, 214, (y - 660) / 100);
    if (y <= 915) return lerp(214, 255, (y - 760) / 155);
    if (y <= 1035) return lerp(255, 292, (y - 915) / 120);
    if (y <= 1138) return lerp(292, 276, (y - 1035) / 103);
    return lerp(276, 241, clamp((y - 1138) / 80, 0, 1));
  }

  function buildLiquidVolumeTable() {
    const samples = [{ y: liquidRegion.bottomY, area: 0 }];
    let area = 0;
    for (let y = liquidRegion.bottomY - 1; y >= liquidRegion.topY; y -= 1) {
      const width0 = carafeHalfWidthAt(y) * 2;
      const width1 = carafeHalfWidthAt(y + 1) * 2;
      area += (width0 + width1) * 0.5;
      samples.push({ y, area });
    }
    return {
      samples,
      totalArea: Math.max(area, 1),
    };
  }

  function liquidTopYForRatio(ratio) {
    const effectiveRatio = clamp(Math.pow(clamp(ratio, 0, 1), 0.92), 0, 1);
    if (effectiveRatio <= 0) return liquidRegion.bottomY;
    if (effectiveRatio >= 1) return liquidRegion.topY;

    const targetArea = volumeTable.totalArea * effectiveRatio;
    const samples = volumeTable.samples;
    for (let i = 1; i < samples.length; i += 1) {
      const lower = samples[i - 1];
      const upper = samples[i];
      if (upper.area >= targetArea) {
        const span = Math.max(upper.area - lower.area, 1e-9);
        const t = clamp((targetArea - lower.area) / span, 0, 1);
        return lerp(lower.y, upper.y, t);
      }
    }
    return liquidRegion.topY;
  }

  function carafeInteriorPath(target, topY, bottomY) {
    const centerX = 556;
    const top = clamp(topY, 660, 1218);
    const bottom = clamp(bottomY, top, 1223);
    const steps = 18;
    target.beginPath();
    for (let i = 0; i <= steps; i += 1) {
      const y = top + ((bottom - top) * i) / steps;
      const x = centerX - carafeHalfWidthAt(y);
      if (i === 0) target.moveTo(x, y);
      else target.lineTo(x, y);
    }
    for (let i = steps; i >= 0; i -= 1) {
      const y = top + ((bottom - top) * i) / steps;
      const x = centerX + carafeHalfWidthAt(y);
      target.lineTo(x, y);
    }
    target.closePath();
  }

  function drawCoffeeLevel() {
    const ratio = clamp(state.cupRatio, 0, 1);
    if (ratio < 0.002) return;

    const centerX = 556;
    const bottomY = liquidRegion.bottomY;
    const topY = liquidTopYForRatio(ratio);
    const halfWidth = Math.max(0, carafeHalfWidthAt(topY) - 1.5);

    ctx.save();
    carafeInteriorPath(ctx, topY, bottomY);
    ctx.clip();

    // Reuse the photographed coffee itself as the liquid texture. The source
    // strip is stretched only vertically, while the carafe clip preserves the
    // real glass silhouette. This keeps bubbles, reflections, and tonal
    // variation from the reference image instead of painting a flat brown fill.
    ctx.globalAlpha = 0.94;
    // Stretch only the darker body. Keep the photographed crema/bubble line
    // at its native vertical scale so the liquid surface does not look smeared.
    ctx.drawImage(
      sourceCanvas,
      252, 1154, 610, 66,
      252, topY + 10, 610, Math.max(8, bottomY - topY - 7),
    );
    ctx.drawImage(
      sourceCanvas,
      252, 1138, 610, 20,
      252, topY - 3, 610, 20,
    );

    ctx.globalCompositeOperation = "multiply";
    ctx.globalAlpha = 0.34;
    const liquid = ctx.createLinearGradient(0, topY, 0, bottomY);
    liquid.addColorStop(0, "rgba(108,55,24,0.72)");
    liquid.addColorStop(0.35, "rgba(67,31,14,0.78)");
    liquid.addColorStop(1, "rgba(24,14,9,0.88)");
    ctx.fillStyle = liquid;
    ctx.fillRect(centerX - 330, topY - 4, 660, bottomY - topY + 12);

    // Bring the glass condensation and specular highlights back over the coffee.
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.14;
    ctx.drawImage(cleanCanvas, 245, topY, 622, bottomY - topY, 245, topY, 622, bottomY - topY);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.save();
    const wave = reduceMotion ? 0 : Math.sin(state.time * 2.6) * 1.5;
    const surfaceY = topY + wave;
    const meniscusDepth = 8.5;
    const surface = ctx.createLinearGradient(centerX - halfWidth, surfaceY, centerX + halfWidth, surfaceY);
    surface.addColorStop(0, "rgba(82,38,18,0.50)");
    surface.addColorStop(0.18, "rgba(214,132,65,0.62)");
    surface.addColorStop(0.52, "rgba(121,61,27,0.66)");
    surface.addColorStop(0.82, "rgba(209,129,61,0.56)");
    surface.addColorStop(1, "rgba(60,29,15,0.58)");

    ctx.globalAlpha = 0.82;
    ctx.strokeStyle = surface;
    ctx.lineWidth = 3.8;
    ctx.beginPath();
    ctx.ellipse(centerX, surfaceY, halfWidth * 0.962, meniscusDepth, 0, Math.PI, Math.PI * 2);
    ctx.stroke();

    ctx.globalAlpha = 0.20;
    ctx.fillStyle = "rgba(255,228,190,0.9)";
    ctx.beginPath();
    ctx.ellipse(centerX, surfaceY - 1.4, halfWidth * 0.52, 3.1, 0, Math.PI, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = "rgba(34,18,10,0.95)";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.ellipse(centerX, surfaceY + 4.8, halfWidth * 0.95, meniscusDepth * 0.86, 0, 0, Math.PI);
    ctx.stroke();

    if (!reduceMotion && ratio > 0.08) {
      for (let i = 0; i < 9; i += 1) {
        const phase = state.time * 0.45 + i * 1.73;
        const bx = centerX - halfWidth * 0.78 + ((i * 71) % Math.max(30, halfWidth * 1.5));
        const by = topY - 1 + Math.sin(phase) * 2.4;
        ctx.globalAlpha = 0.16 + 0.08 * Math.sin(phase) ** 2;
        ctx.fillStyle = "rgba(234,166,91,0.92)";
        ctx.beginPath();
        ctx.arc(bx, by, 1.6 + (i % 3) * 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawPhotoWaterStream() {
    const intensity = clamp(state.pour, 0, 1);
    if (intensity < 0.025 || !photoReady) return;

    const samples = 34;
    const left = [];
    const right = [];
    for (let i = 0; i <= samples; i += 1) {
      const p = i / samples;
      const point = streamPoint(p);
      const pulseWidth = reduceMotion ? 0 : Math.sin(state.time * 7.5 - p * 18) * 1.6;
      const half = streamHalfWidth(p) + 4 + pulseWidth;
      left.push({ x: point.x - half, y: point.y });
      right.push({ x: point.x + half, y: point.y });
    }

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(left[0].x, left[0].y);
    for (const point of left) ctx.lineTo(point.x, point.y);
    for (let i = right.length - 1; i >= 0; i -= 1) ctx.lineTo(right[i].x, right[i].y);
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha = 0.88 + intensity * 0.12;
    ctx.drawImage(sourceCanvas, 0, 0);

    if (!reduceMotion) {
      const travel = (state.time * (0.95 + intensity * 0.55)) % 1;
      const bands = [travel, (travel + 0.34) % 1, (travel + 0.67) % 1];
      for (const center of bands) {
        const points = [];
        const span = 0.15;
        const bandSamples = 14;
        for (let i = 0; i <= bandSamples; i += 1) {
          const offset = ((i / bandSamples) - 0.5) * span;
          const p = clamp(center + offset, 0.02, 0.99);
          points.push(streamPoint(p));
        }
        if (points.length > 1) {
          const gradient = ctx.createLinearGradient(points[0].x, points[0].y, points[points.length - 1].x, points[points.length - 1].y);
          gradient.addColorStop(0, 'rgba(255,255,255,0.00)');
          gradient.addColorStop(0.18, 'rgba(255,247,235,0.18)');
          gradient.addColorStop(0.5, 'rgba(255,255,255,0.34)');
          gradient.addColorStop(0.82, 'rgba(255,243,225,0.14)');
          gradient.addColorStop(1, 'rgba(255,255,255,0.00)');
          ctx.strokeStyle = gradient;
          ctx.globalAlpha = 0.55;
          ctx.lineCap = 'round';
          ctx.lineWidth = 8.2;
          ctx.beginPath();
          ctx.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
          ctx.stroke();
        }
      }

      ctx.globalAlpha = 0.16 + intensity * 0.12;
      ctx.strokeStyle = 'rgba(255,255,255,0.90)';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i <= 22; i += 1) {
        const p = i / 22;
        const point = streamPoint(p);
        const shimmer = Math.sin(state.time * 8.8 - p * 20) * 1.8;
        if (i === 0) ctx.moveTo(point.x + shimmer, point.y);
        else ctx.lineTo(point.x + shimmer, point.y);
      }
      ctx.stroke();
    }
    ctx.restore();

    if (!reduceMotion) {
      const dropletStarts = [0.08, 0.36, 0.66];
      for (let i = 0; i < dropletStarts.length; i += 1) {
        const p = (state.time * (0.62 + intensity * 0.42) + dropletStarts[i]) % 1;
        const point = streamPoint(p);
        const tangent = streamTangent(p);
        const angle = Math.atan2(tangent.y, tangent.x) + Math.PI / 2;
        const size = 3.1 + (1 - p) * 1.3 + i * 0.22;
        ctx.save();
        ctx.translate(point.x, point.y);
        ctx.rotate(angle);
        ctx.globalAlpha = 0.16 + intensity * 0.16;
        ctx.fillStyle = 'rgba(255,248,238,0.92)';
        ctx.beginPath();
        ctx.moveTo(0, -size * 1.15);
        ctx.bezierCurveTo(size * 0.95, -size * 0.2, size * 0.85, size * 0.9, 0, size * 1.28);
        ctx.bezierCurveTo(-size * 0.85, size * 0.9, -size * 0.95, -size * 0.2, 0, -size * 1.15);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  function drawExtractionDrops() {
    const intensity = clamp(state.drip, 0, 1);
    if (intensity < 0.035) return;

    ctx.save();
    const count = intensity > 0.62 ? 3 : 2;
    for (let i = 0; i < count; i += 1) {
      const p = reduceMotion ? (i + 1) / (count + 1) : (state.time * (0.38 + intensity * 0.28) + i * 0.43) % 1;
      const x = 555 + Math.sin(p * Math.PI * 2 + i) * 2.4;
      const y = 610 + p * 240;
      ctx.globalAlpha = 0.18 + intensity * 0.24;
      ctx.fillStyle = "rgba(76,35,16,0.90)";
      ctx.beginPath();
      ctx.ellipse(x, y, 2.7 + intensity, 6.2 + intensity * 6.8, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawBedResponse() {
    const intensity = clamp(state.pour * 0.7 + state.bloom * 0.88, 0, 1);
    if (intensity < 0.05) return;
    const phase = reduceMotion ? 0.35 : (state.time * 1.45) % 1;
    ctx.save();
    ctx.globalAlpha = (1 - phase) * (0.045 + intensity * 0.07);
    ctx.strokeStyle = "rgba(245,222,190,0.88)";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(505, 432, 20 + phase * 30, 5 + phase * 7, -0.03, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawSteam() {
    const energy = clamp(state.wetness * 0.72 + state.pour * 0.28, 0, 1);
    if (energy < 0.25) return;
    ctx.save();
    ctx.lineCap = "round";
    ctx.filter = "blur(1px)";
    for (let i = 0; i < 2; i += 1) {
      const phase = reduceMotion ? i * 0.55 : state.time * (0.34 + i * 0.05) + i * 1.8;
      const drift = Math.sin(phase) * 12;
      ctx.globalAlpha = 0.025 + energy * (0.03 + i * 0.006);
      ctx.strokeStyle = "rgba(255,248,237,0.94)";
      ctx.lineWidth = 2.5 - i * 0.35;
      ctx.beginPath();
      ctx.moveTo(445 + i * 110, 420);
      ctx.bezierCurveTo(430 + i * 110 + drift, 370, 466 + i * 95 - drift, 333, 448 + i * 106 + drift * 0.4, 296);
      ctx.stroke();
    }
    ctx.restore();
  }

  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  if (observer) observer.observe(canvas);
  else window.addEventListener("resize", resize, { passive: true });

  if (photo.complete && photo.naturalWidth) preparePhoto();
  else photo.addEventListener("load", preparePhoto, { once: true });
  requestAnimationFrame(resize);

  return { render, getState };
}

function interpolateTimeSeries(series, time) {
  if (!series.length) return {};
  if (time <= Number(series[0].time_s)) return series[0];
  const last = series[series.length - 1];
  if (time >= Number(last.time_s)) return last;

  let lo = 0;
  let hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (Number(series[mid].time_s) <= time) lo = mid;
    else hi = mid;
  }

  const a = series[lo];
  const b = series[hi];
  const span = Math.max(Number(b.time_s) - Number(a.time_s), 1e-9);
  const t = clamp((time - Number(a.time_s)) / span, 0, 1);
  const output = { time_s: time };
  for (const key of [
    "inlet_flow_g_s",
    "outlet_flow_g_s",
    "cup_water_g",
    "retained_water_g",
    "bed_water_g",
    "mobile_bed_water_g",
    "immobile_retained_water_g",
    "pool_water_g",
    "tds_percent",
    "extraction_yield_percent",
  ]) {
    output[key] = lerp(Number(a[key]) || 0, Number(b[key]) || 0, t);
  }
  return output;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}


function normalizeBrewPayload(payload) {
  return {
    coffee_dose_g: payload.coffee_dose_g,
    end_s: Math.max(payload.simulation_end_s, 1),
    total_water_g: payload.pours.reduce((sum, pour) => sum + pour.water_g, 0),
    pours: payload.pours.map((pour) => ({
      ...pour,
      duration_s: Math.max(pour.end_s - pour.start_s, 1),
    })),
  };
}

function pouredWaterAt(time, pours) {
  return pours.reduce((sum, pour) => {
    if (time <= pour.start_s) return sum;
    if (time >= pour.end_s) return sum + pour.water_g;
    return sum + pour.water_g * ((time - pour.start_s) / pour.duration_s);
  }, 0);
}


function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function setStatus(message, isError = false, stateName = null) {
  if (elements.statusCopy) elements.statusCopy.textContent = message;
  else elements.status.textContent = message;
  elements.status.dataset.state = stateName || (isError ? "error" : "ok");
}

function format(value, digits) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "--";
}

init();
