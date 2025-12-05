FROM node:20-alpine

# Tools needed inside the container
RUN apk add --no-cache docker-cli libvirt-client

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "server.mjs"]



