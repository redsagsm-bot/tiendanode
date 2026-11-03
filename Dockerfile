FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY admin ./admin
RUN mkdir -p /data
ENV DATA_DIR=/data
# Se ejecuta como root para poder escribir en el Volume de Railway montado en /data
EXPOSE 3000
CMD ["node", "server.js"]
