"use strict";

const state = {
  defaults: null,
  lastResult: null,
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
  chart: document.getElementById("chart"),
};

async function init() {
  bindEvents();
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
  setStatus("Running...");
  elements.runButton.disabled = true;
  try {
    const response = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload()),
    });
    const data = await readJsonResponse(response);
    if (!response.ok || !data.ok) throw new Error(data.error || "Simulation failed.");
    state.lastResult = data;
    renderResult(data);
    setStatus("Complete.");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    elements.runButton.disabled = false;
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
  elements.retainedWater.textContent = `${format(summary.retained_water_g, 1)} g`;
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
  drawChart(data.time_series);
}

function renderCheck(element, label, ok) {
  element.textContent = `${label}: ${ok ? "ok" : "check"}`;
  element.dataset.state = ok ? "ok" : "warn";
}

function drawEmptyChart() {
  const ctx = elements.chart.getContext("2d");
  ctx.clearRect(0, 0, elements.chart.width, elements.chart.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, elements.chart.width, elements.chart.height);
  ctx.fillStyle = "#52667a";
  ctx.font = "16px Arial";
  ctx.textAlign = "center";
  ctx.fillText("Run simulation to display the time series.", elements.chart.width / 2, elements.chart.height / 2);
}

function drawChart(series) {
  const canvas = elements.chart;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const margin = { left: 86, right: 42, top: 38, bottom: 66 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const maxTime = Math.max(...series.map((point) => point.time_s), 1);
  const maxWater = Math.max(
    ...series.map((point) => Math.max(point.cup_water_g, point.retained_water_g, point.pool_water_g)),
    1,
  );
  const maxOutput = Math.max(
    ...series.map((point) => Math.max(point.tds_percent, point.extraction_yield_percent)),
    1,
  );

  drawAxes(ctx, margin, plotW, plotH, maxTime);
  drawLine(ctx, series, "cup_water_g", "#0072B2", margin, plotW, plotH, maxTime, maxWater);
  drawLine(ctx, series, "retained_water_g", "#009E73", margin, plotW, plotH, maxTime, maxWater);
  drawLine(ctx, series, "pool_water_g", "#E69F00", margin, plotW, plotH, maxTime, maxWater);
  drawLine(ctx, series, "extraction_yield_percent", "#D55E00", margin, plotW, plotH, maxTime, maxOutput, [8, 6]);
  drawLegend(ctx, margin);
}

function drawAxes(ctx, margin, plotW, plotH, maxTime) {
  ctx.strokeStyle = "#8a8f94";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + plotH);
  ctx.lineTo(margin.left + plotW, margin.top + plotH);
  ctx.stroke();

  ctx.fillStyle = "#555";
  ctx.font = "14px Arial";
  ctx.textAlign = "center";
  ctx.fillText("Time (s)", margin.left + plotW / 2, margin.top + plotH + 42);

  ctx.save();
  ctx.translate(28, margin.top + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Water inventory (g), EY (%) scale", 0, 0);
  ctx.restore();

  const ticks = 5;
  for (let i = 0; i <= ticks; i += 1) {
    const x = margin.left + (plotW * i) / ticks;
    const label = (maxTime * i / ticks).toFixed(0);
    ctx.beginPath();
    ctx.moveTo(x, margin.top + plotH);
    ctx.lineTo(x, margin.top + plotH + 5);
    ctx.stroke();
    ctx.fillText(label, x, margin.top + plotH + 24);
  }
}

function drawLine(ctx, series, key, color, margin, plotW, plotH, maxTime, maxY, dash = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.setLineDash(dash);
  ctx.beginPath();
  series.forEach((point, index) => {
    const x = margin.left + (point.time_s / maxTime) * plotW;
    const y = margin.top + plotH - (point[key] / maxY) * plotH;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawLegend(ctx, margin) {
  const items = [
    ["Cup water (g)", "#0072B2", []],
    ["Retained water (g)", "#009E73", []],
    ["Pooled water (g)", "#E69F00", []],
    ["EY (%)", "#D55E00", [8, 6]],
  ];
  let x = margin.left + 12;
  const y = margin.top - 17;
  ctx.font = "14px Arial";
  ctx.textAlign = "left";
  for (const [label, color, dash] of items) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 28, y);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = "#333";
    ctx.fillText(label, x + 36, y + 5);
    x += ctx.measureText(label).width + 74;
  }
}

function grindLanguageForD90(d90) {
  if (d90 >= 1480) return "coarse";
  if (d90 >= 1280) return "medium-coarse";
  if (d90 >= 1060) return "medium";
  if (d90 >= 920) return "medium-fine";
  return "fine";
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.dataset.state = isError ? "error" : "ok";
}

function format(value, digits) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "--";
}

init();
