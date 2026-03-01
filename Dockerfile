FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY server/ server/
COPY public/ public/
EXPOSE 3002
CMD ["node", "server/index.js"]
