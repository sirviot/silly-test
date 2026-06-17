import os
from pathlib import Path
from typing import Any

import cfgrib
import numpy as np
import pandas as pd
import xarray as xr

GRIB_PATH = Path(os.environ.get("GRIB_FILE", "./data/sample.grib2"))

# Coordinate name candidates in priority order
_LAT_NAMES = ("latitude", "lat", "y")
_LON_NAMES = ("longitude", "lon", "x")


def _first_coord(coords, candidates: tuple) -> str | None:
    return next((c for c in candidates if c in coords), None)


class GribReader:
    """Wraps a single GRIB2 file with lazy loading and dataset caching.

    cfgrib.open_datasets() commonly splits one GRIB2 file into multiple
    xarray Datasets — one per (typeOfLevel, shortName) combination. All
    public methods search across that list transparently so callers do not
    need to know how many datasets the file produced.

    The file is opened once on the first method call and kept in memory.
    Use get_reader() to obtain the process-level singleton rather than
    instantiating this class directly.
    """

    def __init__(self, path: Path = GRIB_PATH) -> None:
        self.path = path
        self._datasets: list[xr.Dataset] | None = None

    @staticmethod
    def _to_iso(value) -> str:
        """Convert any numpy / pandas datetime value to an ISO-8601 string.

        numpy datetime64 scalars returned by .item() are nanoseconds as a
        plain Python int. pd.Timestamp handles all unit variants correctly.
        """
        try:
            return pd.Timestamp(value).strftime("%Y-%m-%dT%H:%M:%SZ")
        except Exception:
            return str(value)

    def _open_datasets(self) -> list[xr.Dataset]:
        """Open the GRIB2 file and cache the resulting dataset list.

        Returns an empty list (without caching) when the file does not yet
        exist, so the next call will retry — useful when the data directory
        is populated after startup.
        """
        if self._datasets is None:
            if not self.path.exists():
                return []
            self._datasets = cfgrib.open_datasets(str(self.path))
        return self._datasets

    def get_file_info(self) -> dict[str, Any]:
        """Return file-level metadata: extent, resolution, variables, timesteps."""
        datasets = self._open_datasets()
        if not datasets:
            return {"available": False, "path": str(self.path)}

        size_mb = round(self.path.stat().st_size / 1_048_576, 2)
        all_vars = self.list_variables()

        lat_min = lat_max = lon_min = lon_max = None
        lat_resolution = lon_resolution = None
        grid_type = None

        for ds in datasets:
            lat_name = _first_coord(ds.coords, _LAT_NAMES)
            lon_name = _first_coord(ds.coords, _LON_NAMES)
            if not (lat_name and lon_name):
                continue

            lats = ds.coords[lat_name].values.ravel()
            lons = ds.coords[lon_name].values.ravel()
            lat_min, lat_max = float(np.nanmin(lats)), float(np.nanmax(lats))
            lon_min, lon_max = float(np.nanmin(lons)), float(np.nanmax(lons))

            unique_lats = np.unique(lats)
            unique_lons = np.unique(lons)
            if len(unique_lats) > 1:
                lat_resolution = round(float(np.abs(np.diff(unique_lats)).mean()), 4)
            if len(unique_lons) > 1:
                lon_resolution = round(float(np.abs(np.diff(unique_lons)).mean()), 4)

            for var in ds.data_vars.values():
                grid_type = var.attrs.get("GRIB_gridType")
                if grid_type:
                    break
            break

        # Collect unique timesteps across all variables, sorted
        seen: set[str] = set()
        all_times: list[str] = []
        for var_meta in all_vars:
            for t in var_meta.get("times", []):
                if t not in seen:
                    seen.add(t)
                    all_times.append(t)
        all_times.sort()

        edition = centre = None
        for ds in datasets:
            for var in ds.data_vars.values():
                edition = var.attrs.get("GRIB_edition")
                centre = var.attrs.get("GRIB_centre")
                break
            if edition is not None:
                break

        return {
            "available": True,
            "filename": self.path.name,
            "path": str(self.path),
            "size_mb": size_mb,
            "grib_edition": edition,
            "originating_centre": centre,
            "n_datasets": len(datasets),
            "n_variables": len(all_vars),
            "variables": [v["name"] for v in all_vars],
            "grid_type": grid_type,
            "lat_min": lat_min,
            "lat_max": lat_max,
            "lon_min": lon_min,
            "lon_max": lon_max,
            "lat_resolution_deg": lat_resolution,
            "lon_resolution_deg": lon_resolution,
            "n_timesteps": len(all_times),
            "timesteps": all_times,
        }

    def list_variables(self) -> list[dict[str, Any]]:
        """Return per-variable metadata for every data variable in the file."""
        variables: dict[str, dict[str, Any]] = {}

        for ds in self._open_datasets():
            for name, var in ds.data_vars.items():
                if name in variables:
                    continue

                if "time" in ds.coords:
                    raw_times = ds.coords["time"].values
                    # A 0-d array means a single timestep; wrap it so we can iterate
                    time_values = [raw_times] if raw_times.ndim == 0 else raw_times
                    time_strings = [self._to_iso(t) for t in time_values]
                else:
                    time_strings = []

                variables[name] = {
                    "name": name,
                    "long_name": var.attrs.get("long_name", name),
                    "units": var.attrs.get("units", "unknown"),
                    "GRIB_name": var.attrs.get("GRIB_name", name),
                    "GRIB_shortName": var.attrs.get("GRIB_shortName", name),
                    "n_times": len(time_strings) or 1,
                    "times": time_strings,
                }

        return list(variables.values())

    def _dataset_for_variable(self, var_name: str) -> xr.Dataset | None:
        """Find the dataset that contains the named variable."""
        for ds in self._open_datasets():
            if var_name in ds.data_vars:
                return ds
        return None

    def get_slice(self, var_name: str, time_index: int = 0) -> dict[str, Any] | None:
        """Return a 2-D lat/lon/values snapshot for one variable at one time step.

        Vertical level dimensions (pressure levels, model levels, etc.) are
        collapsed by selecting the first index — there is no UI to choose the level.
        Returns None if the variable is not found or has no spatial coordinates.
        """
        ds = self._dataset_for_variable(var_name)
        if ds is None:
            return None

        data_array = ds[var_name]

        if "time" in data_array.dims:
            clamped_index = max(0, min(time_index, data_array.sizes["time"] - 1))
            data_array = data_array.isel(time=clamped_index)

        # Drop any remaining non-spatial dimensions by taking the first index
        spatial_dims = {"latitude", "longitude", "lat", "lon", "x", "y"}
        for dim in list(data_array.dims):
            if dim not in spatial_dims:
                data_array = data_array.isel({dim: 0})

        lat_name = _first_coord(data_array.coords, _LAT_NAMES)
        lon_name = _first_coord(data_array.coords, _LON_NAMES)
        if lat_name is None or lon_name is None:
            return None

        lats = data_array.coords[lat_name].values
        lons = data_array.coords[lon_name].values
        values = data_array.values

        # Promote 1-D coordinate vectors to 2-D grids so callers always get arrays
        if lats.ndim == 1 and lons.ndim == 1:
            lons_2d, lats_2d = np.meshgrid(lons, lats)
        else:
            lats_2d, lons_2d = lats, lons

        return {
            "variable": var_name,
            "units": data_array.attrs.get("units", "unknown"),
            "long_name": data_array.attrs.get("long_name", var_name),
            "lats": lats_2d,
            "lons": lons_2d,
            "values": values,
            "lat_min": float(np.nanmin(lats_2d)),
            "lat_max": float(np.nanmax(lats_2d)),
            "lon_min": float(np.nanmin(lons_2d)),
            "lon_max": float(np.nanmax(lons_2d)),
            "vmin": float(np.nanmin(values)),
            "vmax": float(np.nanmax(values)),
        }

    def get_point_timeseries(
        self, var_name: str, lat: float, lon: float
    ) -> dict[str, Any] | None:
        """Return the full timeseries at the nearest grid point to (lat, lon)."""
        ds = self._dataset_for_variable(var_name)
        if ds is None:
            return None

        data_array = ds[var_name]
        lat_name = _first_coord(data_array.coords, _LAT_NAMES)
        lon_name = _first_coord(data_array.coords, _LON_NAMES)
        if lat_name is None or lon_name is None:
            return None

        # Drop non-spatial, non-time dimensions
        keep = {"time", "latitude", "longitude", "lat", "lon", "x", "y"}
        for dim in list(data_array.dims):
            if dim not in keep:
                data_array = data_array.isel({dim: 0})

        try:
            if lat_name in data_array.dims and lon_name in data_array.dims:
                # Regular grid: xarray nearest-neighbour selection
                point = data_array.sel(
                    {lat_name: lat, lon_name: lon}, method="nearest"
                )
            else:
                # Curvilinear grid: manual minimum-distance search
                lats = data_array.coords[lat_name].values
                lons = data_array.coords[lon_name].values
                distances = (lats - lat) ** 2 + (lons - lon) ** 2
                nearest_idx = np.unravel_index(np.argmin(distances), distances.shape)
                point = data_array.isel(
                    {d: int(i) for d, i in zip(data_array.dims, nearest_idx)
                     if d in data_array.dims}
                )
        except Exception:
            return None

        time_strings: list[str] = []
        values: list[float] = []

        if "time" in point.dims or "time" in point.coords:
            n_steps = point.sizes.get("time", 1)
            for i in range(n_steps):
                step = point.isel(time=i) if "time" in point.dims else point
                time_coord = step.coords.get("time")
                time_strings.append(
                    self._to_iso(time_coord.values) if time_coord is not None else str(i)
                )
                values.append(float(step.values))
        else:
            values = [float(point.values)]
            time_strings = ["0"]

        return {
            "variable": var_name,
            "units": data_array.attrs.get("units", "unknown"),
            "long_name": data_array.attrs.get("long_name", var_name),
            "lat": lat,
            "lon": lon,
            "times": time_strings,
            "values": values,
        }

    def get_bbox_subset(
        self,
        var_name: str,
        minlat: float,
        maxlat: float,
        minlon: float,
        maxlon: float,
        time_index: int = 0,
    ) -> dict[str, Any] | None:
        """Return all finite grid points inside a lat/lon bounding box."""
        field = self.get_slice(var_name, time_index)
        if field is None:
            return None

        lats = field["lats"]
        lons = field["lons"]
        values = field["values"]

        inside_bbox = (
            (lats >= minlat) & (lats <= maxlat) &
            (lons >= minlon) & (lons <= maxlon)
        )
        valid = inside_bbox & np.isfinite(values)

        row_indices, col_indices = np.where(valid)
        points = [
            {
                "lat": float(lats[r, c]),
                "lon": float(lons[r, c]),
                "value": float(values[r, c]),
            }
            for r, c in zip(row_indices, col_indices)
        ]

        return {
            "variable": var_name,
            "units": field["units"],
            "long_name": field["long_name"],
            "points": points,
        }


# Process-level singleton — created on first request, reused for all subsequent ones
_reader: GribReader | None = None


def get_reader() -> GribReader:
    global _reader
    if _reader is None:
        _reader = GribReader()
    return _reader
