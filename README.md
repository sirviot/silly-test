# Weather Visualizer

A browser-based GRIB2 weather data explorer. Drop a GRIB2 file into `data/`, start the
containers, and get an interactive map with WMS overlay, time slider, point timeseries
chart, and a data-info panel — no configuration required.

---

## Table of contents

1. [Architecture](#architecture)
2. [Project structure](#project-structure)
3. [Setup & running](#setup--running)
4. [Development workflow](#development-workflow)
5. [Configuration](#configuration)
6. [API reference](#api-reference)
7. [WMS details](#wms-details)
8. [Nginx tile cache](#nginx-tile-cache)
9. [Known limitations & gotchas](#known-limitations--gotchas)
10. [Extension ideas](#extension-ideas)

---

## Architecture

```
Browser
  │
  ▼
nginx :8080  (frontend container)
  ├── GET /             → serves frontend/index.html + app.js (static)
  ├── GET /wms?...      → proxy → FastAPI :8000  (cached)
  ├── GET /variables    → proxy → FastAPI :8000  (cached)
  ├── GET /data?...     → proxy → FastAPI :8000  (cached)
  ├── GET /data/bbox?.. → proxy → FastAPI :8000  (cached)
  ├── GET /info         → proxy → FastAPI :8000  (cached)
  └── GET /health       → proxy → FastAPI :8000  (cached)
        │
        ▼
  FastAPI / uvicorn :8000  (backend container)
        │
        ├── GribReader singleton  (loaded once on first request)
        │     └── cfgrib → xarray datasets in memory
        │
        └── ./data/sample.grib2  (volume mount, read-write)
```

**Request flow for a WMS tile:**

1. Leaflet requests a tile with a BBOX in EPSG:3857 metres.
2. nginx checks its disk cache — on HIT, returns the PNG immediately.
3. On MISS, the request reaches FastAPI's `/wms` endpoint.
4. `_render_data()` converts the EPSG:3857 BBOX pixel-by-pixel to lat/lon using the
   Mercator inverse formula, then queries a `RegularGridInterpolator` built from the
   GRIB data.
5. The result array is colourised with a matplotlib colormap and returned as a
   transparent RGBA PNG via Pillow.
6. nginx stores the PNG to disk and forwards it to the browser.

**Key design choices:**

| Choice | Reason |
|--------|--------|
| cfgrib + xarray | Standard Python stack for GRIB2; handles multi-dataset split files automatically |
| WMS 1.1.1 | Version that Leaflet's `L.tileLayer.wms` speaks natively |
| EPSG:3857 tiles + server-side Mercator reprojection | Lets the map use standard OSM tiles while keeping the WMS backend in lat/lon coordinates |
| Pillow for tile encoding | Faster and simpler than going through matplotlib's figure/axes system |
| nginx proxy cache | Zero code changes to the backend; survives backend restarts within a session |
| Single uvicorn worker | Sufficient for one user; easy to scale with `--workers N` |

---

## Project structure

```
weather-viz/
├── backend/
│   ├── Containerfile       # Python 3.11-slim image with eccodes/geos system libs
│   ├── pyproject.toml      # uv-compatible dependency manifest
│   ├── main.py             # FastAPI app: CORS, router registration, static file mount
│   ├── grib_reader.py      # GribReader class — all GRIB I/O lives here
│   ├── wms.py              # WMS 1.1.1 endpoints + Mercator tile renderer
│   └── data_api.py         # REST endpoints: /info, /variables, /data, /data/bbox
├── frontend/
│   ├── index.html          # Single-page app shell with dark-theme CSS
│   ├── app.js              # Leaflet map, Chart.js timeseries, sidebar, info panel
│   ├── nginx.conf          # nginx server block with proxy rules and cache config
│   └── nginx-cache.conf    # proxy_cache_path directive (http-context level)
├── data/                   # Drop .grib2 files here — mounted into the backend container
├── compose.yml             # Two services: backend (build) + frontend (nginx image)
└── README.md
```

### `backend/grib_reader.py` — the data layer

The central class. All GRIB access goes through here; nothing else imports cfgrib or xarray.

| Method | What it does |
|--------|-------------|
| `_load()` | Opens the GRIB2 file with `cfgrib.open_datasets()` on first call, caches the list of `xr.Dataset` objects. cfgrib commonly splits one file into multiple datasets (one per `typeOfLevel` / `shortName` combination). |
| `get_file_info()` | Returns file-level metadata: name, size, GRIB edition, originating centre, grid type, spatial extent, resolution, variable list, timesteps. |
| `list_variables()` | Returns per-variable metadata: CF long name, units, GRIB short name, number of timesteps, ISO-8601 time strings. |
| `get_slice(var, time_index)` | Returns a 2-D lat/lon/values dict for one variable at one time step. Handles vertical level flattening (takes index 0). |
| `get_point_timeseries(var, lat, lon)` | Nearest-neighbour lookup at a point. Supports both regular grids (via xarray `.sel(method='nearest')`) and curvilinear grids (manual distance search). |
| `get_bbox_subset(var, ...)` | Returns all grid points inside a lat/lon bounding box as a list of `{lat, lon, value}` dicts. |
| `get_reader()` | Module-level singleton factory. Returns the same `GribReader` for the lifetime of the process. |

**Datetime handling:** numpy datetime64 scalars returned by `.item()` are nanoseconds as
a plain Python int. All time values are converted through `pd.Timestamp(t)` which handles
ns/ms/s units correctly, avoiding the year-overflow bug that occurs when treating
nanoseconds as milliseconds.

### `backend/wms.py` — the WMS layer

Implements WMS 1.1.1 at a single `/wms` endpoint (query-string dispatch). Also exposes
`/wms/legend`.

**`_render_data(slc, minx, miny, maxx, maxy, width, height)`**

The core tile renderer. Steps:
1. Detects whether the BBOX is in EPSG:3857 (metres) or EPSG:4326 (degrees) by checking
   if any coordinate exceeds ±360° / ±90° — Leaflet always sends EPSG:3857 metres.
2. Creates a `(height, width)` query grid. For Mercator tiles, each pixel's metre
   coordinate is converted to lat/lon using the standard inverse Mercator formula:
   `lat = 2·atan(exp(y·π/R)) − π/2`, `lon = x·180/R` where `R = 20037508.34 m`.
3. Builds a `scipy.interpolate.RegularGridInterpolator` from the GRIB lat/lon grid
   (linear interpolation, NaN fill outside bounds).
4. Queries all `width × height` pixels in one vectorised call.
5. Returns the raw float array; colourisation happens in the route handler.

**Colormap selection** (`_pick_cmap`): substring match on the layer name against a
priority table. Add entries to `COLORMAPS` at the top of `wms.py` for new variable types.

| Key substring | Colormap |
|---|---|
| `temperature`, `t2m` | `RdYlBu_r` |
| `u10`, `v10` | `PuOr` |
| `tp` | `Blues` |
| `msl` | `RdYlGn` |
| `z` | `terrain` |
| `r` | `BrBG` |
| `q` | `YlGnBu` |
| _(anything else)_ | `viridis` |

### `frontend/app.js` — the UI

Pure ES2020 IIFE, no build tools, no TypeScript. All external dependencies via CDN.

| CDN library | Version | Purpose |
|---|---|---|
| Leaflet | 1.9.4 | Slippy map, WMS tile layer, click events |
| Chart.js | 4.4.3 | Timeseries line chart at the bottom |

**Boot sequence:** `boot()` → `GET /variables` → `populateVarSelect()` + `loadInfo()` →
`selectVariable(first)` → `refreshWmsLayer()` + `refreshLegend()`.

**WMS layer lifecycle:** every variable or time-step change removes the old
`L.tileLayer.wms` instance and creates a new one. This forces Leaflet to discard its
tile cache and re-request all visible tiles.

---

## Setup & running

### Prerequisites

- [Podman](https://podman.io/) with [podman-compose](https://github.com/containers/podman-compose)

### 1. Place a GRIB2 file

```bash
mkdir -p data
cp /path/to/your/forecast.grib2 data/sample.grib2
```

The filename must be `sample.grib2` unless you change `GRIB_FILE` in `compose.yml`.
Any GRIB edition 1 or 2 file that cfgrib can open will work. Global and regional files
are both supported.

### 2. Build and start

```bash
podman compose up --build
```

- **App (frontend):** http://localhost:8080
- **API (backend):** http://localhost:8000
- **Interactive API docs:** http://localhost:8000/docs

### 3. Recommended two-terminal workflow

```bash
# Terminal 1 — keep logs streaming
podman compose up --build

# Terminal 2 — restart individual services when you change code
podman compose restart backend   # after Python changes
podman compose restart frontend  # after nginx.conf changes
# frontend/index.html and app.js are live on disk — just hard-refresh the browser
```

For a detached alternative:

```bash
podman compose up --build -d   # start in background
podman compose logs -f         # tail logs
podman compose restart backend # apply Python changes
```

### 4. Hard-refresh the browser

`Cmd+Shift+R` (Mac) or `Ctrl+Shift+R` (Windows/Linux) clears the browser cache.
Changes to `index.html` and `app.js` are always live because they are volume-mounted
into nginx — no container restart needed, only a browser refresh.

---

## Development workflow

### What requires what

| Change | Action needed |
|--------|--------------|
| `frontend/index.html` or `app.js` | Browser hard-refresh only |
| `frontend/nginx.conf` or `nginx-cache.conf` | `podman compose restart frontend` |
| Any `backend/*.py` | `podman compose restart backend` |
| `backend/pyproject.toml` (new dependency) | `podman compose up --build` |
| `backend/Containerfile` | `podman compose up --build` |

### Replacing the GRIB2 file

The `data/` directory is a live volume mount. You can swap files without rebuilding:

```bash
cp /path/to/new.grib2 data/sample.grib2
rm -f data/sample.grib2.*.idx   # delete stale cfgrib index — important!
podman compose restart backend
```

**Always delete the `.idx` file when replacing the GRIB2 file.** cfgrib writes a binary
index (e.g. `sample.grib2.5b7b6.idx`) next to the data file to speed up repeated
opens. If the data file changes but the index does not, cfgrib will read wrong offsets
and return garbage or crash.

### Local Python development (without containers)

```bash
cd backend
pip install uv
uv pip install --system .
GRIB_FILE=../data/sample.grib2 uvicorn main:app --reload --port 8000
```

The frontend can be served by any static file server, or opened directly in the browser
as `file://` (point `const API` in `app.js` to `http://localhost:8000` first).

### Checking the cache

Open browser devtools → Network tab → click any WMS tile request. The response headers
include:

```
X-Cache: MISS   # first request — backend rendered it, nginx stored it
X-Cache: HIT    # subsequent requests — served from disk, no backend involved
```

To clear the nginx cache manually:

```bash
podman compose exec frontend rm -rf /tmp/nginx_tile_cache
```

---

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GRIB_FILE` | `/app/data/sample.grib2` | Absolute path to the GRIB2 file inside the backend container. Change in `compose.yml` if you want a different filename. |

### compose.yml knobs

| Setting | Where | Description |
|---------|-------|-------------|
| `ports: "8000:8000"` | backend | Expose the API directly. Remove if you only want it accessible through nginx. |
| `ports: "8080:80"` | frontend | Change the left side to use a different host port. |
| `volumes: ./data:/app/data` | backend | The data directory mount. Change `./data` to any host path. |
| `restart: unless-stopped` | both | Remove to prevent auto-restart on boot. |

### nginx cache tuning (`frontend/nginx-cache.conf`)

| Parameter | Current value | Notes |
|-----------|--------------|-------|
| `max_size` | 500m | Total disk used by the cache. Increase for large/many datasets. |
| `inactive` | 2h | Tiles not requested within this window are evicted. |
| `proxy_cache_valid 200` | 2h | How long a cached 200 response is considered fresh. |

The cache lives at `/tmp/nginx_tile_cache` inside the frontend container and is cleared
on container restart. Add a named volume in `compose.yml` if you want it to survive
restarts:

```yaml
frontend:
  volumes:
    - nginx_cache:/tmp/nginx_tile_cache  # add this

volumes:
  nginx_cache:
```

### Adding colormaps

Edit `COLORMAPS` at the top of `backend/wms.py`. Keys are matched as substrings of the
variable name (case-insensitive, first match wins):

```python
COLORMAPS: dict[str, str] = {
    "default": "viridis",
    "temperature": "RdYlBu_r",
    "my_new_var": "plasma",   # add your entry here
    ...
}
```

Any matplotlib colormap name is valid. See
https://matplotlib.org/stable/gallery/color/colormap_reference.html

---

## API reference

All endpoints are exposed at `http://localhost:8000` and also via nginx proxy at
`http://localhost:8080`.

### `GET /health`

Liveness probe.

```json
{"status": "ok"}
```

### `GET /info`

File-level metadata for the loaded GRIB2 file.

```json
{
  "available": true,
  "filename": "sample.grib2",
  "path": "/app/data/sample.grib2",
  "size_mb": 142.7,
  "grib_edition": 2,
  "originating_centre": 98,
  "n_datasets": 3,
  "n_variables": 6,
  "variables": ["t2m", "u10", "v10", "msl", "tp", "z"],
  "grid_type": "regular_ll",
  "lat_min": -90.0,
  "lat_max": 90.0,
  "lon_min": 0.0,
  "lon_max": 359.75,
  "lat_resolution_deg": 0.25,
  "lon_resolution_deg": 0.25,
  "n_timesteps": 1,
  "timesteps": ["2024-01-15T00:00:00Z"]
}
```

Returns `{"available": false, "path": "..."}` when no file is found.
`originating_centre` is a numeric WMO centre code (98 = ECMWF, 86 = FMI, etc.).

### `GET /variables`

List of all variables with metadata.

```json
{
  "variables": [
    {
      "name": "t2m",
      "long_name": "2 metre temperature",
      "units": "K",
      "GRIB_name": "2 metre temperature",
      "GRIB_shortName": "2t",
      "n_times": 1,
      "times": ["2024-01-15T00:00:00Z"]
    }
  ]
}
```

Returns `{"variables": [], "message": "..."}` when the file is missing.

### `GET /data`

Point timeseries for a variable at a lat/lon coordinate. Uses nearest-neighbour
selection on the GRIB grid.

| Parameter | Type | Description |
|-----------|------|-------------|
| `var` | string | Variable name from `/variables` |
| `lat` | float | Latitude in decimal degrees (−90 to 90) |
| `lon` | float | Longitude in decimal degrees (−180 to 180) |

```json
{
  "variable": "t2m",
  "units": "K",
  "long_name": "2 metre temperature",
  "lat": 60.173,
  "lon": 24.941,
  "times": ["2024-01-15T00:00:00Z"],
  "values": [271.4]
}
```

Returns HTTP 404 if the variable is not found or the point is outside the data extent.

### `GET /data/bbox`

All grid points within a bounding box as a flat list. Useful for custom rendering or
data export. Large bounding boxes on high-resolution global grids can produce very large
responses.

| Parameter | Type | Description |
|-----------|------|-------------|
| `var` | string | Variable name |
| `minlat` | float | Southern boundary |
| `maxlat` | float | Northern boundary |
| `minlon` | float | Western boundary |
| `maxlon` | float | Eastern boundary |
| `time_index` | int | Time step index (default 0) |

```json
{
  "variable": "t2m",
  "units": "K",
  "long_name": "2 metre temperature",
  "points": [
    {"lat": 60.0, "lon": 25.0, "value": 271.4},
    {"lat": 60.25, "lon": 25.0, "value": 270.9}
  ]
}
```

### `GET /wms`

WMS 1.1.1 endpoint. Supports `GetCapabilities` and `GetMap`. See [WMS details](#wms-details).

### `GET /wms/legend`

Colorbar image for a layer.

| Parameter | Type | Description |
|-----------|------|-------------|
| `layer` | string | Variable name (used to select colormap and value range) |

Returns `image/png` (120 × 400 px, dark background).

---

## WMS details

The WMS endpoint implements a subset of WMS 1.1.1 sufficient for use with Leaflet's
`L.tileLayer.wms`.

### GetCapabilities

```
GET /wms?SERVICE=WMS&REQUEST=GetCapabilities
```

Returns an XML capabilities document listing all variables as queryable layers, each
with their time extent.

### GetMap

```
GET /wms?SERVICE=WMS&REQUEST=GetMap&LAYERS=t2m&BBOX=...&WIDTH=256&HEIGHT=256
```

| Parameter | Notes |
|-----------|-------|
| `LAYERS` | Single variable name. Multiple layers in one request are not supported. |
| `BBOX` | Accepted in EPSG:3857 metres (Leaflet default) or EPSG:4326 degrees. Detection is automatic based on coordinate magnitude. |
| `WIDTH`, `HEIGHT` | Tile size in pixels. Leaflet uses 256×256. |
| `TIME` | ISO-8601 timestamp matching one of the values from `/variables`. If omitted or not matched, time index 0 is used. |
| `SRS` / `CRS` | Accepted but not validated. The backend renders correctly regardless. |
| `STYLES` | Accepted but ignored. Colormap is chosen automatically by variable name. |

Parameter names are accepted in both uppercase (WMS spec) and lowercase (Leaflet sends
lowercase). The `REQUEST` parameter is case-insensitive.

### Projection notes

The Leaflet map uses EPSG:3857 (Web Mercator). Each tile's BBOX is in metres. The
backend converts every output pixel to lat/lon using the inverse Mercator formula before
looking up the GRIB data. This produces correctly projected tiles that align with the
OSM base layer at all latitudes.

Mercator projection means high-latitude features appear larger on screen than they are
in reality — this is a property of the projection, not a rendering bug.

---

## Nginx tile cache

All backend responses (tiles, variable lists, point queries) are cached by nginx.

| Behaviour | Detail |
|-----------|--------|
| Cache key | Full request URI including query string — each unique tile/parameter combination is cached separately |
| TTL | 2 hours for HTTP 200 responses |
| Eviction | LRU-style by `inactive` window + `max_size` limit |
| Persistence | Cache lives at `/tmp/nginx_tile_cache` inside the frontend container — cleared on container restart |
| Stale serving | `proxy_cache_use_stale error timeout` — on backend error, nginx serves a stale cached tile rather than returning an error |
| Verification | `X-Cache: HIT` / `MISS` response header visible in browser devtools |

**Implication for point queries:** `/data?var=t2m&lat=60.0&lon=25.0` is cached. A
second click on the same pixel returns instantly from cache. This is correct for static
GRIB files.

**Cache invalidation:** the cache is not automatically invalidated when the GRIB file
changes. After replacing the data file, restart the backend (`podman compose restart
backend`) and optionally clear the nginx cache:

```bash
podman compose exec frontend rm -rf /tmp/nginx_tile_cache
```

---

## Known limitations & gotchas

### Regular grid assumption in WMS renderer

`_render_data()` builds a `RegularGridInterpolator` by taking `lats_2d[:, 0]` (first
column) as the 1-D latitude axis and `lons_2d[0, :]` (first row) as the 1-D longitude
axis. This works correctly for `regular_ll` (regular lat/lon) grids but **will produce
incorrect results** for:

- Reduced Gaussian grids (`reduced_gg`) — rows have different numbers of points
- Rotated pole grids — lat/lon are curvilinear
- Lambert conformal or other projected grids

The `grid_type` field in `/info` tells you which type your file uses. For non-regular
grids, the WMS overlay will look distorted or blank. Point queries (`/data`) handle
curvilinear grids correctly via a separate nearest-neighbour code path.

### Single vertical level

`get_slice()` and `get_bbox_subset()` always take the first index of any non-lat/lon/time
dimension. For pressure-level data with multiple levels, only the first level is
visualised. There is no UI control to select the level.

### No GribReader thread lock

The `_datasets` cache in `GribReader` is set without a lock. Under the default single
uvicorn worker this is not an issue, but if you add `--workers N` to the uvicorn command,
each worker process gets its own copy of the singleton (no shared state between
processes, so no race, but N copies of the data in memory).

### Stale `.idx` index file

cfgrib writes a binary index file (e.g. `sample.grib2.5b7b6.idx`) next to the GRIB2
file on first open. **Always delete this file when you replace the GRIB2 data**, otherwise
cfgrib reads wrong byte offsets from the old index.

### Time slider fires on every drag pixel

The `input` event on the time slider triggers a full WMS layer rebuild (Leaflet discards
all tiles and re-requests them) for every pixel of slider movement. For files with many
time steps, dragging the slider quickly causes a burst of requests. A debounce of
~300 ms on the slider would improve this.

### nginx cache covers `/health`

The health endpoint is cached like everything else. A cached `/health: ok` response will
be served even if the backend has crashed, as long as a cached response is available.
If you need reliable liveness checks, query the backend directly on port 8000 rather
than through nginx.

### Legend cache-busting

`refreshLegend()` appends `&_=<timestamp>` to the legend URL to bypass the browser
cache. Because nginx also caches the legend, each page refresh generates a unique URL
that misses the nginx cache and hits the backend. For a static dataset this is harmless
but slightly wasteful. Remove the `&_=${Date.now()}` if the nginx cache TTL is
acceptable for legends.

### `console.log` left in production code

`app.js:loadInfo()` logs the full `/info` response to the browser console. Remove the
`console.log("Info response:", d)` line before any production deployment.

### `/data/bbox` response size

For a global 0.25° grid, the full bounding box returns ~1 million points as JSON
(~50 MB uncompressed). There is no pagination or downsampling. Use tight bounding boxes
or increase nginx's `proxy_read_timeout` if you query large regions.

---

## Extension ideas

### Multiple GRIB files

`GribReader` is instantiated with a single path. To support multiple files, the
`get_reader()` factory could accept a path parameter and maintain a dict of readers:

```python
_readers: dict[str, GribReader] = {}
def get_reader(path: str = ...) -> GribReader: ...
```

The frontend would need a file selector, and the API endpoints would need a `file`
parameter.

### Persisted tile cache

Add a named Docker/Podman volume for `/tmp/nginx_tile_cache` in `compose.yml` so tiles
survive container restarts.

### Multiple uvicorn workers

For concurrent users, change the backend CMD:

```dockerfile
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "4"]
```

Each worker loads its own copy of the GRIB data into memory. Monitor RAM usage.

### Wind barbs / vector overlay

`u10` and `v10` are loaded but visualised independently as scalar fields. A proper wind
overlay would use the `/data/bbox` endpoint to fetch a grid of (u, v) pairs and render
barbs or streamlines with a canvas overlay in Leaflet.

### Zarr conversion for faster tile rendering

Converting the GRIB2 file to Zarr before serving eliminates the `RegularGridInterpolator`
rebuild on every tile request:

```bash
python -c "
import cfgrib, xarray as xr
ds = xr.open_dataset('data/sample.grib2', engine='cfgrib')
ds.to_zarr('data/sample.zarr')
"
```

Zarr supports chunked reads aligned to lat/lon tiles, so only the needed chunk is
read from disk per tile request.

### Colour scale controls

Currently, `vmin`/`vmax` are derived from the global min/max of the entire 2-D field.
A user-controlled colour scale (min/max inputs or percentile clipping) would improve
contrast for fields with outliers.

### Time animation

An "animate" button that auto-advances the time slider at a fixed interval (e.g. 500 ms
per step) would make it easy to see how fields evolve over a forecast.
