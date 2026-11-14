# LokaChat API - deploy straight to Koyeb (Dockerfile build, work directory: backend/)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY . .

# Run as a non-root user
RUN useradd --create-home appuser && chown -R appuser /app
USER appuser

EXPOSE 8000
# Koyeb injects PORT; default 8000. Trust the proxy headers so rate limits see real client IPs.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
