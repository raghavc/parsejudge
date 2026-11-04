# DOCX/PPTX -> PDF with LibreOffice, for self-hosted parsejudge. Same HTTP contract as the hosted converter:
# POST /convert with the document as the body and its MIME type as content-type; the response is the PDF.
FROM public.ecr.aws/docker/library/debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 libreoffice-writer-nogui libreoffice-impress-nogui \
    fonts-dejavu fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*
COPY server.py /server.py
EXPOSE 8080
CMD ["python3", "/server.py"]
