(() => {
  "use strict";

  // ── Config ───────────────────────────────────────────────────────────────────
  // Empty string = same origin (nginx proxy). Set to "http://localhost:8000"
  // when opening the frontend directly from the filesystem during development.
  const API     = "";
  const WMS_URL = `${API}/wms`;

  // Named constants for values that would otherwise be unexplained magic numbers
  const WMS_OPACITY            = 0.7;
  const CHART_LINE_TENSION     = 0.35;
  const CHART_ANIMATION_MS     = 300;
  const SLIDER_DEBOUNCE_MS     = 300;
  const POINT_RADIUS_THRESHOLD = 50;   // use smaller dots above this many data points

  // ── State ────────────────────────────────────────────────────────────────────
  let variables      = [];   // [{name, long_name, units, n_times, times}, ...]
  let currentVar     = null;
  let currentTimeIdx = 0;
  let wmsLayer       = null;
  let chart          = null;

  // ── DOM refs ─────────────────────────────────────────────────────────────────
  const varSelect   = document.getElementById("var-select");
  const timeCtrl    = document.getElementById("time-ctrl");
  const timeSlider  = document.getElementById("time-slider");
  const timeLabel   = document.getElementById("time-label");
  const legendImg   = document.getElementById("legend-img");
  const statusBar   = document.getElementById("status-bar");
  const chartTitle  = document.getElementById("chart-title");
  const chartCanvas = document.getElementById("timechart");
  const noDataMsg   = document.getElementById("no-data-msg");
  const spinner     = document.getElementById("map-spinner");

  // ── Utilities ────────────────────────────────────────────────────────────────
  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function formatTimestamp(isoString) {
    if (!isoString || isoString === "0") return "";
    try {
      return new Date(isoString).toLocaleString(undefined, {
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch {
      return isoString;
    }
  }

  // ── Map initialisation ───────────────────────────────────────────────────────
  const map = L.map("map", {
    center: [55, 15],
    zoom: 4,
    zoomControl: true,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);

  // ── WMS layer ────────────────────────────────────────────────────────────────
  function buildWmsLayer(varName, timeString) {
    const params = {
      service:     "WMS",
      version:     "1.1.1",
      request:     "GetMap",
      layers:      varName,
      format:      "image/png",
      transparent: true,
      srs:         "EPSG:4326",
      styles:      "",
    };
    if (timeString) params.time = timeString;

    return L.tileLayer.wms(WMS_URL, {
      ...params,
      opacity:     WMS_OPACITY,
      attribution: "Weather data (GRIB2)",
    });
  }

  function refreshWmsLayer() {
    if (!currentVar) return;
    const meta      = variables.find((v) => v.name === currentVar);
    const timeString = meta?.times?.length > 0 ? meta.times[currentTimeIdx] : null;

    if (wmsLayer) map.removeLayer(wmsLayer);
    wmsLayer = buildWmsLayer(currentVar, timeString);
    wmsLayer.addTo(map);
    wmsLayer.on("loading", () => { spinner.style.display = "block"; });
    wmsLayer.on("load",    () => { spinner.style.display = "none";  });
  }

  // ── Legend ───────────────────────────────────────────────────────────────────
  function refreshLegend() {
    if (!currentVar) { legendImg.style.display = "none"; return; }
    legendImg.src = `${API}/wms/legend?layer=${encodeURIComponent(currentVar)}`;
    legendImg.style.display = "block";
  }

  // ── Variable selector ────────────────────────────────────────────────────────
  function populateVarSelect() {
    varSelect.innerHTML = "";
    if (variables.length === 0) {
      varSelect.innerHTML = '<option value="">No data loaded</option>';
      statusBar.textContent = "No GRIB2 file found — place sample.grib2 in ./data/";
      return;
    }
    for (const v of variables) {
      const opt = document.createElement("option");
      opt.value       = v.name;
      opt.textContent = `${v.long_name || v.name} (${v.units})`;
      varSelect.appendChild(opt);
    }
    selectVariable(variables[0].name);
  }

  function selectVariable(name) {
    currentVar     = name;
    currentTimeIdx = 0;
    const meta     = variables.find((v) => v.name === name);

    if (meta && meta.n_times > 1) {
      timeCtrl.style.display  = "flex";
      timeSlider.max          = meta.n_times - 1;
      timeSlider.value        = 0;
      timeLabel.textContent   = meta.times[0] || "Step 0";
    } else {
      timeCtrl.style.display = "none";
      timeLabel.textContent  = "";
    }

    refreshWmsLayer();
    refreshLegend();
    statusBar.textContent = `Showing: ${meta?.long_name ?? name}`;
  }

  varSelect.addEventListener("change", () => {
    if (varSelect.value) selectVariable(varSelect.value);
  });

  // Debounced so dragging the slider doesn't flood the backend with tile requests
  const onSliderMove = debounce(() => {
    currentTimeIdx = parseInt(timeSlider.value, 10);
    const meta     = variables.find((v) => v.name === currentVar);
    timeLabel.textContent = meta?.times[currentTimeIdx] ?? `Step ${currentTimeIdx}`;
    refreshWmsLayer();
  }, SLIDER_DEBOUNCE_MS);

  timeSlider.addEventListener("input", onSliderMove);

  // ── Chart ────────────────────────────────────────────────────────────────────
  function initChart() {
    chart = new Chart(chartCanvas, {
      type: "line",
      data: { labels: [], datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: CHART_ANIMATION_MS },
        plugins: {
          legend: { labels: { color: "#e0e0f0", font: { size: 11 } } },
          tooltip: {
            backgroundColor: "#16213e",
            titleColor:      "#4cc9f0",
            bodyColor:       "#e0e0f0",
            borderColor:     "#2a2a4a",
            borderWidth: 1,
          },
        },
        scales: {
          x: {
            ticks: { color: "#8888aa", font: { size: 10 }, maxTicksLimit: 8 },
            grid:  { color: "#2a2a4a" },
          },
          y: {
            ticks: { color: "#8888aa", font: { size: 10 } },
            grid:  { color: "#2a2a4a" },
          },
        },
      },
    });
  }

  function updateChart(data) {
    if (!chart) initChart();

    const labels = data.times.map(formatTimestamp);
    const pointRadius = data.values.length < POINT_RADIUS_THRESHOLD ? 4 : 1;

    chart.data.labels = labels;
    chart.data.datasets = [{
      label:           `${data.long_name || data.variable} (${data.units})`,
      data:            data.values,
      borderColor:     "#4cc9f0",
      backgroundColor: "rgba(76,201,240,0.15)",
      borderWidth:     2,
      pointRadius,
      pointHoverRadius: 6,
      tension:         CHART_LINE_TENSION,
      fill:            true,
    }];
    chart.update();

    noDataMsg.style.display   = "none";
    chartCanvas.style.display = "block";
  }

  function clearChart() {
    noDataMsg.style.display   = "flex";
    chartCanvas.style.display = "none";
  }

  // ── Map click — point query ───────────────────────────────────────────────────
  map.on("click", async (e) => {
    if (!currentVar) return;
    const { lat, lng } = e.latlng;
    statusBar.textContent = `Querying (${lat.toFixed(3)}, ${lng.toFixed(3)})…`;
    chartTitle.textContent = `Timeseries at ${lat.toFixed(3)}°N, ${lng.toFixed(3)}°E`;

    try {
      const url = `${API}/data?var=${encodeURIComponent(currentVar)}&lat=${lat}&lon=${lng}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      updateChart(data);
      statusBar.textContent =
        `Point: ${lat.toFixed(3)}°N ${lng.toFixed(3)}°E — ${data.values.length} step(s)`;
    } catch (err) {
      statusBar.textContent = `Error: ${err.message}`;
      clearChart();
    }
  });

  // ── Info panel ───────────────────────────────────────────────────────────────
  const infoToggle = document.getElementById("info-toggle");
  const infoBody   = document.getElementById("info-body");

  infoToggle.addEventListener("click", () => {
    const isOpen = infoBody.classList.toggle("open");
    infoToggle.classList.toggle("open", isOpen);
  });

  function buildInfoRow(key, val) {
    if (val === null || val === undefined || val === "") return "";
    return (
      `<div class="info-row">` +
      `<span class="info-key">${key}</span>` +
      `<span class="info-val">${val}</span>` +
      `</div>`
    );
  }

  async function loadInfo() {
    try {
      const res = await fetch(`${API}/info`);
      if (!res.ok) {
        infoBody.innerHTML = buildInfoRow("Error", `HTTP ${res.status}`);
        return;
      }
      const d = await res.json();

      if (!d.available) {
        infoBody.innerHTML = buildInfoRow("Status", "No file loaded");
        return;
      }

      const extent = d.lat_min != null
        ? `${d.lat_min.toFixed(2)}°–${d.lat_max.toFixed(2)}°N, ` +
          `${d.lon_min.toFixed(2)}°–${d.lon_max.toFixed(2)}°E`
        : "—";

      const resolution = d.lat_resolution_deg != null
        ? `${d.lat_resolution_deg}° × ${d.lon_resolution_deg}°`
        : "—";

      const timeRange = d.timesteps?.length
        ? `${d.n_timesteps} steps · ${d.timesteps[0]} → ${d.timesteps.at(-1)}`
        : "—";

      infoBody.innerHTML = [
        buildInfoRow("File",         d.filename),
        buildInfoRow("Size",         `${d.size_mb} MB`),
        buildInfoRow("GRIB edition", d.grib_edition ? `GRIB${d.grib_edition}` : "—"),
        buildInfoRow("Centre",       d.originating_centre ?? "—"),
        buildInfoRow("Grid type",    d.grid_type ?? "—"),
        buildInfoRow("Extent",       extent),
        buildInfoRow("Resolution",   resolution),
        buildInfoRow("Variables",    `${d.n_variables} (${d.variables.join(", ")})`),
        buildInfoRow("Time steps",   timeRange),
      ].join("");
    } catch (err) {
      infoBody.innerHTML = buildInfoRow("Error", err.message);
      console.error("loadInfo failed:", err);
    }
  }

  // ── Boot ─────────────────────────────────────────────────────────────────────
  async function boot() {
    initChart();
    clearChart();

    try {
      const res = await fetch(`${API}/variables`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      variables = json.variables || [];
      populateVarSelect();
      loadInfo();
    } catch (err) {
      statusBar.textContent = `Failed to reach backend: ${err.message}`;
      varSelect.innerHTML   = '<option value="">Backend unavailable</option>';
    }
  }

  boot();
})();
