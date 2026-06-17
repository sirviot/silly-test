import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from data_api import router as data_router
from wms import router as wms_router

logger = logging.getLogger(__name__)

app = FastAPI(title="Weather Visualization API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(wms_router)
app.include_router(data_router)


@app.get("/health")
def health():
    return {"status": "ok"}


frontend_path = Path(__file__).parent.parent / "frontend"
if frontend_path.exists():
    app.mount("/", StaticFiles(directory=str(frontend_path), html=True), name="frontend")
else:
    logger.warning("Frontend directory not found at %s — static file serving disabled", frontend_path)
