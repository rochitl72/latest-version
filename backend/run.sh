#!/bin/bash
# Run AnnoForge backend in development mode.
set -e
cd "$(dirname "$0")"
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
