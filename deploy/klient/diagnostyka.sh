#!/bin/sh
# Diagnostyka OMS u klienta (PRZ-058). Uruchom na serwerze OMS:
#   sudo sh /opt/oms/releases/<wydanie>/deploy/klient/diagnostyka.sh
# Zapisuje JEDEN plik oms-diagnostyka-<czas>.txt w bieżącym katalogu — odeślij go.
# W pliku nie ma wartości z /opt/oms/config (hasła, klucze, NIP, rachunek): każda wartość
# z tych plików jest zastępowana przez ***, a w dzienniku dodatkowo adresy e-mail, numery
# telefonów, długie liczby i tokeny. Imion i adresów w treści dziennika nie da się wykryć
# automatycznie — przejrzyj plik przed wysłaniem.
set -u
OMS=${OMS_KATALOG:-/opt/oms}
DOCKER=${OMS_DOCKER_BIN:-docker}
LINIE=${OMS_DIAG_LINIE:-200}
WYJSCIE=${OMS_DIAG_WYJSCIE:-$PWD/oms-diagnostyka-$(date -u +%Y%m%d-%H%M%S).txt}

if [ -e "$WYJSCIE" ]; then
  echo "Plik $WYJSCIE już istnieje — nie nadpisuję." >&2
  exit 1
fi
[ "$(id -u)" = 0 ] || echo "Uwaga: bez sudo część odczytów (docker, /opt/oms/config) się nie uda." >&2

umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

sekcja() { printf '\n== %s ==\n' "$1"; }

# Wartości do zamaskowania: wszystko po pierwszym "=" w każdym pliku katalogu konfiguracji,
# także bez cudzysłowów i bez \r (pliki edytowane na Windowsie), oraz środowisko działającego
# kontenera oms — plik mógł się zmienić albo zniknąć po jego starcie. Pomijamy zmienne obrazu
# Node (PATH, NODE_VERSION…) i środowisko oms-kopia: ustawia je compose, bez sekretów.
wartosci_z() {
  awk '
    { sub(/\r$/, "") }
    /^[[:space:]]*#/ { next }
    {
      i = index($0, "="); if (i < 2) next
      v = substr($0, i + 1); print v
      if (v ~ /^".*"$/ || v ~ /^\047.*\047$/) print substr(v, 2, length(v) - 2)
    }'
}
{
  find "$OMS/config" -maxdepth 1 -type f 2>/dev/null | while IFS= read -r plik; do wartosci_z < "$plik"; done
  "$DOCKER" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' oms 2>/dev/null \
    | grep -v -E '^(PATH|HOME|HOSTNAME|NODE_VERSION|YARN_VERSION|NODE_ENV|TZ)=' | wartosci_z
} > "$tmp/wartosci"

maskuj_wartosci() {
  awk -v plik="$tmp/wartosci" '
    BEGIN {
      n = 0
      while ((getline v < plik) > 0) {
        if (length(v) < 4) continue
        # Jawne wartości z dokumentacji i kodu (tryby, loginy próby, port) — maskowanie tylko psuje czytelność.
        if (v == "proba" || v == "produkcja" || v == "true" || v == "false") continue
        # Ścieżki instalacji (np. OMS_KOPIA_ZEWNETRZNA=/opt/oms/kopia-zewnetrzna) nie są tajne, a bez nich raport jest nieczytelny.
        if (v ~ /^\/opt\/oms\/[A-Za-z0-9._\/-]*$/) continue
        if (v == "administrator-proby" || v == "serwis-proby" || v ~ /^[0-9]?[0-9]?[0-9]?[0-9]?[0-9]$/) continue
        n++; w[n] = v
      }
      for (i = 2; i <= n; i++) {
        x = w[i]; j = i - 1
        while (j > 0 && length(w[j]) < length(x)) { w[j + 1] = w[j]; j-- }
        w[j + 1] = x
      }
    }
    {
      linia = $0
      for (i = 1; i <= n; i++) {
        v = w[i]; wyn = ""
        while ((p = index(linia, v)) > 0) {
          wyn = wyn substr(linia, 1, p - 1) "***"
          linia = substr(linia, p + length(v))
        }
        linia = wyn linia
      }
      print linia
    }'
}

# Wzorce danych osobowych i tokenów — tylko dla dziennika (po maskowaniu wartości).
maskuj_wzorce() {
  sed -E \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[email]/g' \
    -e 's/(bearer|basic)[[:space:]]+[A-Za-z0-9._~+\/=-]+/\1 [ukryte]/Ig' \
    -e "s/((pass|passwd|password|haslo|token|secret|sekret|klucz|api_?key|authorization|cookie|sesja|session)[A-Za-z0-9_]*[\"']?[[:space:]]*[:=][[:space:]]*[\"']?)[^\"' ,;&}]+/\\1[ukryte]/Ig" \
    -e 's/\+?48[ -]?[0-9]{3}[ -]?[0-9]{3}[ -]?[0-9]{3}/[telefon]/g' \
    -e 's/[0-9]{3}[ -][0-9]{3}[ -][0-9]{3}/[telefon]/g' \
    -e 's/[0-9]{9,}/[liczba]/g' \
    -e 's/[A-Za-z0-9_-]{32,}/[token]/g'
}

{
  echo "Diagnostyka OMS"
  echo "czas UTC: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  sekcja "System"
  if [ -r /etc/os-release ]; then (. /etc/os-release; echo "system: ${PRETTY_NAME:-nieznany}"); else echo "system: nieznany"; fi
  echo "jądro: $(uname -r 2>/dev/null)"
  echo "architektura: $(uname -m 2>/dev/null)"
  echo "procesory: $(nproc 2>/dev/null || echo ?)"
  grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null
  echo "czas pracy: $(uptime 2>/dev/null)"

  sekcja "Docker"
  echo "docker: $("$DOCKER" version --format '{{.Server.Version}} (klient {{.Client.Version}})' 2>&1)"
  echo "compose: $("$DOCKER" compose version 2>&1)"

  sekcja "Wersja OMS"
  echo "etykieta revision: $("$DOCKER" inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' oms 2>&1)"
  wydanie=$("$DOCKER" exec oms cat /app/wydanie.json 2>/dev/null)
  if [ -n "$wydanie" ]; then
    printf '%s\n' "$wydanie" | sed -n -e 's/.*"commit": *"\([0-9a-f]*\)".*/commit: \1/p' -e 's/.*"tree": *"\([0-9a-f]*\)".*/tree: \1/p'
  else
    echo "brak /app/wydanie.json w kontenerze oms (obraz spoza paczki albo kontener nie działa)"
  fi
  echo "rozpakowane wydania:"; ls -1 "$OMS/releases" 2>&1 | sed 's/^/  /'

  sekcja "Kontenery"
  "$DOCKER" ps -a --filter label=com.docker.compose.project=oms --format '{{.Names}}  {{.Image}}  {{.Status}}' 2>&1
  for k in oms oms-kopia; do
    "$DOCKER" inspect --format 'kontener={{.Name}} obraz={{.Config.Image}} id={{.Image}} stan={{.State.Status}} start={{.State.StartedAt}} restarty={{.RestartCount}} zdrowie={{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$k" 2>&1
  done

  sekcja "Health"
  "$DOCKER" exec oms node -e "fetch('http://127.0.0.1:3001/health').then(async r=>{const j=await r.json();console.log('HTTP '+r.status+' ok='+j.ok+' alarmy='+JSON.stringify(j.alarmy||[])+' uwagi='+JSON.stringify(j.uwagi||[]))}).catch(e=>console.log('health niedostępny: '+e.message))" 2>&1

  sekcja "Dysk"
  df -hP / "$OMS" /var/lib/docker 2>&1
  du -sh "$OMS/data" "$OMS/backups" "$OMS/releases" 2>&1
  "$DOCKER" system df 2>&1

  sekcja "Kopie"
  # Ten sam próg co /health OMS-u (src/moduly/zdrowie/kopie.ts): 48 h.
  ocen_kopie() {
    ostatnia=$(ls -1t "$1"/oms-*.sqlite 2>/dev/null | head -n 1)
    if [ -n "$ostatnia" ]; then
      wiek=$(( ($(date +%s) - $(stat -c %Y "$ostatnia")) / 3600 ))
      echo "$2: $(basename "$ostatnia"), $(stat -c %s "$ostatnia") B, wiek $wiek h"
      [ "$wiek" -lt 48 ] || echo "ALARM: $2 ma $wiek h (próg 48 h)"
      echo "kopii bazy w $1: $(ls -1 "$1"/oms-*.sqlite 2>/dev/null | wc -l)"
    else
      echo "BRAK KOPII w $1"
    fi
  }
  ocen_kopie "$OMS/backups" "ostatnia kopia"
  echo "archiwa etykiet i proform: $(ls -1 "$OMS/backups"/pliki-*.tgz 2>/dev/null | wc -l)"
  zewn=$(sed -e 's/\r$//' -n -e 's/^OMS_KOPIA_ZEWNETRZNA=//p' "$OMS/config/kopia.env" 2>/dev/null | tail -n 1 | tr -d "\"'")
  if [ -z "$zewn" ]; then
    echo "kopia poza dyskiem: NIEUSTAWIONA — awaria dysku serwera zabierze bazę razem z kopiami ($OMS/config/kopia.env)"
  else
    # Ta sama ścieżka w kontenerze i na hoście (compose); OMS_KATALOG przesuwa /opt/oms (testy).
    nosnik="$OMS/${zewn#/opt/oms/}"
    echo "kopia poza dyskiem: $zewn (na hoście $nosnik)"
    df -hP "$nosnik" 2>&1 | tail -n 1
    # Znacznik w katalogu, na którym nic nie zamontowano = kopia na dysku serwera (montowanie się nie udało).
    if command -v mountpoint >/dev/null 2>&1 && [ -d "$nosnik" ] && ! mountpoint -q "$nosnik"; then
      echo "ALARM: kopia poza dyskiem — $nosnik nie jest punktem montowania (nośnik niezamontowany)"
    elif [ -f "$nosnik/.oms-cel-kopii" ]; then ocen_kopie "$nosnik" "kopia poza dyskiem"
    else echo "ALARM: kopia poza dyskiem — brak nośnika w $nosnik (brak pliku .oms-cel-kopii)"; fi
  fi

  sekcja "Aktualizacje"
  if [ -f "$OMS/update-state/biezace" ]; then echo "bieżące wydanie: $(cat "$OMS/update-state/biezace")"; else echo "bieżące wydanie: brak wskaźnika (instalacja bez aktualizacji)"; fi
  if [ -d "$OMS/update-state/blokada" ]; then
    echo "OPERACJA AKTUALIZACJI W TOKU:"
    grep -E '^(operacja|etap|start|baza_wydanie|cel_wydanie|blad)=' "$OMS/update-state/blokada/stan" 2>/dev/null | sed 's/^/  /'
  fi
  tail -n 5 "$OMS/update-state/historia" 2>/dev/null | cut -d ' ' -f 1-5 | sed 's/^/  /'

  sekcja "Konfiguracja"
  [ -f "$OMS/config/oms.env" ] || echo "BRAK oms.env w $OMS/config — OMS nie wstanie"
  # Compose podstawia $ w env_file (poza apostrofami) — wartość zmienia się po cichu. Tylko nazwy.
  for plik in "$OMS/config/oms.env" "$OMS/config/kopia.env"; do
    [ -f "$plik" ] || continue
    awk '/^[[:space:]]*#/ {next}
      /^[A-Za-z_][A-Za-z0-9_]*=/ { v = substr($0, index($0, "=") + 1); sub(/\r$/, "", v)
        if (v ~ /^\047.*\047$/) next
        if (index(v, "$")) print substr($0, 1, index($0, "=") - 1) }' "$plik" \
    | while IFS= read -r nazwa; do echo "UWAGA: $(basename "$plik"): $nazwa zawiera \$ — compose podstawi zmienną (ujmij w apostrofy albo zapisz \$\$)"; done
  done
  find "$OMS/config" -maxdepth 1 -type f 2>/dev/null | sort | while IFS= read -r plik; do
    # Tylko poprawne nazwy zmiennych — wiersz klucza PEM czy JSON nie wyjdzie jako „nazwa”.
    nazwy=$(sed -e 's/\r$//' -n -e 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$plik" | tr '\n' ' ')
    echo "$(basename "$plik") ($(stat -c '%a uid=%u' "$plik")): $nazwy"
  done
} > "$tmp/opis" 2>&1

{
  sekcja "Dziennik oms"
  "$DOCKER" logs --tail "$LINIE" oms 2>&1
  sekcja "Dziennik oms-kopia"
  "$DOCKER" logs --tail "$LINIE" oms-kopia 2>&1
} > "$tmp/dziennik" 2>&1

{
  maskuj_wartosci < "$tmp/opis"
  maskuj_wartosci < "$tmp/dziennik" | maskuj_wzorce
} > "$tmp/wynik"

cp "$tmp/wynik" "$WYJSCIE" || exit 1
# Uruchomione przez sudo: plik ma należeć do osoby, która go odeśle (inaczej scp go nie przeczyta).
if [ "$(id -u)" = 0 ] && [ -n "${SUDO_UID:-}" ]; then chown "$SUDO_UID:${SUDO_GID:-$SUDO_UID}" "$WYJSCIE"; fi
echo "Zapisano: $WYJSCIE"
echo "Przejrzyj plik i odeślij go. Hasła i klucze z $OMS/config są w nim zastąpione przez ***."
