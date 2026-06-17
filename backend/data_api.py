from typing import Annotated

from fastapi import APIRouter, HTTPException, Query

from grib_reader import get_reader

router = APIRouter()


@router.get("/info")
def get_info():
    try:
        return get_reader().get_file_info()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/variables")
def list_variables():
    variables = get_reader().list_variables()
    if not variables:
        return {
            "variables": [],
            "message": "No GRIB2 file found — place a file at the path set by GRIB_FILE.",
        }
    return {"variables": variables}


@router.get("/data")
def get_point_data(
    var: Annotated[str, Query(description="Variable name from /variables")],
    lat: Annotated[float, Query(description="Latitude in decimal degrees")],
    lon: Annotated[float, Query(description="Longitude in decimal degrees")],
):
    result = get_reader().get_point_timeseries(var, lat, lon)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Variable '{var}' not found or ({lat}, {lon}) is outside the data extent.",
        )
    return result


@router.get("/data/bbox")
def get_bbox_data(
    var:        Annotated[str,   Query(description="Variable name from /variables")],
    minlat:     Annotated[float, Query(description="Southern boundary (degrees)")],
    maxlat:     Annotated[float, Query(description="Northern boundary (degrees)")],
    minlon:     Annotated[float, Query(description="Western boundary (degrees)")],
    maxlon:     Annotated[float, Query(description="Eastern boundary (degrees)")],
    time_index: Annotated[int,   Query(description="Time step index (0-based)")] = 0,
):
    if minlat >= maxlat or minlon >= maxlon:
        raise HTTPException(status_code=400, detail="Invalid bounding box: min must be less than max.")
    result = get_reader().get_bbox_subset(var, minlat, maxlat, minlon, maxlon, time_index)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Variable '{var}' not found.")
    return result
