# syntax=docker/dockerfile:1.7

FROM node:20-alpine

WORKDIR /app

# Install build dependencies required by node-pty and runtime tmux
RUN apk add --no-cache python3 make g++ tmux \
 && tmux -V

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
