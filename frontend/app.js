(() => {
  "use strict";

  // ── Config ───────────────────────────────────────────────────────────────────
  // Empty string = same origin (nginx proxy). Set to "http://localhost:8000"
  // when opening the frontend directly from the filesystem during development.
  const API = "";

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
  let wmsImageryLayer = null;   // Cesium ImageryLayer for the current WMS overlay
  let queryEntity     = null;   // Cesium Entity for the click marker
  let chart           = null;

  // ── DOM refs ─────────────────────────────────────────────────────────────────
  const varSelect   = document.getElementById("var-select");
  const timeCtrl    = document.getElementById("time-ctrl");
  const timeSlider  = document.getElementById("time-slider");
  const timeLabel   = document.getElementById("time-label");
  const legendImg   = document.getElementById("legend-img");
  const statusBar   = document.getElementById("status-bar");
  const chartPanel  = document.getElementById("chart-panel");
  const chartClose  = document.getElementById("chart-close");
  const chartTitle  = document.getElementById("chart-title");
  const chartCanvas = document.getElementById("timechart");
  const noDataMsg   = document.getElementById("no-data-msg");
  const spinner     = document.getElementById("map-spinner");

  // ── Utilities ────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

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

  // ── Cesium globe initialisation ──────────────────────────────────────────────
  // Suppress console warnings about the missing ion token — we use OSM + our own
  // WMS, so no ion services are needed.
  Cesium.Ion.defaultAccessToken = "";

  const viewer = new Cesium.Viewer("globe", {
    animation:             false,
    timeline:              false,
    geocoder:              false,
    homeButton:            false,
    sceneModePicker:       false,
    navigationHelpButton:  false,
    baseLayerPicker:       false,
    fullscreenButton:      false,
    infoBox:               false,
    selectionIndicator:    false,
    terrainProvider:       new Cesium.EllipsoidTerrainProvider(),
  });

  // Replace the default ion imagery with OpenStreetMap
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(
    new Cesium.OpenStreetMapImageryProvider({
      url:    "https://tile.openstreetmap.org/",
      credit: "© OpenStreetMap contributors",
    })
  );

  // Start looking at Europe
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(15, 52, 8_000_000),
  });

  // Drive the spinner from Cesium's tile-load progress counter
  viewer.scene.globe.tileLoadProgressEvent.addEventListener((queued) => {
    spinner.style.display = queued > 0 ? "block" : "none";
  });

  // ── WMS layer ────────────────────────────────────────────────────────────────
  // Cesium uses EPSG:4326 (degrees) for WMS by default — the backend's
  // _is_mercator() check will recognise these BBOXes as geographic and take the
  // correct non-Mercator rendering path.
  function refreshWmsLayer() {
    if (!currentVar) return;
    const meta       = variables.find((v) => v.name === currentVar);
    const timeString = meta?.times?.length > 0 ? meta.times[currentTimeIdx] : null;

    if (wmsImageryLayer) {
      viewer.imageryLayers.remove(wmsImageryLayer);
    }

    const parameters = { transparent: true, format: "image/png" };
    if (timeString) parameters.TIME = timeString;

    wmsImageryLayer = viewer.imageryLayers.addImageryProvider(
      new Cesium.WebMapServiceImageryProvider({
        url:        `${API}/wms`,
        layers:     currentVar,
        parameters,
      })
    );
    wmsImageryLayer.alpha = WMS_OPACITY;
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
    timeLabel.textContent = meta?.times?.[currentTimeIdx] ?? `Step ${currentTimeIdx}`;
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

    const labels      = data.times.map(formatTimestamp);
    const pointRadius = data.values.length < POINT_RADIUS_THRESHOLD ? 4 : 1;

    chart.data.labels = labels;
    chart.data.datasets = [{
      label:            `${data.long_name || data.variable} (${data.units})`,
      data:             data.values,
      borderColor:      "#4cc9f0",
      backgroundColor:  "rgba(76,201,240,0.15)",
      borderWidth:      2,
      pointRadius,
      pointHoverRadius: 6,
      tension:          CHART_LINE_TENSION,
      fill:             true,
    }];
    chart.update();

    chartPanel.style.display  = "flex";
    noDataMsg.style.display   = "none";
    chartCanvas.style.display = "block";
  }

  function clearChart() {
    chartPanel.style.display  = "none";
    noDataMsg.style.display   = "flex";
    chartCanvas.style.display = "none";
  }

  // ── Query marker ─────────────────────────────────────────────────────────────
  function placeMarker(lat, lon) {
    if (queryEntity) viewer.entities.remove(queryEntity);
    queryEntity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: {
        pixelSize:        10,
        color:            Cesium.Color.fromCssColorString("#4cc9f0").withAlpha(0.3),
        outlineColor:     Cesium.Color.fromCssColorString("#4cc9f0"),
        outlineWidth:     2,
        heightReference:  Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  // ── Globe click — point query ─────────────────────────────────────────────────
  viewer.screenSpaceEventHandler.setInputAction(async (click) => {
    if (!currentVar) return;

    const cartesian = viewer.camera.pickEllipsoid(
      click.position,
      viewer.scene.globe.ellipsoid
    );
    if (!cartesian) return; // click landed on sky, not the globe

    const carto = Cesium.Cartographic.fromCartesian(cartesian);
    const lat   = Cesium.Math.toDegrees(carto.latitude);
    const lon   = Cesium.Math.toDegrees(carto.longitude);

    placeMarker(lat, lon);
    statusBar.textContent  = `Querying (${lat.toFixed(3)}, ${lon.toFixed(3)})…`;
    chartTitle.textContent = `Timeseries at ${lat.toFixed(3)}°N, ${lon.toFixed(3)}°E`;

    try {
      const url = `${API}/data?var=${encodeURIComponent(currentVar)}&lat=${lat}&lon=${lon}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      updateChart(data);
      statusBar.textContent =
        `Point: ${lat.toFixed(3)}°N ${lon.toFixed(3)}°E — ${data.values.length} step(s)`;
    } catch (err) {
      statusBar.textContent = `Error: ${err.message}`;
      clearChart();
    }
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  chartClose.addEventListener("click", () => {
    clearChart();
    if (queryEntity) {
      viewer.entities.remove(queryEntity);
      queryEntity = null;
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
      `<span class="info-key">${escHtml(key)}</span>` +
      `<span class="info-val">${escHtml(val)}</span>` +
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

  // ── Download panel ───────────────────────────────────────────────────────────
  const dlToggle      = document.getElementById("dl-toggle");
  const dlBody        = document.getElementById("dl-body");
  const dlProducer    = document.getElementById("dl-producer");
  const dlGentime     = document.getElementById("dl-gentime");
  const dlParamSearch = document.getElementById("dl-param-search");
  const dlParamList   = document.getElementById("dl-param-list");
  const dlParamInfo   = document.getElementById("dl-param-info");
  const dlGeometry     = document.getElementById("dl-geometry");
  const dlAnalysisTime = document.getElementById("dl-analysis-time");
  const dlTimesteps   = document.getElementById("dl-timesteps");
  const dlDownloadBtn = document.getElementById("dl-download-btn");
  const dlStatus      = document.getElementById("dl-status");

  let allParams     = [];
  let selectedParam = null;

  dlToggle.addEventListener("click", async () => {
    const opening = !dlBody.classList.contains("open");
    dlBody.classList.toggle("open");
    dlToggle.classList.toggle("open");
    if (opening && dlProducer.options.length <= 1) await fetchProducers();
  });

  async function fetchProducers() {
    dlProducer.innerHTML = '<option value="">— loading —</option>';
    try {
      const res = await fetch(`${API}/smartmet/producers`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = await res.json();
      dlProducer.innerHTML = "";
      for (const p of list) {
        const opt = document.createElement("option");
        opt.value            = p.ProducerName;
        opt.textContent      = `${p.ProducerName} — ${p.Description}`;
        opt.dataset.gentime  = p.NewestGeneration ?? "";
        dlProducer.appendChild(opt);
      }
      if (list.length > 0) onProducerChange();
    } catch (err) {
      dlProducer.innerHTML = `<option value="">Error: ${err.message}</option>`;
    }
  }

  // generationsByGeom: { "1008": {GeometryId, Timesteps, AnalysisTime, params: ["T-K", ...]} }
  let generationsByGeom = {};

  async function onProducerChange() {
    const opt = dlProducer.selectedOptions[0];
    dlGentime.textContent    = opt?.dataset.gentime ? `Latest: ${opt.dataset.gentime}` : "";
    generationsByGeom        = {};
    allParams                = [];
    selectedParam            = null;
    dlParamInfo.textContent  = "";
    dlParamSearch.value      = "";
    dlParamList.innerHTML    = "";
    dlGeometry.innerHTML     = '<option value="">Loading…</option>';
    dlAnalysisTime.textContent = "";

    if (!dlProducer.value) return;
    try {
      const res = await fetch(
        `${API}/smartmet/generations?producer=${encodeURIComponent(dlProducer.value)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const generations = await res.json();

      // Keep only the newest generation per geometry (list is newest-first)
      for (const g of generations) {
        const key = String(g.GeometryId);
        if (!generationsByGeom[key]) {
          generationsByGeom[key] = {
            GeometryId:   g.GeometryId,
            Timesteps:    g.Timesteps,
            AnalysisTime: g.AnalysisTime,
            params:       g.FmiParameters
              ? g.FmiParameters.split(",").map((s) => s.trim()).filter(Boolean)
              : [],
          };
        }
      }

      dlGeometry.innerHTML = "";
      for (const key of Object.keys(generationsByGeom)) {
        const opt = document.createElement("option");
        opt.value       = key;
        opt.textContent = `Geometry ${key}`;
        dlGeometry.appendChild(opt);
      }
      if (Object.keys(generationsByGeom).length > 0) onGeometryChange();
    } catch (err) {
      dlGeometry.innerHTML = `<option value="">Error: ${err.message}</option>`;
    }
  }

  function onGeometryChange() {
    const geom = generationsByGeom[dlGeometry.value];
    if (!geom) return;
    dlAnalysisTime.textContent =
      `Analysis: ${geom.AnalysisTime}  ·  ${geom.Timesteps} timesteps available`;
    dlTimesteps.value   = geom.Timesteps;
    allParams           = geom.params;
    selectedParam       = null;
    dlParamSearch.value = "";
    renderParamList(allParams);
  }

  function renderParamList(params) {
    dlParamList.innerHTML = "";
    for (const name of params) {
      const opt = document.createElement("option");
      opt.value = opt.textContent = name;
      dlParamList.appendChild(opt);
    }
  }

  dlProducer.addEventListener("change", onProducerChange);
  dlGeometry.addEventListener("change", onGeometryChange);

  dlParamSearch.addEventListener("input", () => {
    const q        = dlParamSearch.value.trim().toLowerCase();
    const filtered = q ? allParams.filter((n) => n.toLowerCase().includes(q)) : allParams;
    renderParamList(filtered);
    selectedParam = null;
  });

  dlParamList.addEventListener("change", () => {
    selectedParam = dlParamList.value || null;
  });

  dlDownloadBtn.addEventListener("click", async () => {
    if (!dlProducer.value)  { dlStatus.textContent = "Select a producer.";  return; }
    if (!dlGeometry.value)  { dlStatus.textContent = "Select a geometry.";  return; }
    if (!selectedParam)     { dlStatus.textContent = "Select a parameter."; return; }
    const steps = parseInt(dlTimesteps.value, 10);
    if (!steps || steps < 1) { dlStatus.textContent = "Enter a valid timestep count."; return; }

    dlDownloadBtn.disabled = true;
    dlStatus.textContent   = "Downloading… this may take a minute.";

    try {
      const res = await fetch(`${API}/smartmet/download`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          producer:  dlProducer.value,
          param:     selectedParam,
          timesteps: steps,
          geometry:  dlGeometry.value,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail ?? `HTTP ${res.status}`);
      }
      const data = await res.json();

      if (data.saved) {
        dlStatus.textContent = `Saved as ${data.file}. Reloading…`;
        await reloadVariables();
        dlStatus.textContent = `Done — ${data.file} loaded.`;
      } else {
        dlStatus.innerHTML =
          `${escHtml(data.error ?? "Could not save to server.")}<br>` +
          `URL tried: <a href="${data.url}" target="_blank">${escHtml(data.url)}</a>`;
      }
    } catch (err) {
      dlStatus.textContent = `Error: ${err.message}`;
    } finally {
      dlDownloadBtn.disabled = false;
    }
  });

  // ── Boot ─────────────────────────────────────────────────────────────────────
  async function reloadVariables() {
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

  async function boot() {
    initChart();
    clearChart();
    await reloadVariables();
  }

  boot();
})();
