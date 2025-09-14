# Multi-stage build for Explore (Flask) + static /v2

ARG PYTHON_VERSION=3.11-slim

FROM python:${PYTHON_VERSION} AS builder
WORKDIR /app

# System deps for runtime/ffmpeg (alignment endpoint)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy only requirements first for caching
COPY explore/requirements.txt explore/requirements.txt
RUN python -m venv /opt/venv \
    && . /opt/venv/bin/activate \
    && pip install --upgrade pip \
    && pip install -r explore/requirements.txt \
    && pip install gunicorn

# Final runtime image
FROM python:${PYTHON_VERSION}
ENV VIRTUAL_ENV=/opt/venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
WORKDIR /app

# System deps (ffmpeg for alignment clip extraction)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Copy venv from builder
COPY --from=builder /opt/venv /opt/venv

# Copy source code
COPY . /app

# Default data directory (mount a volume at /data for real datasets)
ENV DATA_DIR=/data
RUN mkdir -p /data

# Expose Flask port
EXPOSE 5000

# Serve via gunicorn using the WSGI app; static /v2 served by frontend blueprint
CMD ["gunicorn", "-b", "0.0.0.0:5000", "explore.wsgi:app", "--workers", "2", "--timeout", "120", "--access-logfile", "-", "--error-logfile", "-"]

