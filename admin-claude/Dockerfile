FROM node:20-slim
WORKDIR /app
COPY admin-claude/package*.json ./
RUN npm ci --production
COPY admin-claude/ .
EXPOSE 3003
CMD ["node", "index.js"]
