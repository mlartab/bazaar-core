FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Ensure the data directory exists for SQLite
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "protocol/start.js"]
