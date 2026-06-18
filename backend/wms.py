import io
from typing import Annotated

import matplotlib
import matplotlib.pyplot as plt
import numpy as np
from fastapi import APIRouter, Query
from fastapi.responses import Response
from PIL import Image as PILImage
from scipy.interpolate import RegularGridInterpolator

matplotlib.use("Agg")

from grib_reader import get_reader

# ── Constants ────────────────────────────────────────────────────────────────

# Half-circumference of the Earth in EPSG:3857 metres.
# x = lon_deg * _MERCATOR_MAX_EXTENT / 180
# y = inverse-Mercator of lat
_MERCATOR_MAX_EXTENT = 20037508.342789244

# Alpha applied to all non-NaN tile pixels (0–1).
_TILE_OPACITY = 0.85

# Colormap chosen by substring match on the variable name (first match wins).
_COLORMAPS: dict[str, str] = {
    "default":     "viridis",
    "temperature": "RdYlBu_r",
    "t2m":         "RdYlBu_r",
    "u10":         "PuOr",
    "v10":         "PuOr",
    "tp":          "Blues",
    "msl":         "RdYlGn",
    "z":           "terrain",
    "r":           "BrBG",
    "q":           "YlGnBu",
}

router = APIRouter()


# ── Coordinate helpers ────────────────────────────────────────────────────────

def _is_mercator(minx: float, miny: float, maxx: float, maxy: float) -> bool:
    """Return True when the BBOX is in EPSG:3857 metres rather than EPSG:4326 degrees.

    Leaflet sends BBOX in the map's native CRS (EPSG:3857). Geographic coordinates
    never exceed ±180° / ±90°, so any value outside those ranges is unambiguously
    a metre coordinate.
    """
    return abs(minx) > 360 or abs(maxx) > 360 or abs(miny) > 90 or abs(maxy) > 90


def _mercator_to_latlon(x: np.ndarray, y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Convert EPSG:3857 metre arrays to (latitude_deg, longitude_deg)."""
    lon = x * 180.0 / _MERCATOR_MAX_EXTENT
    lat = np.degrees(2 * np.arctan(np.exp(y * np.pi / _MERCATOR_MAX_EXTENT)) - np.pi / 2)
    return lat, lon


# ── Tile rendering ────────────────────────────────────────────────────────────

def _empty_tile(width: int, height: int) -> PILImage.Image:
    return PILImage.new("RGBA", (width, height), (0, 0, 0, 0))


def _render_tile(
    field: dict,
    minx: float, miny: float, maxx: float, maxy: float,
    width: int, height: int,
) -> np.ndarray:
    """Interpolate GRIB field values onto a (height × width) pixel grid.

    Builds a RegularGridInterpolator from the field's lat/lon axes, then
    queries it once for all pixels. Each pixel's Mercator coordinate is
    converted to lat/lon before the lookup so the output aligns correctly
    with the EPSG:3857 OSM base tiles.

    Assumes a regular lat/lon grid — see README for behaviour on other grid types.
    Returns a (height, width) float array; pixels outside the data extent are NaN.
    """
    values = field["values"].astype(float)
    lats_2d = field["lats"]
    lons_2d = field["lons"]

    # Extract 1-D axes from the 2-D coordinate grids
    lats_1d = lats_2d[:, 0]
    lons_1d = lons_2d[0, :]

    # RegularGridInterpolator requires strictly ascending coordinates
    if lats_1d[0] > lats_1d[-1]:
        lats_1d = lats_1d[::-1]
        values = values[::-1, :]

    interpolator = RegularGridInterpolator(
        (lats_1d, lons_1d), values,
        method="linear", bounds_error=False, fill_value=np.nan,
    )

    # Build a query grid in pixel space, row 0 = top of tile = maxy
    col_coords = np.linspace(minx, maxx, width)
    row_coords = np.linspace(maxy, miny, height)
    pixel_x, pixel_y = np.meshgrid(col_coords, row_coords)

    if _is_mercator(minx, miny, maxx, maxy):
        query_lats, query_lons = _mercator_to_latlon(pixel_x, pixel_y)
    else:
        query_lons, query_lats = pixel_x, pixel_y

    pixel_values = interpolator(
        np.stack([query_lats.ravel(), query_lons.ravel()], axis=1)
    ).reshape(height, width)

    return pixel_values


# ── WMS helpers ───────────────────────────────────────────────────────────────

def _pick_colormap(layer_name: str) -> str:
    lower = layer_name.lower()
    for key, cmap in _COLORMAPS.items():
        if key in lower:
            return cmap
    return _COLORMAPS["default"]


def _wms_exception(message: str, code: str = "InvalidRequest") -> Response:
    """Return a WMS 1.1.1 conformant service-exception XML response."""
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<ServiceExceptionReport version="1.1.1">\n'
        f'  <ServiceException code="{code}">{message}</ServiceException>\n'
        '</ServiceExceptionReport>'
    )
    return Response(content=xml, media_type="application/vnd.ogc.se_xml", status_code=400)


def _build_capabilities_xml(variables: list[dict]) -> str:
    layer_xml = ""
    for v in variables:
        name = v["name"]
        title = f"{v.get('long_name', name)} ({v.get('units', '')})"
        times = v.get("times", [])
        time_extent = ""
        if times:
            time_extent = (
                f"<Extent name='time' default='{times[0]}'>"
                + ",".join(times)
                + "</Extent>"
            )
        layer_xml += f"""
        <Layer queryable="1">
          <Name>{name}</Name>
          <Title>{title}</Title>
          <SRS>EPSG:4326</SRS>
          <LatLonBoundingBox minx="-180" miny="-90" maxx="180" maxy="90"/>
          <BoundingBox SRS="EPSG:4326" minx="-180" miny="-90" maxx="180" maxy="90"/>
          {time_extent}
        </Layer>"""

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE WMT_MS_Capabilities SYSTEM "http://schemas.opengis.net/wms/1.1.1/OGC-exception.xsd">
<WMT_MS_Capabilities version="1.1.1">
  <Service>
    <Name>OGC:WMS</Name>
    <Title>Weather Visualization WMS</Title>
    <OnlineResource xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="/wms?"/>
  </Service>
  <Capability>
    <Request>
      <GetCapabilities>
        <Format>application/vnd.ogc.wms_xml</Format>
        <DCPType><HTTP><Get>
          <OnlineResource xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="/wms?"/>
        </Get></HTTP></DCPType>
      </GetCapabilities>
      <GetMap>
        <Format>image/png</Format>
        <DCPType><HTTP><Get>
          <OnlineResource xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="/wms?"/>
        </Get></HTTP></DCPType>
      </GetMap>
    </Request>
    <Exception><Format>application/vnd.ogc.se_xml</Format></Exception>
    <Layer>
      <Title>Weather Data</Title>
      <SRS>EPSG:4326</SRS>
      {layer_xml}
    </Layer>
  </Capability>
</WMT_MS_Capabilities>"""


# ── Route handlers ────────────────────────────────────────────────────────────

@router.get("/wms")
def wms_endpoint(
    # WMS spec uses uppercase; Leaflet sends lowercase — accept both
    SERVICE: Annotated[str, Query()] = "WMS",
    REQUEST: Annotated[str, Query()] = "GetCapabilities",
    LAYERS:  Annotated[str | None, Query()] = None,
    BBOX:    Annotated[str | None, Query()] = None,
    WIDTH:   Annotated[int, Query()] = 256,
    HEIGHT:  Annotated[int, Query()] = 256,
    TIME:    Annotated[str | None, Query()] = None,
    VERSION: Annotated[str, Query()] = "1.1.1",
    FORMAT:  Annotated[str, Query()] = "image/png",
    SRS:     Annotated[str, Query()] = "EPSG:4326",
    STYLES:  Annotated[str, Query()] = "",
    layers:  Annotated[str | None, Query()] = None,
    bbox:    Annotated[str | None, Query()] = None,
    width:   Annotated[int | None, Query()] = None,
    height:  Annotated[int | None, Query()] = None,
    request: Annotated[str | None, Query()] = None,
    time:    Annotated[str | None, Query()] = None,
):
    # Merge uppercase (WMS spec) and lowercase (Leaflet) parameter variants
    operation   = (request or REQUEST).upper()
    layer_name  = LAYERS or layers
    bbox_str    = BBOX or bbox
    tile_width  = width or WIDTH
    tile_height = height or HEIGHT
    time_str    = time or TIME

    if operation == "GETCAPABILITIES":
        variables = get_reader().list_variables()
        return Response(
            content=_build_capabilities_xml(variables),
            media_type="application/vnd.ogc.wms_xml",
        )

    if operation == "GETMAP":
        if not layer_name:
            return _wms_exception("LAYERS parameter is required")
        if not bbox_str:
            return _wms_exception("BBOX parameter is required")

        try:
            minx, miny, maxx, maxy = map(float, bbox_str.split(","))
        except ValueError:
            return _wms_exception(f"Invalid BBOX: {bbox_str!r}")

        # Map the requested TIME string to a 0-based index
        time_index = 0
        if time_str:
            for var_meta in get_reader().list_variables():
                if var_meta["name"] == layer_name and var_meta["times"]:
                    try:
                        time_index = var_meta["times"].index(time_str)
                    except ValueError:
                        time_index = 0
                    break

        field = get_reader().get_slice(layer_name, time_index)

        if field is None:
            img = _empty_tile(tile_width, tile_height)
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            buf.seek(0)
            return Response(content=buf.read(), media_type="image/png")

        pixel_values = _render_tile(field, minx, miny, maxx, maxy, tile_width, tile_height)

        colormap = plt.get_cmap(_pick_colormap(layer_name))
        norm = matplotlib.colors.Normalize(vmin=field["vmin"], vmax=field["vmax"])
        rgba = colormap(norm(pixel_values), bytes=True)   # (H, W, 4) uint8

        valid_mask = np.isfinite(pixel_values)
        rgba[~valid_mask, 3] = 0
        rgba[valid_mask, 3] = np.clip(
            (rgba[valid_mask, 3].astype(float) * _TILE_OPACITY), 0, 255
        ).astype(np.uint8)

        img = PILImage.fromarray(rgba, mode="RGBA")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        return Response(content=buf.read(), media_type="image/png")

    return _wms_exception(f"Unsupported REQUEST: {operation!r}", code="OperationNotSupported")


@router.get("/wms/legend")
def wms_legend(layer: str = "default"):
    """Return a colorbar PNG for the given layer (dark background, 120×400 px)."""
    cmap_name = _pick_colormap(layer)
    vmin, vmax, units = 0.0, 1.0, ""

    for var_meta in get_reader().list_variables():
        if var_meta["name"] == layer:
            field = get_reader().get_slice(layer, 0)
            if field:
                vmin  = field["vmin"]
                vmax  = field["vmax"]
                units = field["units"]
            break

    fig, ax = plt.subplots(figsize=(0.8, 3.0), dpi=100)
    fig.patch.set_facecolor("#1a1a2e")
    norm = matplotlib.colors.Normalize(vmin=vmin, vmax=vmax)
    colorbar = matplotlib.colorbar.ColorbarBase(
        ax, cmap=cmap_name, norm=norm, orientation="vertical"
    )
    colorbar.set_label(units, color="white", fontsize=10)
    colorbar.ax.yaxis.set_tick_params(color="white")
    plt.setp(colorbar.ax.yaxis.get_ticklabels(), color="white", fontsize=9)
    ax.set_title(layer, color="white", fontsize=10, pad=5)

    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", facecolor=fig.get_facecolor())
    plt.close(fig)
    buf.seek(0)
    return Response(content=buf.read(), media_type="image/png")
