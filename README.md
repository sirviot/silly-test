# Weather Visualizer

A browser-based GRIB2 weather data explorer. Drop a GRIB2 file into `data/`, start the
containers, and get an interactive map with WMS overlay, time slider, point timeseries
chart, and a data-info panel.

---

## Architecture

```
Browser
  │
  ▼
nginx :8080  (frontend container)
  ├── /                → serves static frontend files
  └── /wms, /data, … → proxy → FastAPI :8000  (tile-cached)
        │
        ▼
  FastAPI / uvicorn :8000  (backend container)
        │
        ├── GribReader singleton — opened once on first request, held in memory
        └── ./data/sample.grib2  (volume mount)
```

**File layout:**

```
weather-viz/
├── backend/
│   ├── Containerfile       # Python 3.11-slim + eccodes/geos system libs
│   ├── pyproject.toml      # uv-compatible dependency manifest
│   ├── main.py             # FastAPI app entry point
│   ├── grib_reader.py      # All GRIB I/O — GribReader class + singleton
│   ├── wms.py              # WMS 1.1.1 endpoints + Mercator tile renderer
│   └── data_api.py         # REST endpoints: /info /variables /data /data/bbox
├── frontend/
│   ├── index.html          # Single-page app shell (dark-theme CSS)
│   ├── app.js              # Leaflet map, Chart.js timeseries, sidebar
│   ├── nginx.conf          # Reverse proxy rules + cache directives
│   └── nginx-cache.conf    # proxy_cache_path (http-context level)
├── data/                   # Place .grib2 files here
├── compose.yml
└── README.md
```

**Key design choices:**

| Choice | Reason |
|--------|--------|
| cfgrib + xarray | Standard Python GRIB2 stack; transparently handles files split into multiple datasets |
| WMS 1.1.1 | Version Leaflet's `L.tileLayer.wms` speaks natively |
| EPSG:3857 tiles + server-side Mercator reprojection | OSM base tiles stay standard; backend reprojects per pixel via inverse Mercator |
| Pillow for tile encoding | Faster and simpler than routing through matplotlib's figure/axes system |
| nginx proxy cache | Caches rendered tiles to disk with zero backend code changes |
| Single uvicorn worker | Sufficient for one user; scale with `--workers N` if needed |

---

## Quick start

**Prerequisites:** [Podman](https://podman.io/) + [podman-compose](https://github.com/containers/podman-compose)

```bash
# 1. Place a GRIB2 file
cp /path/to/forecast.grib2 data/sample.grib2

# 2. Build and start
podman compose up --build
```

- **App:** http://localhost:8080
- **API:** http://localhost:8000
- **API docs:** http://localhost:8000/docs

**Recommended workflow — two terminals:**

```bash
# Terminal 1: keep logs live
podman compose up --build

# Terminal 2: apply changes
podman compose restart backend    # after any Python change
podman compose restart frontend   # after nginx.conf changes
# index.html / app.js: hard-refresh the browser only (Cmd/Ctrl+Shift+R)
```

| Change | Action |
|--------|--------|
| `frontend/index.html` or `app.js` | Hard-refresh browser |
| `frontend/nginx.conf` or `nginx-cache.conf` | `podman compose restart frontend` |
| Any `backend/*.py` | `podman compose restart backend` |
| `backend/pyproject.toml` or `Containerfile` | `podman compose up --build` |

---

## Configuration

### Changing the GRIB2 file

```bash
cp /path/to/new.grib2 data/sample.grib2
rm -f data/sample.grib2.*.idx    # always delete the stale cfgrib index
podman compose restart backend
```

The `.idx` file is a binary index cfgrib writes on first open. If the data file changes
but the index does not, cfgrib reads wrong byte offsets and returns garbage or crashes.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GRIB_FILE` | `/app/data/sample.grib2` | Path to the GRIB2 file inside the container. Set in `compose.yml` to use a different filename. |

### compose.yml knobs

| Setting | Description |
|---------|-------------|
| `ports: "8000:8000"` (backend) | Exposes the API directly. Remove if you only want access through nginx. |
| `ports: "8080:80"` (frontend) | Change the left number to use a different host port. |
| `volumes: ./data:/app/data` | Change `./data` to any path on your machine. |

### Tile cache (`frontend/nginx-cache.conf`)

nginx caches all backend responses to disk. The cache key is the full request URL, so
each unique tile/variable/time combination is stored separately.

| Parameter | Value | Notes |
|-----------|-------|-------|
| `max_size` | 500m | Increase for large datasets or many variables. |
| `inactive` | 2h | Tiles not requested within this window are evicted. |
| `proxy_cache_valid 200` | 2h | How long a 200 response is considered fresh. |

Verify cache behaviour in browser devtools — the `X-Cache: HIT/MISS` response header is
set on every proxied request.

The cache lives at `/tmp/nginx_tile_cache` inside the frontend container and is cleared
on restart. To persist it across restarts, add a named volume in `compose.yml`:

```yaml
frontend:
  volumes:
    - nginx_cache:/tmp/nginx_tile_cache

volumes:
  nginx_cache:
```

**After replacing the GRIB2 file**, clear the cache so stale tiles are not served:

```bash
podman compose exec frontend rm -rf /tmp/nginx_tile_cache
```

### Colormaps

Edit `_COLORMAPS` at the top of `backend/wms.py`. Keys are substrings of the variable
name (case-insensitive, first match wins). Any
[matplotlib colormap name](https://matplotlib.org/stable/gallery/color/colormap_reference.html)
is valid.

| Key | Colormap |
|-----|----------|
| `temperature`, `t2m` | `RdYlBu_r` |
| `u10`, `v10` | `PuOr` |
| `tp` | `Blues` |
| `msl` | `RdYlGn` |
| `z` | `terrain` |
| `r` | `BrBG` |
| `q` | `YlGnBu` |
| _(default)_ | `viridis` |

---

## API reference

All endpoints available at http://localhost:8000 (direct) and http://localhost:8080 (via nginx proxy).

### `GET /health`
```json
{"status": "ok"}
```

### `GET /info`

File-level metadata. Use `grid_type` to check whether the WMS overlay will work correctly
for your file (see [Known limitations](#known-limitations)).

```json
{
  "available": true,
  "filename": "sample.grib2",
  "size_mb": 142.7,
  "grib_edition": 2,
  "originating_centre": 98,
  "n_datasets": 3,
  "grid_type": "regular_ll",
  "lat_min": -90.0, "lat_max": 90.0,
  "lon_min": 0.0,   "lon_max": 359.75,
  "lat_resolution_deg": 0.25,
  "lon_resolution_deg": 0.25,
  "n_variables": 6,
  "variables": ["t2m", "u10", "v10", "msl", "tp", "z"],
  "n_timesteps": 1,
  "timesteps": ["2024-01-15T00:00:00Z"]
}
```

`originating_centre` is a numeric WMO centre code (98 = ECMWF, 86 = FMI).
Returns `{"available": false}` when no file is found.

### `GET /variables`

```json
{
  "variables": [
    {
      "name": "t2m",
      "long_name": "2 metre temperature",
      "units": "K",
      "GRIB_shortName": "2t",
      "n_times": 1,
      "times": ["2024-01-15T00:00:00Z"]
    }
  ]
}
```

### `GET /data?var=&lat=&lon=`

Nearest-neighbour point timeseries. Works on all grid types.

```json
{
  "variable": "t2m", "units": "K",
  "lat": 60.173, "lon": 24.941,
  "times": ["2024-01-15T00:00:00Z"],
  "values": [271.4]
}
```

Returns HTTP 404 if the variable is not found or the point is outside the data extent.

### `GET /data/bbox?var=&minlat=&maxlat=&minlon=&maxlon=&time_index=`

All finite grid points inside a bounding box as a flat list. For a global 0.25° grid the
full bbox returns ~1 million points (~50 MB JSON) — use tight bounding boxes.

```json
{
  "variable": "t2m", "units": "K",
  "points": [
    {"lat": 60.0, "lon": 25.0, "value": 271.4}
  ]
}
```

### `GET /wms`

WMS 1.1.1 endpoint. Supports `GetCapabilities` and `GetMap`. Parameter names accepted in
both uppercase (WMS spec) and lowercase (Leaflet default). The `BBOX` is accepted in
either EPSG:3857 metres or EPSG:4326 degrees — detected automatically by magnitude.
`STYLES` is accepted but ignored; colormap is chosen by variable name. Errors return
WMS-conformant `ServiceExceptionReport` XML.

### `GET /wms/legend?layer=`

Returns a colorbar PNG (120 × 400 px, dark background) for the given variable.

---

## Known limitations

### Grid type support

The WMS tile renderer works correctly only for **`regular_ll`** grids. Check `grid_type`
from `/info` before trusting the overlay. Point queries (`/data`) work on all grid types.

| Grid type | Example sources | WMS overlay |
|-----------|----------------|-------------|
| `regular_ll` | ERA5, GFS, ICON, most reanalysis | ✓ Correct |
| `reduced_gg` | ECMWF operational (native) | ✗ Rows have varying point counts — extracted axes are wrong |
| `rotated_ll` | Some regional NWP models | ✗ Rotated coordinates — values placed at wrong locations |
| `lambert` | HIRLAM, HARMONIE, AROME | ✗ Projection metres fed as degrees — nonsense result |
| `polar_stereographic` | Arctic/Antarctic, radar composites | ✗ Same issue as Lambert |

**Fix for `reduced_gg`:** replace `RegularGridInterpolator` with `scipy.interpolate.griddata`,
which handles irregular point clouds without assuming a regular axis structure.

**Fix for projected grids:** add `pyproj` to `pyproject.toml` and use
`pyproj.Transformer` to convert the grid's native coordinates to WGS84 lat/lon before
interpolating. The exact CRS comes from the GRIB projection parameter attributes.

### Single vertical level

For pressure-level or model-level data, `get_slice()` always takes the first level index.
There is no UI control to select the level.

### nginx caches `/health`

The health endpoint is cached like all other responses. A stale `{"status":"ok"}` will be
served even if the backend has crashed. For reliable liveness checks, query the backend
directly on port 8000.

### `/data/bbox` response size

No pagination or downsampling. For a global 0.25° grid the full bounding box returns
~50 MB of JSON. Use tight bounding boxes or increase `proxy_read_timeout` in `nginx.conf`.

---

## Extension ideas

- **Non-regular grid support** — branch in `_render_tile()` on `grid_type`: use
  `griddata` for `reduced_gg`, and `pyproj` + `griddata` for projected grids.

- **Multiple GRIB files** — make `get_reader()` accept a path and maintain a dict of
  readers; add a file selector to the frontend.

- **Wind vector overlay** — fetch a (u, v) grid via `/data/bbox` and render barbs or
  streamlines on a Leaflet canvas overlay.

- **Colour scale controls** — expose `vmin`/`vmax` as user inputs or use percentile
  clipping instead of global field min/max.

- **Time animation** — an "animate" button that auto-advances the time slider at a fixed
  interval to show how a field evolves over a forecast.

- **Zarr conversion** — convert the GRIB2 to Zarr for chunked, tile-aligned reads that
  eliminate the full-array load on every WMS request.

- **Multiple uvicorn workers** — add `--workers 4` to the CMD in `Containerfile` for
  parallel tile rendering under concurrent users (each worker holds its own copy of the
  data in memory).
