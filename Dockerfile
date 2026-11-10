# Runtime image. OCR and PDF tools are required for law upload (Arabic PDFs are read by OCR).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      poppler-utils tesseract-ocr tesseract-ocr-ara tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
USER node
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "start"]
