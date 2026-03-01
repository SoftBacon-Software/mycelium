FROM node:20-slim AS builder
WORKDIR /app
COPY studio-react/package*.json studio-react/
RUN cd studio-react && npm ci
COPY studio-react/ studio-react/
COPY public/ public/
RUN cd studio-react && npx vite build

FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY server/ server/
COPY --from=builder /app/public/ public/
EXPOSE 3002
CMD ["node", "server/index.js"]
