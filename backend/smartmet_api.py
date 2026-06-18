import logging
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/smartmet", tags=["smartmet"])

_SMARTMET   = "http://smartmet.fmi.fi"
_WHO        = "teemutesti"
_DATA_DIR   = Path("/app/data")
_GRIB_FILE  = _DATA_DIR / "sample.grib2"
_TIMEOUT    = httpx.Timeout(300.0)   # large downloads can take several minutes


@router.get("/producers")
async def list_producers():
    """Proxy SmartMet gridproducers list."""
    url = f"{_SMARTMET}/info?what=gridproducers&format=json&who={_WHO}"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            r = await client.get(url)
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError as exc:
            raise HTTPException(502, detail=f"SmartMet unreachable: {exc}")


@router.get("/generations")
async def list_generations(producer: str = Query(...)):
    """Proxy SmartMet gridgenerations for one producer.

    Each row contains GeometryId, Timesteps, AnalysisTime, and a comma-separated
    FmiParameters string — everything the download form needs in one request.
    """
    url = f"{_SMARTMET}/info?what=gridgenerations&producer={producer}&format=json&who={_WHO}"
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        try:
            r = await client.get(url)
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError as exc:
            raise HTTPException(502, detail=f"SmartMet unreachable: {exc}")


class DownloadRequest(BaseModel):
    producer:  str
    param:     str   # FmiParameterName
    timesteps: int = 24
    geometry:  str = ""  # geometry ID — appended as PARAM:PRODUCER:GEOMETRY when provided


@router.post("/download")
async def download_grib(req: DownloadRequest):
    """Download a GRIB2 file from SmartMet and save it to the data directory.

    Returns ``{"saved": true}`` on success or ``{"saved": false, "url": "..."}``
    when the data directory is not writable (let the browser download directly).
    """
    param_str = f"{req.param}:{req.producer}"
    if req.geometry:
        param_str += f":{req.geometry}"

    download_url = (
        f"{_SMARTMET}/download"
        f"?format=grib2"
        f"&timesteps={req.timesteps}"
        f"&param={param_str}"
        f"&who={_WHO}"
    )

    try:
        tmp = _GRIB_FILE.with_suffix(".tmp")
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            async with client.stream("GET", download_url) as r:
                r.raise_for_status()
                with open(tmp, "wb") as f:
                    async for chunk in r.aiter_bytes(65_536):
                        f.write(chunk)

        # Remove stale cfgrib index files before swapping in the new file
        for idx in _DATA_DIR.glob("*.idx"):
            idx.unlink(missing_ok=True)
        tmp.replace(_GRIB_FILE)

        # Reset the GribReader singleton so the next request loads the new file
        import grib_reader as _gr
        _gr._reader = None

        logger.info("Downloaded %s:%s (%d steps) → %s", req.producer, req.param, req.timesteps, _GRIB_FILE)
        return {"saved": True, "file": _GRIB_FILE.name, "url": download_url}

    except PermissionError:
        logger.warning("Cannot write to %s — returning direct download URL", _DATA_DIR)
        return {"saved": False, "url": download_url}

    except httpx.HTTPStatusError as exc:
        return {
            "saved": False,
            "url": download_url,
            "error": f"SmartMet returned HTTP {exc.response.status_code}",
        }

    except httpx.HTTPError as exc:
        return {
            "saved": False,
            "url": download_url,
            "error": f"SmartMet unreachable: {exc}",
        }
