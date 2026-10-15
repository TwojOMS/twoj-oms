# Piaskownica oms-proba (PRZ-072): obraz z SAMYMI zależnościami. Kod nie jest w obrazie — kontener
# montuje go z /volume1/docker/oms-proba/kod i przeładowuje się sam (node --watch), więc zmiana kodu
# nie wymaga budowania. Przebudowa tylko po zmianie package-lock.json (proba.ps1 status to wykrywa).
# Kontekst budowania: katalog kod/ na NAS-ie. Obraz bazowy ten sam co u klienta (deploy/klient/Dockerfile).
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV TZ=UTC NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --maxsockets=4 --fetch-retries=5 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=30000 --fetch-timeout=300000 \
  && npm cache clean --force \
  && sha256sum package-lock.json | cut -d' ' -f1 > /app/zaleznosci.sha256
USER 1029:100
CMD ["node", "--version"]
