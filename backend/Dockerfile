# ─────────────────────────────────────────────────────────────────────
# Backend image — FastAPI (RBG Annotation Studio API)
#
# Runs the Python API only. The React frontend is built and served
# separately by the `frontend` (nginx) container, which proxies /api and
# /ws to this service. See the repo-root docker-compose.yml.
# ─────────────────────────────────────────────────────────────────────
FROM python:3.11-slim

# Fail fast, no .pyc files, no pip cache — keeps the image small and logs clean.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# System libraries needed by opencv-python-headless / Pillow at import time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 \
 && rm -rf /var/lib/apt/lists/*

# Install Python deps first so this layer is cached unless requirements change.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code.
COPY . .

# Uploaded images and exports live on mounted volumes (see compose), not in the
# image. Point the app's storage at those paths.
ENV STORAGE_DIR=/data/storage \
    EXPORT_DIR=/data/exports
RUN mkdir -p /data/storage /data/exports

EXPOSE 8000

# Health probe used by docker-compose to gate the frontend on a ready API.
# /health is unauthenticated and does no database work, so it answers "is this
# process up" without side effects.
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s --retries=5 \
    CMD python -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status == 200 else sys.exit(1)"

# entrypoint.sh waits for the database, runs `alembic upgrade head`, then starts
# uvicorn — so the migration chain is applied and verified on every deploy.
RUN chmod +x entrypoint.sh
CMD ["./entrypoint.sh"]
