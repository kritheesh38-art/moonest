# One image: the FastAPI backend serving the API and the built app.
FROM node:20-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build:server

FROM python:3.13-slim
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .
COPY --from=web /web/dist-server /app/web
ENV FRONTEND_DIST=/app/web UPLOAD_DIR=/data/uploads
VOLUME /data/uploads
EXPOSE 8000
# Hosts like Render and Railway set PORT; default 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips '*'"]
