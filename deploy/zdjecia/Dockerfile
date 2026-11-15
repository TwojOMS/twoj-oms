FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
WORKDIR /app
# Sam proces zdjęć, bez zależności, panelu i bazy.
COPY src/zdjecia-publiczne/serwer.js ./serwer.mjs
USER 1000:1000
EXPOSE 3002
CMD ["node", "/app/serwer.mjs"]
