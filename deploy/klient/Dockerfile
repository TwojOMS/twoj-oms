# Obraz OMS dla instalacji u klienta (PRZ-058). Budowany LOKALNIE z paczki wydania:
#   cd deploy/klient && sudo docker compose build
# Kontekst = katalog główny paczki. Produkcja właściciela ma osobny Dockerfile w katalogu głównym repo —
# ten plik go nie zastępuje i nie jest przez niego używany.
# Obraz bazowy przypięty skrótem (PRZ-059): ten sam Node i Debian przy każdym buildzie u klienta.
# Odświeżenie (raz na kwartał albo po poprawce bezpieczeństwa Node): na maszynie z Dockerem
#   docker buildx imagetools inspect node:24-bookworm-slim   → wiersz „Digest:” (indeks wieloarchitekturowy)
# wpisać poniżej, zbudować, przejść bramkę i próbę aktualizacji; skrót zmienia obraz = nowe wydanie.
# Skrót z 10.10.2026 (Node 24.21.0).
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV TZ=UTC NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --maxsockets=4 --fetch-retries=5 --fetch-retry-mintimeout=1000 --fetch-retry-maxtimeout=30000 --fetch-timeout=300000 \
  && npm cache clean --force
COPY src ./src
COPY scripts/instalacja-wspolne.mjs scripts/instalacja-przygotuj.mjs scripts/instalacja-proba.mjs scripts/instalacja-demo.mjs scripts/instalacja-kontener.mjs ./scripts/
# PRZ-062: przejście na pracę (pierwsze konto, granice raportu) i granica raportu kanału dodanego później.
COPY scripts/produkcja-pierwszy-start.mjs scripts/inicjalizuj-granice-bez-historii.mjs ./scripts/
COPY scripts/link-hasla-admina.mjs ./scripts/
COPY deploy/klient/kopia.mjs ./deploy/klient/kopia.mjs
# wydanie.json jest w paczce wydania, nie w repo; wzorzec [n] pozwala zbudować obraz także z repo.
COPY package.json wydanie.jso[n] ./
# Wersja PO zależnościach (PRZ-062): ARG przed RUN unieważnia cache npm ci przy każdym nowym commicie —
# zmierzone na VM: każde wydanie pobierało pakiety z internetu (raz ETIMEDOUT po 127 s).
ARG APP_REVISION=nieznana
LABEL org.opencontainers.image.revision=$APP_REVISION
# Proces i pliki danych bez roota. Ten sam UID musi być właścicielem /opt/oms/{config,data,backups} na hoście.
USER 10001:10001
EXPOSE 3001
CMD ["node", "src/oms.js"]
