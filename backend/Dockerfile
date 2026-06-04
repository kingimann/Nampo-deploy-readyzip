FROM python:3.11-slim

# Don't write .pyc, unbuffered stdout for clean logs
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install deps first for better layer caching
COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

# Copy application code
COPY . .

# App Runner / load balancers hit /health on this port
EXPOSE 8080

# uvicorn binds to the port App Runner provides (default 8080).
# server:app  ->  module `server`, FastAPI instance `app`
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT:-8080}"]
