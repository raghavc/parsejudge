# Splits a PDF into one PDF per page, for uploads too large to split in the Worker's 128 MB.
# Uses pdf-lib, the same library the Worker uses, so page files are the same either way.
FROM public.ecr.aws/docker/library/node:22-slim
WORKDIR /app
COPY package.json server.mjs ./
RUN npm install --omit=dev --no-audit --no-fund
EXPOSE 8080
CMD ["node", "server.mjs"]
