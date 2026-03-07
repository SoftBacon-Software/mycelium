FROM node:22-slim AS builder
WORKDIR /app
COPY studio-react/package*.json studio-react/
RUN cd studio-react && npm ci
COPY studio-react/ studio-react/
COPY public/ public/
RUN cd studio-react && npx vite build

FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY mcp/package*.json mcp/
COPY runner/package*.json runner/
RUN npm ci --production
COPY server/ server/
COPY tools/ tools/
COPY --from=builder /app/public/ public/
EXPOSE 3002
CMD ["node", "server/boot.js"]
