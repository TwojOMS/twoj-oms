#!/bin/sh
# Aktualizator V0 instalacji OMS u klienta (PRZ-059). Uruchamia operator przez sudo na serwerze:
#   sudo sh /opt/oms/aktualizuj.sh status
#   sudo sh /opt/oms/aktualizuj.sh deploy <oms-XXXXXXXXXXXX.tar.gz> <sha256 paczki>
#   sudo sh /opt/oms/aktualizuj.sh accept <operacja>
#   sudo sh /opt/oms/aktualizuj.sh recover <operacja> [--przywroc-baze | --porzuc-prace]   (porzuc-prace: tylko po przejściu na pracę)
#   sudo sh /opt/oms/aktualizuj.sh compose <polecenie docker compose…>   (w bieżącym wydaniu)
#   sudo sh /opt/oms/aktualizuj.sh produkcja      przejście z próby na pracę (PRZ-062): pierwszy raz zakłada
#                                                  config/produkcja.env do uzupełnienia, drugi raz przełącza
#   sudo sh /opt/oms/aktualizuj.sh zdrowie        pełna odpowiedź /health (alarmy z nazwami zmiennych, bez wartości)
# Instrukcja: docs/aktualizacja-klienta-v0.md. Semantyka według docs/prz050-aktualizator-plan.md
# i runnera produkcji deploy/nas/oms-release-remote.sh (deploy → NEEDS_ACCEPT → accept | recover).
#
# Stan na dysku (przetrwa restart maszyny; nic nie wznawia się samo):
#   /opt/oms/update-state/biezace   nazwa bieżącego wydania (oms-<12 znaków commita>), zmiana przez mv
#   /opt/oms/update-state/blokada/  blokada JEDNEJ operacji (mkdir jest atomowy), w niej plik stan
#   /opt/oms/update-state/historia  dziennik operacji (bez sekretów)
#   /opt/oms/backups/operacje/<op>/ kopia operacji: baza (VACUUM INTO), lista migracji, oms.env, pliki
# Etapy deploy: zablokowane → rozpakowane → zbudowane → zatrzymane → kopia → uruchomione → czeka_na_akceptacje.
# Do etapu „zbudowane” pracuje stare wydanie (przerwy nie ma); od „zatrzymane” do zdrowego kandydata panel stoi.
set -eu
umask 022

OMS=${OMS_KATALOG:-/opt/oms}
DOCKER=${OMS_DOCKER_BIN:-docker}
CZEKAJ_S=${OMS_AKT_CZEKAJ_S:-180}
ODSTEP_S=${OMS_AKT_ODSTEP_S:-2}
# Zmierzone 10.10 na VM (Debian 13, Docker 29.9): nowy obraz + cache budowania na jedno wydanie ≈ 0,5 GB;
# próg z zapasem ×3. Poniżej — odmowa przed jakąkolwiek zmianą.
MIN_DOCKER_MB=${OMS_AKT_MIN_DOCKER_MB:-1500}
REZERWA_MB=${OMS_AKT_REZERWA_MB:-300}
UID_OMS=10001
STAN_DIR="$OMS/update-state"
BLOKADA="$STAN_DIR/blokada"
STAN="$BLOKADA/stan"
WSKAZNIK="$STAN_DIR/biezace"
HISTORIA="$STAN_DIR/historia"
RELEASES="$OMS/releases"
OPERACJE="$OMS/backups/operacje"
PRODUKCJA_ENV="$OMS/config/produkcja.env"
ARCHIWA="$OMS/proba-archiwum"
SKRYPT=$0

fail() { echo "$1" >&2; exit 1; }
teraz() { date -u +%Y-%m-%dT%H:%M:%SZ; }

valid_sha() { case "$1" in *[!0-9a-f]*|'') return 1 ;; esac; [ "${#1}" -eq "$2" ]; }
valid_wydanie() { case "$1" in oms-*) valid_sha "${1#oms-}" 12 ;; *) return 1 ;; esac; }
valid_op() { case "$1" in *[!0-9a-f-]*|'') return 1 ;; esac; [ "${#1}" -eq 20 ]; }

pole() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1; }
stan_pole() { if [ -f "$STAN" ]; then pole "$STAN" "$1"; fi; }
stan_ustaw() {
  tmp="$STAN.tmp.$$"
  { grep -v "^$1=" "$STAN" 2>/dev/null || true; printf '%s=%s\n' "$1" "$2"; } > "$tmp"
  mv "$tmp" "$STAN"
  # Utrata zasilania tuż po mv bez sync potrafi zostawić plik zerowej długości (ext4, eMMC).
  # Tylko ten plik i katalog: globalny sync wisi (stan D), gdy psuje się pendrive kopii albo udział sieciowy.
  sync "$STAN" "$BLOKADA" 2>/dev/null || true
}
ustaw_wskaznik() { printf '%s\n' "$1" > "$WSKAZNIK.tmp.$$"; mv "$WSKAZNIK.tmp.$$" "$WSKAZNIK"; sync "$WSKAZNIK" "$STAN_DIR" 2>/dev/null || true; }
historia() { printf '%s %s\n' "$(teraz)" "$*" >> "$HISTORIA"; }
zdejmij_blokade() { rm -f "$STAN" "$BLOKADA"/stan.tmp.*; rmdir "$BLOKADA"; }

commit_wydania() { sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' "$RELEASES/$1/wydanie.json" 2>/dev/null | head -n 1; }
compose_w() { cw_wyd=$1; shift; "$DOCKER" compose -f "$RELEASES/$cw_wyd/deploy/klient/compose.yaml" "$@"; }

obraz_kontenera() { "$DOCKER" inspect --format '{{.Image}}' "$1" 2>/dev/null || true; }
dziala() { [ "$("$DOCKER" inspect --format '{{.State.Running}}' "$1" 2>/dev/null || true)" = true ]; }
rewizja_obrazu() { "$DOCKER" image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$1" 2>/dev/null || true; }
id_obrazu() { "$DOCKER" image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }

zdrowie() {
  "$DOCKER" exec oms node -e "fetch('http://127.0.0.1:3001/health').then(async r=>{let w='brak',a='?';try{const j=await r.json();if(typeof j.wersja==='string')w=j.wersja;if(Array.isArray(j.alarmy))a=j.alarmy.length}catch{}console.log('HTTP='+r.status+' wersja='+w+' alarmy='+a)}).catch(()=>console.log('HTTP=0 wersja=brak alarmy=?'))" 2>/dev/null \
    || echo 'HTTP=0 wersja=brak alarmy=?'
}

# Zdrowy OMS z DOKŁADNIE tym kodem: /health 200, wersja w /health (gdy wydanie ją podaje) i
# /app/wydanie.json w działającym kontenerze = commit, kontener na zbudowanym obrazie. Sam 200 nie wystarcza.
czekaj_na_oms() {
  oczekiwany=$1; obraz=$2
  koniec=$(( $(date +%s) + CZEKAJ_S ))
  ZDROWIE='HTTP=0 wersja=brak alarmy=?'
  while :; do
    if dziala oms; then
      ZDROWIE=$(zdrowie)
      case "$ZDROWIE" in HTTP=200\ *) break ;; esac
    fi
    # Proces pada przy starcie → Docker restartuje go w kółko; czekanie pełnych CZEKAJ_S to tylko
    # dłuższa przerwa (próba 10.10: 180 s ze zepsutym kandydatem). Trzeci restart = koniec czekania.
    restarty=$("$DOCKER" inspect --format '{{.RestartCount}}' oms 2>/dev/null || echo 0)
    case "$restarty" in ''|*[!0-9]*) restarty=0 ;; esac
    if [ "$restarty" -ge 3 ]; then echo "KANDYDAT_W_PETLI_RESTARTOW ($restarty restartów, ostatnio: $ZDROWIE)" >&2; return 1; fi
    [ "$(date +%s)" -lt "$koniec" ] || { echo "OMS_NIE_WSTAL w ${CZEKAJ_S} s (ostatnio: $ZDROWIE)" >&2; return 1; }
    sleep "$ODSTEP_S"
  done
  wersja=${ZDROWIE#*wersja=}; wersja=${wersja%% *}
  if [ "$wersja" != brak ] && [ "$wersja" != "$oczekiwany" ]; then echo "WERSJA_W_HEALTH_NIEZGODNA $wersja" >&2; return 1; fi
  cz_w=$("$DOCKER" exec oms cat /app/wydanie.json 2>/dev/null | sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' | head -n 1 || true)
  [ "$cz_w" = "$oczekiwany" ] || { echo "WERSJA_W_KONTENERZE_NIEZGODNA ${cz_w:-brak}" >&2; return 1; }
  [ "$(obraz_kontenera oms)" = "$obraz" ] || { echo 'KONTENER_OMS_NA_INNYM_OBRAZIE' >&2; return 1; }
}

# Start wydania na jego zweryfikowanym obrazie: oms, kontrola, potem kopia (ten sam obraz).
uruchom_wydanie() {
  uw_wyd=$1; uw_c=$2; uw_o=$3
  "$DOCKER" tag "$uw_o" "oms:$uw_c" || return 1
  compose_w "$uw_wyd" up -d --no-build --no-deps --force-recreate oms || return 1
  [ "$(obraz_kontenera oms)" = "$uw_o" ] || { echo 'KONTENER_OMS_NA_INNYM_OBRAZIE' >&2; return 1; }
  czekaj_na_oms "$uw_c" "$uw_o" || return 1
  compose_w "$uw_wyd" up -d --no-build --no-deps --force-recreate kopia || return 1
  [ "$(obraz_kontenera oms-kopia)" = "$uw_o" ] || { echo 'KONTENER_KOPII_NA_INNYM_OBRAZIE' >&2; return 1; }
}

# Oba naraz (docker stop zatrzymuje równolegle): pętla kopii PRZ-058 (sh jako PID 1) ignoruje SIGTERM
# i czeka pełne 10 s — zmierzone 10.10, przerwa 17 s przy zatrzymaniu po kolei.
zatrzymaj_oms() {
  "$DOCKER" stop oms-kopia oms >/dev/null 2>&1 || true
  ! dziala oms && ! dziala oms-kopia
}

wolne_mb() { df -Pk "$1" 2>/dev/null | awk 'NR==2 {print int($4/1024)}'; }

# Compose podstawia $ w env_file: hasło z $ zmieni się po cichu (PRZ-058, wada 8). Tylko nazwy, bez wartości.
ostrzez_dolar() {
  for f in "$OMS/config/oms.env" "$OMS/config/kopia.env" "$PRODUKCJA_ENV"; do
    [ -f "$f" ] || continue
    awk '/^[[:space:]]*#/ {next}
      /^[A-Za-z_][A-Za-z0-9_]*=/ { v = substr($0, index($0, "=") + 1); sub(/\r$/, "", v)
        if (v ~ /^\047.*\047$/) next
        if (index(v, "$")) print substr($0, 1, index($0, "=") - 1) }' "$f" \
    | while IFS= read -r nazwa; do
        echo "UWAGA_DOLAR_W_KONFIGURACJI $f: $nazwa — compose podstawi zmienną; ujmij wartość w apostrofy '…' albo zapisz \$\$" >&2
      done
  done
}

wymagaj_roota() {
  [ "$(id -u)" = 0 ] || [ -n "${OMS_AKT_BEZ_ROOTA:-}" ] || fail 'URUCHOM_PRZEZ_SUDO'
}

# Bieżące wydanie: wskaźnik, a bez niego (instalacja sprzed aktualizatora) — etykieta działającego kontenera.
ustal_baze() {
  if [ -s "$WSKAZNIK" ]; then
    BAZA_WYD=$(cat "$WSKAZNIK"); BAZA_ZRODLO=wskaznik
  else
    rev=$("$DOCKER" inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' oms 2>/dev/null || true)
    valid_sha "$rev" 40 || fail 'BAZA_NIEZNANA: brak wskaźnika bieżącego wydania i kontenera oms z etykietą revision'
    BAZA_WYD=oms-$(printf '%.12s' "$rev"); BAZA_ZRODLO=adopcja
  fi
  valid_wydanie "$BAZA_WYD" || fail "BAZA_ZLY_WSKAZNIK: $BAZA_WYD"
  BAZA_COMMIT=$(commit_wydania "$BAZA_WYD")
  valid_sha "$BAZA_COMMIT" 40 || fail "BAZA_BRAK_WYDANIA: $RELEASES/$BAZA_WYD/wydanie.json"
  BAZA_OBRAZ=$(obraz_kontenera oms)
  [ -n "$BAZA_OBRAZ" ] || fail 'BAZA_BRAK_KONTENERA_OMS'
  [ "$(rewizja_obrazu "$BAZA_OBRAZ")" = "$BAZA_COMMIT" ] || fail "BAZA_KONTENER_Z_INNEGO_WYDANIA: działa $(rewizja_obrazu "$BAZA_OBRAZ"), wskaźnik $BAZA_COMMIT"
  k=$(obraz_kontenera oms-kopia)
  [ -z "$k" ] || [ "$k" = "$BAZA_OBRAZ" ] || fail 'BAZA_KONTENERY_ROZNE_OBRAZY'
  if [ -f "$RELEASES/$BAZA_WYD/.obraz" ]; then
    [ "$(cat "$RELEASES/$BAZA_WYD/.obraz")" = "$BAZA_OBRAZ" ] || fail 'BAZA_INNY_OBRAZ_NIZ_ZBUDOWANY'
  fi
}

# --- deploy ------------------------------------------------------------------------------------

po_bledzie_deploy() {
  rc=$?
  trap - EXIT INT TERM HUP
  [ "$rc" -ne 0 ] || exit 0
  etap=$(stan_pole etap)
  case "$etap" in
    zablokowane|rozpakowane|zbudowane)
      rm -rf "$RELEASES/.tmp-$OP"
      zdejmij_blokade
      historia "$OP PRZERWANE etap=$etap kod=$rc (OMS nie był zatrzymany)"
      echo "PRZERWANE na etapie $etap — OMS nie był zatrzymany, blokada zdjęta, działa $BAZA_WYD" >&2 ;;
    zatrzymane|kopia)
      if uruchom_wydanie "$BAZA_WYD" "$BAZA_COMMIT" "$BAZA_OBRAZ"; then
        zdejmij_blokade
        historia "$OP WYCOFANE etap=$etap kod=$rc (baza nietknięta, wrócił $BAZA_WYD)"
        echo "WYCOFANE na etapie $etap — kandydat nie startował, wrócił $BAZA_WYD, blokada zdjęta" >&2
      else
        stan_ustaw blad "deploy przerwany na etapie $etap, powrót $BAZA_WYD nieudany"
        echo "BLAD: powrót $BAZA_WYD nieudany — blokada zostaje. Dalej: sudo sh $SKRYPT recover $OP" >&2
      fi ;;
    *)
      stan_ustaw blad "deploy przerwany na etapie ${etap:-?} (kod $rc)"
      echo "BLAD na etapie ${etap:-?} — kandydat mógł już pracować na bazie. Blokada zostaje. Dalej: sudo sh $SKRYPT status, potem recover $OP" >&2 ;;
  esac
  exit "$rc"
}

deploy() {
  PACZKA=$1; SHA=$2
  wymagaj_roota
  [ ! -d "$BLOKADA" ] || fail "ODMOWA_TRWA_OPERACJA $(stan_pole operacja) etap=$(stan_pole etap) — sudo sh $SKRYPT status"
  valid_sha "$SHA" 64 || fail 'NIEPRAWIDLOWY_SHA256_PACZKI'
  [ -f "$PACZKA" ] || fail "BRAK_PACZKI: $PACZKA"
  [ "$(sha256sum < "$PACZKA" | cut -d ' ' -f 1)" = "$SHA" ] || fail 'PACZKA_USZKODZONA_LUB_PODMIENIONA'

  # Treść paczki bez rozpakowania: jeden katalog oms-<12>, tylko pliki i katalogi, bez .. i ścieżek absolutnych.
  lista=$(tar -tzf - < "$PACZKA") || fail 'PACZKA_NIECZYTELNA'
  typy=$(tar -tvzf - < "$PACZKA" | cut -c1 | sort -u | tr -d '\n') || fail 'PACZKA_NIECZYTELNA'
  case "$typy" in *[!-d]*) fail "PACZKA_NIEDOZWOLONY_TYP_WPISU: $typy (dowiązanie, urządzenie)" ;; esac
  if printf '%s\n' "$lista" | grep -qE '(^/|^[A-Za-z]:|(^|/)\.\.(/|$)|\\)'; then fail 'PACZKA_NIEBEZPIECZNA_SCIEZKA'; fi
  TOP=$(printf '%s\n' "$lista" | head -n 1 | cut -d / -f 1)
  valid_wydanie "$TOP" || fail "PACZKA_ZLY_KATALOG: $TOP"
  if printf '%s\n' "$lista" | grep -vq "^$TOP/"; then fail 'PACZKA_WIELE_KATALOGOW'; fi
  wydanie=$(tar -xzOf - "$TOP/wydanie.json" < "$PACZKA" 2>/dev/null) || fail 'PACZKA_BRAK_WYDANIA_JSON'
  CEL_COMMIT=$(printf '%s\n' "$wydanie" | sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' | head -n 1)
  valid_sha "$CEL_COMMIT" 40 || fail 'PACZKA_ZLY_WYDANIE_JSON'
  printf '%s\n' "$wydanie" | grep -qE '"tree": *"[0-9a-f]{40}"' || fail 'PACZKA_ZLY_WYDANIE_JSON'
  [ "$TOP" = "oms-$(printf '%.12s' "$CEL_COMMIT")" ] || fail 'PACZKA_KATALOG_NIEZGODNY_Z_COMMITEM'
  CEL_WYD=$TOP
  # Aktualizator musi pochodzić z tej paczki — inaczej stan operacji zapisuje inna wersja niż ta, która go potem czyta.
  tar -xzOf - "$TOP/deploy/klient/aktualizuj.sh" < "$PACZKA" 2>/dev/null | cmp -s - "$SKRYPT" \
    || fail "AKTUALIZATOR_INNY_NIZ_W_PACZCE — zainstaluj: tar -xzOf $PACZKA $TOP/deploy/klient/aktualizuj.sh | sudo tee $OMS/aktualizuj.sh >/dev/null"

  ustal_baze
  [ "$CEL_COMMIT" != "$BAZA_COMMIT" ] || fail "WERSJA_DOCELOWA_TAKA_SAMA_JAK_BIEZACA: $CEL_WYD"
  REUZYJ=0
  if [ -e "$RELEASES/$CEL_WYD" ]; then
    [ "$(cat "$RELEASES/$CEL_WYD/.paczka.sha256" 2>/dev/null || true)" = "$SHA" ] || fail "WYDANIE_ISTNIEJE_I_JEST_INNE: $RELEASES/$CEL_WYD"
    (cd "$RELEASES/$CEL_WYD" && sha256sum -c --quiet .pliki.sha256 >/dev/null 2>&1) || fail "WYDANIE_ISTNIEJE_I_ZOSTALO_ZMIENIONE: $RELEASES/$CEL_WYD"
    REUZYJ=1
  fi

  # Miejsce: obraz + cache budowania po stronie Dockera; rozpakowanie + kopia operacji po stronie /opt/oms.
  root=$("$DOCKER" info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
  for k in "$root" /var/lib/containerd; do
    [ -d "$k" ] || continue
    wolne=$(wolne_mb "$k")
    [ -n "$wolne" ] && [ "$wolne" -ge "$MIN_DOCKER_MB" ] || fail "BRAK_MIEJSCA_DOCKER: $k wolne ${wolne:-?} MB, potrzeba $MIN_DOCKER_MB MB"
  done
  dane_mb=$(( $(du -sk "$OMS/data" 2>/dev/null | cut -f 1 || echo 0) / 1024 + 1 ))
  paczka_mb=$(( $(wc -c < "$PACZKA") * 4 / 1048576 + 1 ))
  potrzeba=$(( dane_mb + paczka_mb + REZERWA_MB ))
  wolne=$(wolne_mb "$OMS")
  [ -n "$wolne" ] && [ "$wolne" -ge "$potrzeba" ] || fail "BRAK_MIEJSCA_OMS: $OMS wolne ${wolne:-?} MB, potrzeba $potrzeba MB (dane $dane_mb + wydanie $paczka_mb + rezerwa $REZERWA_MB)"
  ostrzez_dolar

  # --- blokada: od tej chwili każda zmiana należy do jednej operacji ---
  mkdir -p "$STAN_DIR"; chmod 700 "$STAN_DIR"
  mkdir "$BLOKADA" 2>/dev/null || fail 'ODMOWA_TRWA_OPERACJA (blokada założona równolegle)'
  OP=$(date -u +%Y%m%d-%H%M%S)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')
  {
    printf 'operacja=%s\netap=zablokowane\npid=%s\nstart=%s\n' "$OP" "$$" "$(teraz)"
    printf 'baza_wydanie=%s\nbaza_commit=%s\nbaza_obraz=%s\n' "$BAZA_WYD" "$BAZA_COMMIT" "$BAZA_OBRAZ"
    printf 'cel_wydanie=%s\ncel_commit=%s\npaczka_sha256=%s\n' "$CEL_WYD" "$CEL_COMMIT" "$SHA"
  } > "$BLOKADA/stan.tmp.$$"
  mv "$BLOKADA/stan.tmp.$$" "$STAN"
  sync "$STAN" "$BLOKADA" 2>/dev/null || true
  trap po_bledzie_deploy EXIT
  trap 'exit 130' INT TERM HUP
  historia "$OP DEPLOY $BAZA_WYD -> $CEL_WYD paczka=$SHA"
  if [ "$BAZA_ZRODLO" = adopcja ]; then
    ustaw_wskaznik "$BAZA_WYD"
    historia "$OP ADOPCJA wskaźnik=$BAZA_WYD (instalacja sprzed aktualizatora)"
  fi
  echo "ZABLOKOWANE operacja=$OP baza=$BAZA_WYD cel=$CEL_WYD"

  # Rozpakowanie do katalogu tymczasowego; odciski i suma paczki zapisane PRZED nadaniem nazwy.
  if [ "$REUZYJ" -eq 0 ]; then
    tmp="$RELEASES/.tmp-$OP"
    mkdir -p "$tmp"
    tar -xzf - -C "$tmp" --no-same-owner < "$PACZKA"
    [ -z "$(find "$tmp" -type l -print -quit)" ] || fail 'PACZKA_DOWIAZANIE_PO_ROZPAKOWANIU'
    (cd "$tmp/$TOP" && find . -type f ! -name .pliki.sha256 -exec sha256sum {} + | sort -k 2 > .pliki.sha256)
    printf '%s\n' "$SHA" > "$tmp/$TOP/.paczka.sha256"
    chmod -R go-w "$tmp/$TOP"
    mv "$tmp/$TOP" "$RELEASES/$CEL_WYD"
    rmdir "$tmp"
  fi
  stan_ustaw etap rozpakowane
  echo "ROZPAKOWANE $RELEASES/$CEL_WYD"

  # Build, gdy stare wydanie nadal pracuje — przerwa zaczyna się dopiero przy zatrzymaniu.
  compose_w "$CEL_WYD" build oms
  CEL_OBRAZ=$(id_obrazu "oms:$CEL_COMMIT")
  case "$CEL_OBRAZ" in sha256:*) ;; *) fail 'BRAK_ZBUDOWANEGO_OBRAZU' ;; esac
  [ "$(rewizja_obrazu "$CEL_OBRAZ")" = "$CEL_COMMIT" ] || fail 'OBRAZ_Z_INNEGO_COMMITU'
  printf '%s\n' "$CEL_OBRAZ" > "$RELEASES/$CEL_WYD/.obraz"
  stan_ustaw cel_obraz "$CEL_OBRAZ"
  stan_ustaw etap zbudowane
  echo "ZBUDOWANE obraz=$CEL_OBRAZ"

  # Okno przerwy: OMS i pętla kopii stoją — żadnych zapisów do bazy.
  t_stop=$(date +%s)
  stan_ustaw etap zatrzymane
  stan_ustaw zatrzymane_czas "$(teraz)"
  zatrzymaj_oms || fail 'NIE_ZATRZYMANO_OMS'
  echo "ZATRZYMANE $BAZA_WYD"

  OPDIR="$OPERACJE/$OP"
  mkdir -p "$OPERACJE"; chmod 700 "$OPERACJE"
  mkdir "$OPDIR"; chmod 700 "$OPDIR"
  chown "$UID_OMS:$UID_OMS" "$OPDIR" 2>/dev/null || [ "$(id -u)" != 0 ]
  stan_ustaw kopia "$OPDIR"
  "$DOCKER" run --rm --network none --user "$UID_OMS:$UID_OMS" \
    -v "$OMS/data:/opt/oms/data" -v "$OPDIR:/kopia" \
    -v "$RELEASES/$CEL_WYD/deploy/klient/kopia.mjs:/narzedzie/kopia.mjs:ro" \
    --entrypoint node "$BAZA_OBRAZ" /narzedzie/kopia.mjs operacja /opt/oms/data/oms.sqlite /kopia > "$OPDIR/wynik.json" \
    || fail 'KOPIA_OPERACJI_NIEUDANA'
  grep -q '"ok":true' "$OPDIR/wynik.json" || fail 'KOPIA_OPERACJI_NIEUDANA'
  grep -q '"integralnosc":"ok"' "$OPDIR/wynik.json" || fail 'KOPIA_OPERACJI_NIESPOJNA'
  mkdir "$OPDIR/pliki" "$OPDIR/config"
  for k in proformy etykiety; do
    if [ -d "$OMS/data/$k" ]; then cp -a "$OMS/data/$k" "$OPDIR/pliki/" || fail "KOPIA_OPERACJI_PLIKI_NIEUDANA: $k"; fi
  done
  for f in oms.env kopia.env; do
    if [ -f "$OMS/config/$f" ]; then cp -p "$OMS/config/$f" "$OPDIR/config/$f" || fail "KOPIA_OPERACJI_KONFIGURACJA_NIEUDANA: $f"; fi
  done
  (cd "$OPDIR" && find . -type f ! -name kopia.sha256 -exec sha256sum {} + | sort -k 2 > kopia.sha256)
  stan_ustaw etap kopia
  echo "KOPIA $OPDIR $(cat "$OPDIR/wynik.json")"

  # Kandydat. Etap zapisany PRZED startem: od tej chwili kandydat może migrować bazę.
  stan_ustaw etap uruchomione
  uruchom_wydanie "$CEL_WYD" "$CEL_COMMIT" "$CEL_OBRAZ" || fail 'KANDYDAT_NIE_WSTAL'
  przerwa=$(( $(date +%s) - t_stop ))
  stan_ustaw przerwa_s "$przerwa"
  stan_ustaw etap czeka_na_akceptacje
  trap - EXIT INT TERM HUP
  historia "$OP NEEDS_ACCEPT $CEL_WYD obraz=$CEL_OBRAZ przerwa=${przerwa}s"
  echo "zdrowie: $ZDROWIE"
  echo "NEEDS_ACCEPT operacja=$OP cel=$CEL_COMMIT obraz=$CEL_OBRAZ przerwa_s=$przerwa"
  echo "Odbiór: docs/aktualizacja-klienta-v0.md. Potem: sudo sh $SKRYPT accept $OP  albo  sudo sh $SKRYPT recover $OP"
}

wymagaj_operacji() {
  [ -d "$BLOKADA" ] || fail 'BRAK_OPERACJI_W_TOKU'
  [ -s "$STAN" ] || return 0
  [ "$(stan_pole operacja)" = "$1" ] || fail "NIE_TA_OPERACJA: w toku $(stan_pole operacja)"
  pid=$(stan_pole pid)
  # Żywy proces aktualizatora tej operacji = deploy nadal pracuje; druga ręka nie wchodzi.
  if [ -n "$pid" ] && [ "$pid" != "$$" ] && kill -0 "$pid" 2>/dev/null \
    && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q aktualizuj; then
    fail "OPERACJA_W_TOKU_PROCES $pid — poczekaj na koniec deploy"
  fi
}

# --- accept ------------------------------------------------------------------------------------

accept() {
  OP=$1
  wymagaj_roota
  valid_op "$OP" || fail 'NIEPRAWIDLOWA_OPERACJA'
  wymagaj_operacji "$OP"
  [ -s "$STAN" ] || fail 'BLOKADA_BEZ_STANU — recover nieznana'
  etap=$(stan_pole etap)
  case "$etap" in czeka_na_akceptacje|akceptowanie) ;; *) fail "NIEPRAWIDLOWY_ETAP: $etap (accept tylko po NEEDS_ACCEPT)" ;; esac
  CEL_WYD=$(stan_pole cel_wydanie); CEL_COMMIT=$(stan_pole cel_commit); CEL_OBRAZ=$(stan_pole cel_obraz)
  BAZA_WYD=$(stan_pole baza_wydanie)
  if [ "$etap" = czeka_na_akceptacje ]; then
    czekaj_na_oms "$CEL_COMMIT" "$CEL_OBRAZ" || fail 'KANDYDAT_NIEZDROWY — accept odmówiony; dalej: recover'
    [ "$(obraz_kontenera oms-kopia)" = "$CEL_OBRAZ" ] || fail 'KONTENER_KOPII_NA_INNYM_OBRAZIE'
    stan_ustaw pid "$$"
    stan_ustaw etap akceptowanie
  fi
  ustaw_wskaznik "$CEL_WYD"
  historia "$OP ACCEPT $BAZA_WYD -> $CEL_WYD obraz=$CEL_OBRAZ"
  retencja "$CEL_WYD"
  zdejmij_blokade
  echo "ACCEPTED operacja=$OP wydanie=$CEL_WYD obraz=$CEL_OBRAZ"
}

# Zostają: bieżące + 2 poprzednie wydania (z historii akceptacji), 2 ostatnie kopie operacji.
retencja() {
  zostaw="$1 $(grep ' ACCEPT ' "$HISTORIA" 2>/dev/null | awk '{print $4}' | tac 2>/dev/null | awk '!s[$0]++' | head -n 2 | tr '\n' ' ')"
  for d in "$RELEASES"/oms-*; do
    [ -d "$d" ] || continue
    n=$(basename "$d")
    case " $zostaw " in *" $n "*) continue ;; esac
    c=$(commit_wydania "$n")
    rm -rf "$d"
    if valid_sha "$c" 40; then "$DOCKER" image rm "oms:$c" >/dev/null 2>&1 || true; fi
    echo "RETENCJA usunięto wydanie $n"
  done
  if [ -d "$OPERACJE" ]; then
    ls -1 "$OPERACJE" | sort -r | tail -n +3 | while IFS= read -r stara; do
      if ls -d "$OPERACJE/$stara"/po-kandydacie-* >/dev/null 2>&1; then echo "RETENCJA zostawiam $stara (odłożona baza kandydata — usuń ręcznie, gdy niepotrzebna)"; continue; fi
      valid_op "$stara" && rm -rf "${OPERACJE:?}/$stara" && echo "RETENCJA usunięto kopię operacji $stara"
    done
  fi
  # Cache budowania: zostaje tylko z ostatniego tygodnia (ostatni build przyspiesza następny),
  # starsze warstwy i obrazy bez tagu znikają.
  "$DOCKER" builder prune -f --filter until=168h >/dev/null 2>&1 || true
  "$DOCKER" image prune -f >/dev/null 2>&1 || true
}

# --- recover -----------------------------------------------------------------------------------

recover() {
  OP=$1; PRZYWROC=${2:-}
  wymagaj_roota
  [ -z "$PRZYWROC" ] || [ "$PRZYWROC" = --przywroc-baze ] || [ "$PRZYWROC" = --porzuc-prace ] || fail 'Uzycie: recover <operacja> [--przywroc-baze | --porzuc-prace] (porzuc-prace: tylko po przejsciu na prace, odklada baze pracy)'
  if [ -d "$BLOKADA" ] && [ ! -s "$STAN" ]; then
    # Przerwanie w chwili zakładania blokady: nic jeszcze nie zmieniono.
    [ "$OP" = nieznana ] || fail 'BLOKADA_BEZ_STANU — użyj: recover nieznana'
    rm -f "$STAN" "$BLOKADA"/stan.tmp.*; rmdir "$BLOKADA"; historia "nieznana RECOVER blokada bez stanu zdjęta"; echo 'RECOVERED blokada bez stanu zdjęta'; return 0
  fi
  valid_op "$OP" || fail 'NIEPRAWIDLOWA_OPERACJA'
  wymagaj_operacji "$OP"
  etap=$(stan_pole etap)
  BAZA_WYD=$(stan_pole baza_wydanie); BAZA_COMMIT=$(stan_pole baza_commit); BAZA_OBRAZ=$(stan_pole baza_obraz)
  if [ "$(stan_pole typ)" = produkcja ]; then
    [ "$PRZYWROC" != --przywroc-baze ] || fail 'PRZYWROC_BAZE_NIE_DOTYCZY_PRZEJSCIA — recover przejścia zawsze wraca do bazy próby z archiwum'
    recover_produkcja; return 0
  fi
  [ "$PRZYWROC" != --porzuc-prace ] || fail 'PORZUC_PRACE_DOTYCZY_TYLKO_PRZEJSCIA (aktualizuj.sh produkcja)'
  CEL_WYD=$(stan_pole cel_wydanie)
  OPDIR=$(stan_pole kopia)
  if [ "$etap" = akceptowanie ] && [ "$(cat "$WSKAZNIK" 2>/dev/null)" = "$CEL_WYD" ]; then
    fail "AKCEPTACJA_JUZ_ZAPISANA — bieżące jest $CEL_WYD; dokończ: sudo sh $SKRYPT accept $OP"
  fi
  [ -n "$(id_obrazu "$BAZA_OBRAZ")" ] || fail "BRAK_OBRAZU_POPRZEDNIEGO_WYDANIA $BAZA_OBRAZ"
  stan_ustaw pid "$$"
  [ "$etap" = przywracanie ] || stan_ustaw etap_przed "$etap"
  przed=$(stan_pole etap_przed)
  stan_ustaw etap przywracanie
  rm -rf "$RELEASES/.tmp-$OP"

  case "$przed" in
    zablokowane|rozpakowane|zbudowane)
      # Stary OMS nie był zatrzymywany; po restarcie maszyny wstał sam (restart: unless-stopped).
      if dziala oms && [ "$(obraz_kontenera oms)" = "$BAZA_OBRAZ" ] && czekaj_na_oms "$BAZA_COMMIT" "$BAZA_OBRAZ"; then :
      else uruchom_wydanie "$BAZA_WYD" "$BAZA_COMMIT" "$BAZA_OBRAZ" || fail "POWROT_NIEUDANY — blokada zostaje, ponów recover $OP"; fi ;;
    *)
      zatrzymaj_oms || fail 'NIE_ZATRZYMANO_KANDYDATA'
      if [ -n "$OPDIR" ] && [ -f "$OPDIR/migracje.json" ] && [ -f "$OMS/data/oms.sqlite" ]; then
        roznica=$("$DOCKER" run --rm --network none --user "$UID_OMS:$UID_OMS" -v "$OMS/data:/opt/oms/data" \
          -v "$OPDIR/migracje.json:/kopia/migracje.json:ro" \
          -v "$RELEASES/$CEL_WYD/deploy/klient/kopia.mjs:/narzedzie/kopia.mjs:ro" \
          --entrypoint node "$BAZA_OBRAZ" /narzedzie/kopia.mjs migracje /opt/oms/data/oms.sqlite --wzgledem /kopia/migracje.json 2>/dev/null || true)
        case "$roznica" in
          '{"nowe":[],"brakujace":[]}') echo "MIGRACJE bez zmian względem kopii operacji — schemat zgodny, baza zostaje" ;;
          '') echo "MIGRACJE nie udało się porównać listy migracji z kopią operacji" ;;
          *)
            echo "MIGRACJE kandydat zmienił listę migracji względem kopii operacji: $roznica"
            [ -n "$PRZYWROC" ] || echo "UWAGA: migracje od 0002 są addytywne — $BAZA_WYD startuje na bazie po migracjach i ich nie zna. Jeśli nie wstanie: recover $OP --przywroc-baze (gubi zapisy po kopii)." ;;
        esac
      fi
      if [ -n "$PRZYWROC" ]; then
        [ -n "$OPDIR" ] && [ -f "$OPDIR/oms.sqlite" ] || fail 'BRAK_KOPII_OPERACJI — przywrócenie bazy niemożliwe'
        (cd "$OPDIR" && sha256sum -c --quiet kopia.sha256 >/dev/null 2>&1) || fail 'KOPIA_OPERACJI_USZKODZONA (kopia.sha256)'
        if [ "$(stan_pole baza_przywrocona)" = 1 ]; then
          # Powtórka po nieudanym starcie: na miejscu jest już kopia operacji (plus to, co zapisało stare
          # wydanie); baza kandydata leży w $(stan_pole po_kandydacie) — drugie przeniesienie by ją nadpisało.
          echo "BAZA już przywrócona w tej operacji — pomijam (baza kandydata: $(stan_pole po_kandydacie))"
        else
          odlozona="$OPDIR/po-kandydacie-$(date -u +%Y%m%d-%H%M%S)"
          mkdir "$odlozona"
          echo "UWAGA: przywracam bazę z kopii operacji $OP — zapisy po $(stan_pole zatrzymane_czas) (zamówienia, nadania, faktury z okna odbioru) znikną z OMS. Obecna baza: $odlozona/"
          for s in "" -wal -shm; do
            if [ -f "$OMS/data/oms.sqlite$s" ]; then mv "$OMS/data/oms.sqlite$s" "$odlozona/oms.sqlite$s"; fi
          done
          stan_ustaw po_kandydacie "$odlozona"
          cp -p "$OPDIR/oms.sqlite" "$OMS/data/oms.sqlite.przywracana"
          chown "$UID_OMS:$UID_OMS" "$OMS/data/oms.sqlite.przywracana" 2>/dev/null || [ "$(id -u)" != 0 ]
          mv "$OMS/data/oms.sqlite.przywracana" "$OMS/data/oms.sqlite"
          stan_ustaw baza_przywrocona 1
          # Konfiguracji nie przywracamy: aktualizacja jej nie zmienia, a poprawka z okna odbioru by zniknęła.
          historia "$OP PRZYWROCONO_BAZE z $OPDIR (obecna w $odlozona)"
        fi
      fi
      uruchom_wydanie "$BAZA_WYD" "$BAZA_COMMIT" "$BAZA_OBRAZ" || fail "POWROT_NIEUDANY — blokada zostaje (etap przywracanie); sprawdź dziennik i ponów recover $OP" ;;
  esac
  ustaw_wskaznik "$BAZA_WYD"
  historia "$OP RECOVER etap=$przed -> $BAZA_WYD obraz=$BAZA_OBRAZ${PRZYWROC:+ z przywróceniem bazy}"
  zdejmij_blokade
  echo "RECOVERED operacja=$OP wydanie=$BAZA_WYD obraz=$BAZA_OBRAZ"
}

# --- produkcja: przejście z próby na pracę (PRZ-062) -------------------------------------------
# Decyzja: CZYSTA BAZA PRODUKCYJNA OBOK. Cały katalog danych próby (baza z zamówieniami DEMO, konto
# administratora próby), jej kopie, oms.env i dane konta przechodzą do /opt/oms/proba-archiwum/<op>/;
# produkcja startuje na pustym /opt/oms/data z NOWYM kontem administratora. Z próby nie przechodzi nic —
# usuwanie zamówień DEMO z żywej bazy zostawiłoby konto próby, jej kopie i numery w tej samej bazie.
# Etapy: zablokowane → zatrzymane → kopia → przelaczanie → uruchomione → konto → czeka_na_akceptacje.
# accept <op> kończy przejście; recover <op> (z każdego etapu, także po kill -9 i restarcie) wraca do próby.
# PRZ-093.08: adres firmy (DPD_NADAWCA_*) nie jest wymagany do startu — można go wpisać w panelu
# (Ustawienia → Firma). Wpis w pliku wygrywa nad panelem. Kurier z pliku (DPD_URL, INPOST_TOKEN) nadal
# wymaga adresu w pliku — tego pilnuje sam OMS przy starcie.
# PRZ-102.20: rachunek firmy (OMS_RACHUNEK) też nie jest wymagany — można go wpisać w panelu (Ustawienia → Firma,
# tylko administrator). Wpisany w pliku wygrywa nad panelem; zły numer w pliku zatrzymuje start OMS-u.
# PRZ-108.10: NIP (OMS_SPRZEDAWCA_NIP) i BDO też nie są wymagane — można je wpisać w panelu (Ustawienia → Firma, tylko
# administrator). Wpisany w pliku wygrywa nad panelem (każde pole osobno); zły NIP albo BDO w pliku zatrzymuje start.
# KSEF_TOKEN dopisany do pliku nadal wymaga NIP-u w pliku — tego pilnuje sam OMS przy starcie.
WYMAGANE_PRODUKCJI='OMS_USER OMS_PASS'

# Wartość tak, jak przeczyta ją compose z env_file: OSTATNIA linia NAZWA= (compose bierze ostatnią),
# bez CR i otaczających '…' / "…".
env_wartosc() {
  sed -n "s/^$2=//p" "$1" 2>/dev/null | tail -n 1 | tr -d '\r' | sed -e "s/^'\(.*\)'\$/\1/" -e 's/^"\(.*\)"$/\1/'
}

braki_produkcji() {
  [ "$(env_wartosc "$PRODUKCJA_ENV" OMS_TRYB)" = produkcja ] || echo 'OMS_TRYB(=produkcja)'
  for n in $WYMAGANE_PRODUKCJI; do [ -n "$(env_wartosc "$PRODUKCJA_ENV" "$n")" ] || echo "$n"; done
}

szablon_produkcji() {
  # Hasło konta serwisowego losowe (48 znaków hex, bez $): służy tylko aktualizatorowi do założenia
  # pierwszego administratora, potem nie loguje. Na ekran nie trafia.
  haslo=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  [ "${#haslo}" -eq 48 ] || fail 'BRAK_LOSOWOSCI (/dev/urandom)'
  (
    umask 077
    cat > "$PRODUKCJA_ENV.tmp.$$" <<EOF
# OMS — konfiguracja PRACY na prawdziwych danych firmy (docs/instalacja-docker.md, „Przejście na pracę”).
# Uzupełnij puste wartości, zapisz (w nano: Ctrl+O, Enter, Ctrl+X), potem: sudo sh $SKRYPT produkcja
# Ścieżek bazy, proform i etykiet NIE wpisuj — ustawia je compose (/opt/oms/data).
# Wartość ze znakiem \$ ujmij w apostrofy: NAZWA='wartość'.
OMS_TRYB=produkcja
# Konto serwisowe: aktualizator zakłada nim pierwszego administratora; potem przestaje logować.
OMS_USER=serwis
OMS_PASS=$haslo
# Sprzedawca na proformie: NIP (10 cyfr, bez kresek), BDO (9 cyfr) jeśli firma ma. Opcjonalnie: zostaw puste i wpisz
# NIP i BDO w panelu (Ustawienia → Firma, tylko administrator). Wpisane tutaj wygrywają nad panelem.
OMS_SPRZEDAWCA_NIP=
OMS_SPRZEDAWCA_BDO=
# Rachunek firmy (26 cyfr, bez PL i spacji): dane do przelewu w mailach i na proformie. Opcjonalnie: zostaw pusty
# i wpisz rachunek w panelu (Ustawienia → Firma, tylko administrator). Wpisany tutaj wygrywa nad panelem.
OMS_RACHUNEK=
# Adres firmy: sprzedawca na proformie i nadawca paczek (kod pocztowy w postaci 00-000). Opcjonalnie:
# zostaw puste i wpisz adres w panelu (Ustawienia → Firma). Wpisany tutaj wygrywa nad panelem.
DPD_NADAWCA_NAZWA=
DPD_NADAWCA_ULICA=
DPD_NADAWCA_KOD=
DPD_NADAWCA_MIASTO=
# Kanały sprzedaży i integracje dopisujesz PO przejściu, po jednej (instrukcja, „Integracje po kolei”).
OMS_KANALY=[]
OMS_RAPORTY_NAZWY_KANALOW={}
EOF
  ) || fail 'NIE_ZAPISANO_SZABLONU'
  mv "$PRODUKCJA_ENV.tmp.$$" "$PRODUKCJA_ENV"
}

# Czy jest do czego wrócić — sprawdzane ZANIM cokolwiek się zatrzyma albo zmieni etap (recenzja D8 r1:
# skasowane archiwum zostawiało OMS zatrzymany z blokadą). Próba jest w archiwum albo jeszcze na miejscu.
jest_proba_do_powrotu() {
  if [ ! -f "$1/config/oms.env" ] && [ "$(env_wartosc "$OMS/config/oms.env" OMS_TRYB)" != proba ]; then
    echo "POWROT_NIEMOZLIWY: brak konfiguracji próby w $1/config i na miejscu — OMS pracy nie był zatrzymywany; gdy etap to czeka_na_akceptacje: accept, inaczej diagnostyka do nas" >&2
    return 1
  fi
}

wycofaj_produkcje() {
  ARCH=$(stan_pole archiwum)
  [ -n "$ARCH" ] || return 1
  jest_proba_do_powrotu "$ARCH" || return 1
  zatrzymaj_oms || return 1
  # Stan z dysku, nie z etapu: każdy krok sprawdza, co już przesunięto (przerwanie w dowolnym miejscu).
  odl="$ARCH/produkcja-odlozona-$(date -u +%Y%m%d-%H%M%S)"
  if [ -d "$ARCH/data" ]; then
    # Katalog danych na miejscu powstał po przeniesieniu próby — to baza produkcji: odkładamy, nie kasujemy.
    if [ -d "$OMS/data" ]; then mkdir -p "$odl" && mv "$OMS/data" "$odl/data" || return 1; fi
    mv "$ARCH/data" "$OMS/data" || return 1
  fi
  # Znacznik = kopie próby już przeniesione, więc kopie w backups/ są produkcji. Bez niego (przerwanie
  # w trakcie przenoszenia) to resztki próby — zostają na miejscu. Znacznik znika PRZED powrotem kopii próby.
  if [ -f "$ARCH/backups/.przeniesione" ]; then
    for f in "$OMS/backups"/oms-*.sqlite "$OMS/backups"/pliki-*.tgz; do
      [ -e "$f" ] || continue
      mkdir -p "$odl/backups" && mv "$f" "$odl/backups/" || return 1
    done
    rm -f "$ARCH/backups/.przeniesione" || return 1
  fi
  for f in "$ARCH/backups"/oms-*.sqlite "$ARCH/backups"/pliki-*.tgz; do
    [ -e "$f" ] || continue
    mv "$f" "$OMS/backups/" || return 1
  done
  if [ -d "$ARCH/backups/operacje" ] && [ ! -d "$OMS/backups/operacje" ]; then mv "$ARCH/backups/operacje" "$OMS/backups/operacje" || return 1; fi
  if [ -f "$OMS/config/administrator.env" ]; then mkdir -p "$odl" && mv "$OMS/config/administrator.env" "$odl/administrator.env" || return 1; fi
  rm -f "$OMS/config/administrator.env.tmp"
  if [ -f "$ARCH/config/oms.env" ]; then
    if [ -f "$OMS/config/oms.env" ]; then
      # Konfiguracja pracy wraca jako produkcja.env (do poprawki i ponownego przejścia).
      if [ -f "$PRODUKCJA_ENV" ]; then mkdir -p "$odl" && mv "$OMS/config/oms.env" "$odl/oms.env" || return 1
      else mv "$OMS/config/oms.env" "$PRODUKCJA_ENV" || return 1; fi
    fi
    mv "$ARCH/config/oms.env" "$OMS/config/oms.env" || return 1
  fi
  for f in administrator-proby.env produkcja.env.example; do
    if [ -f "$ARCH/config/$f" ] && [ ! -f "$OMS/config/$f" ]; then mv "$ARCH/config/$f" "$OMS/config/$f" || return 1; fi
  done
  if [ ! -f "$PRODUKCJA_ENV" ] && [ -f "$ARCH/config/produkcja.env" ]; then cp -p "$ARCH/config/produkcja.env" "$PRODUKCJA_ENV" || return 1; fi
  [ "$(env_wartosc "$OMS/config/oms.env" OMS_TRYB)" = proba ] || { echo 'POWROT: oms.env nie jest konfiguracją próby' >&2; return 1; }
  uruchom_wydanie "$BAZA_WYD" "$BAZA_COMMIT" "$BAZA_OBRAZ" || return 1
}

po_bledzie_produkcji() {
  rc=$?
  trap - EXIT INT TERM HUP
  [ "$rc" -ne 0 ] || exit 0
  etap=$(stan_pole etap)
  if [ "$etap" = uruchomione ] || [ "$etap" = konto ]; then
    # Dziennik nieudanego startu (OMS podaje w nim nazwy zmiennych, nie wartości) — zanim powrót go skasuje.
    "$DOCKER" logs --tail 60 oms > "$ARCH/dziennik-nieudanej-produkcji.txt" 2>&1 || true
    echo "Błędy konfiguracji z dziennika OMS (pełny: $ARCH/dziennik-nieudanej-produkcji.txt):" >&2
    # Odmowa startu wypisuje „[moduł] ZMIENNA: powód” (bez wartości), potem stos wywołań — pokazujemy powody.
    # Próba 10.10 na VM: ostatnie 5 linii dziennika to był sam stos, bez nazwy zmiennej.
    if grep -qE '^\[[a-z0-9_-]+\] ' "$ARCH/dziennik-nieudanej-produkcji.txt"; then
      grep -E '^\[[a-z0-9_-]+\] ' "$ARCH/dziennik-nieudanej-produkcji.txt" | sort -u | head -n 10 >&2
    else
      tail -n 5 "$ARCH/dziennik-nieudanej-produkcji.txt" >&2 || true
    fi
  fi
  if [ "$etap" = zablokowane ]; then
    rm -rf "$ARCH"
    zdejmij_blokade
    historia "$OP PRZERWANE produkcja etap=$etap kod=$rc (próba nie była zatrzymana)"
    echo "PRZERWANE — próba nie była zatrzymana, blokada zdjęta" >&2
  elif wycofaj_produkcje; then
    ustaw_wskaznik "$BAZA_WYD"
    zdejmij_blokade
    historia "$OP WYCOFANE produkcja etap=$etap kod=$rc (wróciła próba)"
    echo "WYCOFANE na etapie $etap — wróciła próba (jej dane nietknięte), konfiguracja pracy czeka w $PRODUKCJA_ENV" >&2
  else
    stan_ustaw blad "przejście przerwane na etapie $etap, powrót próby nieudany"
    echo "BLAD: powrót próby nieudany — blokada zostaje. Dalej: sudo sh $SKRYPT recover $OP" >&2
  fi
  exit "$rc"
}

produkcja() {
  wymagaj_roota
  [ ! -d "$BLOKADA" ] || fail "ODMOWA_TRWA_OPERACJA $(stan_pole operacja) etap=$(stan_pole etap) — sudo sh $SKRYPT status"
  ENV_TERAZ="$OMS/config/oms.env"
  [ -f "$ENV_TERAZ" ] || fail "BRAK_KONFIGURACJI $ENV_TERAZ — najpierw instalacja (docs/instalacja-docker.md, krok 5)"
  [ "$(env_wartosc "$ENV_TERAZ" OMS_TRYB)" = proba ] || fail 'TO_NIE_JEST_PROBA: oms.env nie ma OMS_TRYB=proba — przejście już było'
  if [ ! -f "$PRODUKCJA_ENV" ]; then
    szablon_produkcji
    braki=$(braki_produkcji | tr '\n' ' ')
    # PRZ-108.10: szablon ma wszystkie pola wymagane do startu; dane firmy są opcjonalne w pliku (można w panelu).
    if [ -n "$braki" ]; then echo "UTWORZONO $PRODUKCJA_ENV — uzupełnij: ${braki% }"
    else echo "UTWORZONO $PRODUKCJA_ENV — dane firmy (NIP, BDO, rachunek, adres) wpisz tutaj albo po przejściu w panelu (Ustawienia → Firma)"; fi
    echo "Edycja: sudo nano $PRODUKCJA_ENV ; potem ponownie: sudo sh $SKRYPT produkcja"
    return 0
  fi
  braki=$(braki_produkcji | tr '\n' ' ')
  [ -z "$braki" ] || fail "PRODUKCJA_NIEWYPELNIONE_POLA: ${braki% } — uzupełnij w $PRODUKCJA_ENV"
  for n in OMS_PASS OMS_SPRZEDAWCA_NIP OMS_RACHUNEK; do
    # PRZ-102.20, PRZ-108.10: puste pole nie jest wartością z próby (pusty rachunek albo NIP = wpis w panelu; puste hasło
    # odrzuciły braki wyżej).
    [ -n "$(env_wartosc "$PRODUKCJA_ENV" "$n")" ] || continue
    [ "$(env_wartosc "$PRODUKCJA_ENV" "$n")" != "$(env_wartosc "$ENV_TERAZ" "$n")" ] || fail "PRODUKCJA_WARTOSC_Z_PROBY: $n — wpisz własną wartość, nie z próby"
  done
  ustal_baze
  # Działające wydanie musi umieć przejście (PRZ-062+); inaczej przerwa i samoczynny powrót dopiero na etapie konta.
  dziala oms || fail "OMS_NIE_DZIALA — uruchom próbę: sudo sh $SKRYPT compose up -d, potem ponów"
  "$DOCKER" exec oms test -f scripts/produkcja-pierwszy-start.mjs \
    || fail "WYDANIE_BEZ_PRZEJSCIA: $BAZA_WYD nie ma scripts/produkcja-pierwszy-start.mjs — najpierw aktualizacja do wydania z PRZ-062 (docs/aktualizacja-klienta-v0.md)"
  ostrzez_dolar
  dane_mb=$(( $(du -sk "$OMS/data" 2>/dev/null | cut -f 1 || echo 0) / 1024 + 1 ))
  wolne=$(wolne_mb "$OMS")
  [ -n "$wolne" ] && [ "$wolne" -ge $(( dane_mb + REZERWA_MB )) ] || fail "BRAK_MIEJSCA_OMS: $OMS wolne ${wolne:-?} MB, potrzeba $(( dane_mb + REZERWA_MB )) MB"

  mkdir -p "$STAN_DIR"; chmod 700 "$STAN_DIR"
  mkdir "$BLOKADA" 2>/dev/null || fail 'ODMOWA_TRWA_OPERACJA (blokada założona równolegle)'
  OP=$(date -u +%Y%m%d-%H%M%S)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')
  ARCH="$ARCHIWA/$OP"
  {
    printf 'operacja=%s\ntyp=produkcja\netap=zablokowane\npid=%s\nstart=%s\narchiwum=%s\n' "$OP" "$$" "$(teraz)" "$ARCH"
    printf 'baza_wydanie=%s\nbaza_commit=%s\nbaza_obraz=%s\n' "$BAZA_WYD" "$BAZA_COMMIT" "$BAZA_OBRAZ"
    # Przejście nie zmienia kodu: „cel” = bieżące wydanie (accept sprawdza ten sam obraz i commit).
    printf 'cel_wydanie=%s\ncel_commit=%s\ncel_obraz=%s\n' "$BAZA_WYD" "$BAZA_COMMIT" "$BAZA_OBRAZ"
  } > "$BLOKADA/stan.tmp.$$"
  mv "$BLOKADA/stan.tmp.$$" "$STAN"
  sync "$STAN" "$BLOKADA" 2>/dev/null || true
  trap po_bledzie_produkcji EXIT
  trap 'exit 130' INT TERM HUP
  historia "$OP PRODUKCJA start wydanie=$BAZA_WYD archiwum=$ARCH"
  if [ "$BAZA_ZRODLO" = adopcja ]; then ustaw_wskaznik "$BAZA_WYD"; historia "$OP ADOPCJA wskaźnik=$BAZA_WYD"; fi
  echo "ZABLOKOWANE operacja=$OP (przejście na pracę) wydanie=$BAZA_WYD"
  mkdir -p "$ARCHIWA"; chmod 700 "$ARCHIWA"
  mkdir "$ARCH" "$ARCH/config" "$ARCH/backups" "$ARCH/kopia"; chmod 700 "$ARCH"
  chown "$UID_OMS:$UID_OMS" "$ARCH/kopia" 2>/dev/null || [ "$(id -u)" != 0 ]

  stan_ustaw etap zatrzymane
  zatrzymaj_oms || fail 'NIE_ZATRZYMANO_OMS'
  echo "ZATRZYMANE próba"
  # Kopia próby z kontrolą spójności (tym samym narzędziem i obrazem co kopia operacji aktualizacji).
  "$DOCKER" run --rm --network none --user "$UID_OMS:$UID_OMS" \
    -v "$OMS/data:/opt/oms/data" -v "$ARCH/kopia:/kopia" \
    -v "$RELEASES/$BAZA_WYD/deploy/klient/kopia.mjs:/narzedzie/kopia.mjs:ro" \
    --entrypoint node "$BAZA_OBRAZ" /narzedzie/kopia.mjs operacja /opt/oms/data/oms.sqlite /kopia > "$ARCH/kopia/wynik.json" \
    || fail 'KOPIA_PROBY_NIEUDANA'
  grep -q '"integralnosc":"ok"' "$ARCH/kopia/wynik.json" || fail 'KOPIA_PROBY_NIESPOJNA'
  stan_ustaw etap kopia
  echo "KOPIA próby $ARCH/kopia $(cat "$ARCH/kopia/wynik.json")"

  stan_ustaw etap przelaczanie
  mv "$OMS/data" "$ARCH/data"
  mkdir "$OMS/data" "$OMS/data/proformy" "$OMS/data/etykiety"
  chmod 700 "$OMS/data"
  chown -R "$UID_OMS:$UID_OMS" "$OMS/data" 2>/dev/null || [ "$(id -u)" != 0 ]
  for f in "$OMS/backups"/oms-*.sqlite "$OMS/backups"/pliki-*.tgz; do
    if [ -e "$f" ]; then mv "$f" "$ARCH/backups/"; fi
  done
  if [ -d "$OPERACJE" ]; then mv "$OPERACJE" "$ARCH/backups/operacje"; fi
  : > "$ARCH/backups/.przeniesione"
  for f in oms.env administrator-proby.env produkcja.env.example; do
    if [ -f "$OMS/config/$f" ]; then mv "$OMS/config/$f" "$ARCH/config/$f"; fi
  done
  cp -p "$PRODUKCJA_ENV" "$ARCH/config/produkcja.env"
  mv "$PRODUKCJA_ENV" "$OMS/config/oms.env"
  chmod 600 "$OMS/config/oms.env"
  echo "PRZELACZONE dane próby → $ARCH; konfiguracja pracy → $OMS/config/oms.env"

  stan_ustaw etap uruchomione
  uruchom_wydanie "$BAZA_WYD" "$BAZA_COMMIT" "$BAZA_OBRAZ" || fail 'PRODUKCJA_NIE_WSTALA — OMS odrzucił konfigurację pracy albo nie odpowiada'
  stan_ustaw etap konto
  ( umask 077; "$DOCKER" exec oms node scripts/produkcja-pierwszy-start.mjs > "$OMS/config/administrator.env.tmp" ) \
    || fail 'PRODUKCJA_PIERWSZY_START_NIEUDANY (konto administratora, granice raportu)'
  grep -q '^haslo=.\{16,\}$' "$OMS/config/administrator.env.tmp" || fail 'PRODUKCJA_PIERWSZY_START_BEZ_KONTA'
  mv "$OMS/config/administrator.env.tmp" "$OMS/config/administrator.env"
  if compose_w "$BAZA_WYD" exec -T kopia node deploy/klient/kopia.mjs teraz > "$ARCH/pierwsza-kopia-produkcji.json" 2>&1; then
    echo "KOPIA produkcji $(head -c 300 "$ARCH/pierwsza-kopia-produkcji.json")"
  else
    echo "UWAGA: pierwsza kopia produkcji nieudana ($ARCH/pierwsza-kopia-produkcji.json) — kontener kopii spróbuje w ciągu godziny" >&2
  fi
  stan_ustaw etap czeka_na_akceptacje
  trap - EXIT INT TERM HUP
  historia "$OP NEEDS_ACCEPT produkcja wydanie=$BAZA_WYD archiwum=$ARCH"
  # Po pierwszej kopii, nie sprzed niej: wcześniejszy odczyt liczy alarm „brak kopii” (próba na VM 10.10).
  echo "zdrowie: $(zdrowie)"
  echo "NEEDS_ACCEPT operacja=$OP — OMS pracuje na pustej bazie produkcyjnej; próba w $ARCH"
  echo "Konto administratora: sudo cat $OMS/config/administrator.env"
  echo "Odbiór: docs/instalacja-docker.md, „Przejście na pracę”. Potem: sudo sh $SKRYPT accept $OP  albo powrót do próby: sudo sh $SKRYPT recover $OP"
}

recover_produkcja() {
  [ -n "$(id_obrazu "$BAZA_OBRAZ")" ] || fail "BRAK_OBRAZU_WYDANIA $BAZA_OBRAZ"
  [ "$etap" != akceptowanie ] || fail "AKCEPTACJA_W_TOKU — dokończ: sudo sh $SKRYPT accept $OP"
  jest_proba_do_powrotu "$(stan_pole archiwum)" || exit 1
  # Praca z prawdziwymi zamówieniami (okno odbioru trwało, integracje dopisane) — powrót odkłada ją do archiwum,
  # a ponowne przejście zaczyna od pustej bazy. Tylko jawnie (recenzja D8 r1).
  if [ "$PRZYWROC" != --porzuc-prace ] && [ -d "$(stan_pole archiwum)/data" ] && [ -f "$OMS/data/oms.sqlite" ]; then
    # Bez :ro na wolumenie — baza jest w trybie WAL: przy zatrzymanym OMS (brak -wal/-shm) SQLite musi je założyć,
    # na montowaniu tylko do odczytu otwarcie pada (zmierzone na VM 11.10, recenzja D8 r2). Odczyt i tak readOnly.
    ile=$("$DOCKER" run --rm --network none --user "$UID_OMS:$UID_OMS" -v "$OMS/data:/opt/oms/data" --entrypoint node "$BAZA_OBRAZ" \
      -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true,timeout:10000});console.log(d.prepare('SELECT COUNT(*) AS n FROM zamowienia').get().n)" \
      /opt/oms/data/oms.sqlite 2>/dev/null || echo '?')
    dalej=''
    [ "$etap" != czeka_na_akceptacje ] || dalej="; inaczej: accept $OP"
    case "$ile" in
      0) ;;
      *[!0-9]*|'') fail "PRACA_NIE_POLICZONO_ZAMOWIEN — nie udało się odczytać bazy pracy. Powrót do próby odłoży ją do $(stan_pole archiwum)/produkcja-odlozona-*. Świadomie: sudo sh $SKRYPT recover $OP --porzuc-prace$dalej" ;;
      *) fail "PRACA_MA_ZAMOWIENIA ($ile) — powrót do próby odłoży bazę pracy do $(stan_pole archiwum)/produkcja-odlozona-*, ponowne przejście zacznie od pustej. Świadomie: sudo sh $SKRYPT recover $OP --porzuc-prace$dalej" ;;
    esac
  fi
  stan_ustaw pid "$$"
  [ "$etap" = przywracanie ] || stan_ustaw etap_przed "$etap"
  stan_ustaw etap przywracanie
  wycofaj_produkcje || fail "POWROT_PROBY_NIEUDANY — blokada zostaje; sprawdź dziennik i ponów: sudo sh $SKRYPT recover $OP"
  ustaw_wskaznik "$BAZA_WYD"
  historia "$OP RECOVER produkcja etap=$(stan_pole etap_przed) -> próba $BAZA_WYD"
  zdejmij_blokade
  echo "RECOVERED operacja=$OP — wróciła próba (wydanie $BAZA_WYD); konfiguracja pracy w $PRODUKCJA_ENV"
}

zdrowie_pelne() {
  wymagaj_roota
  dziala oms || fail 'OMS_NIE_DZIALA — sudo sh '"$SKRYPT"' status'
  "$DOCKER" exec oms node -e "fetch('http://127.0.0.1:3001/health').then(async r=>{const t=await r.text();let j;try{j=JSON.parse(t)}catch{console.log('HTTP '+r.status+' '+t.slice(0,500));return}console.log('HTTP '+r.status);console.log(JSON.stringify(j,null,1))}).catch(e=>{console.error('HTTP_BLAD '+e.message);process.exit(1)})"
}

# --- status ------------------------------------------------------------------------------------

status() {
  echo "czas: $(teraz)"
  if [ -f "$WSKAZNIK" ]; then echo "biezace: $(cat "$WSKAZNIK") (commit $(commit_wydania "$(cat "$WSKAZNIK")"))"
  else echo "biezace: brak wskaźnika — instalacja sprzed aktualizatora; pierwszy deploy ustali je z działającego kontenera"; fi
  for k in oms oms-kopia; do
    o=$(obraz_kontenera "$k")
    if [ -z "$o" ]; then echo "kontener $k: brak"; continue; fi
    s=$("$DOCKER" inspect --format '{{.State.Status}}' "$k" 2>/dev/null || echo ?)
    echo "kontener $k: $s obraz=$o revision=$(rewizja_obrazu "$o")"
  done
  if dziala oms; then echo "zdrowie: $(zdrowie)"; else echo "zdrowie: OMS nie działa"; fi
  if [ -f "$WSKAZNIK" ] && [ -f "$RELEASES/$(cat "$WSKAZNIK")/.obraz" ] && [ -n "$(obraz_kontenera oms)" ] \
    && [ "$(cat "$RELEASES/$(cat "$WSKAZNIK")/.obraz")" != "$(obraz_kontenera oms)" ] && [ ! -d "$BLOKADA" ]; then
    echo "UWAGA: działa inny obraz niż bieżące wydanie — ktoś uruchomił compose ze starego katalogu? Użyj: sudo sh $SKRYPT compose up -d"
  fi
  if [ ! -d "$BLOKADA" ]; then echo 'blokada: brak'
  elif [ ! -s "$STAN" ]; then echo "blokada: BEZ STANU (przerwanie w chwili zakładania, nic nie zmieniono) — dalej: sudo sh $SKRYPT recover nieznana"
  else
    echo 'blokada: TAK'
    sed -e 's/^/  /' "$STAN"
    pid=$(stan_pole pid); op=$(stan_pole operacja)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q aktualizuj; then
      echo "  proces $pid aktualizatora DZIAŁA — operacja w toku, poczekaj"
    else
      echo "  proces aktualizatora nie działa (zakończony, przerwany albo restart maszyny) — nic nie wznowi się samo"
      if [ "$(stan_pole typ)" = produkcja ]; then
        case "$(stan_pole etap)" in
          czeka_na_akceptacje) echo "  dalej: odbiór pracy, potem accept $op albo powrót do próby: recover $op" ;;
          akceptowanie) echo "  dalej: accept $op (dokończenie)" ;;
          *) echo "  dalej: recover $op (powrót do próby; jej dane w $(stan_pole archiwum))" ;;
        esac
      else
      case "$(stan_pole etap)" in
        zablokowane|rozpakowane|zbudowane) echo "  dalej: recover $op (stare wydanie nie było zatrzymywane)" ;;
        zatrzymane|kopia) echo "  dalej: recover $op (OMS ZATRZYMANY przez aktualizację, kandydat nie startował, baza nietknięta)" ;;
        uruchomione) echo "  dalej: recover $op (kandydat wystartował, kontrola nieukończona)" ;;
        czeka_na_akceptacje) echo "  dalej: odbiór, potem accept $op albo recover $op" ;;
        akceptowanie) echo "  dalej: accept $op (dokończenie)" ;;
        przywracanie) echo "  dalej: recover $op (ponowienie powrotu)" ;;
      esac
      fi
    fi
  fi
  echo "wydania: $(ls -1 "$RELEASES" 2>/dev/null | grep '^oms-' | tr '\n' ' ')"
  echo "kopie operacji: $(ls -1 "$OPERACJE" 2>/dev/null | tr '\n' ' ')"
  ostrzez_dolar 2>&1 || true
}

compose_biezace() {
  wymagaj_roota
  if [ -s "$WSKAZNIK" ]; then w=$(cat "$WSKAZNIK")
  elif [ -n "$(obraz_kontenera oms)" ]; then ustal_baze; w=$BAZA_WYD
  else
    # Instalacja sprzed aktualizatora po `compose down`: bez wskaźnika i kontenera — tylko gdy wydanie jest jedno.
    w=$(ls -1 "$RELEASES" 2>/dev/null | grep '^oms-' || true)
    [ "$(printf '%s\n' "$w" | grep -c .)" -eq 1 ] || fail "BRAK_WSKAZNIKA_I_KONTENERA — wydania: $(printf '%s ' $w); wpisz bieżące: echo oms-XXXXXXXXXXXX | sudo tee $WSKAZNIK"
  fi
  [ ! -d "$BLOKADA" ] || echo "UWAGA: trwa operacja $(stan_pole operacja) etap=$(stan_pole etap)" >&2
  compose_w "$w" "$@"
}

case "${1:-}" in
  status) [ "$#" -eq 1 ] || fail 'Uzycie: aktualizuj.sh status'; status ;;
  deploy) [ "$#" -eq 3 ] || fail 'Uzycie: aktualizuj.sh deploy <paczka.tar.gz> <sha256>'; deploy "$2" "$3" ;;
  accept) [ "$#" -eq 2 ] || fail 'Uzycie: aktualizuj.sh accept <operacja>'; accept "$2" ;;
  recover) [ "$#" -ge 2 ] && [ "$#" -le 3 ] || fail 'Uzycie: aktualizuj.sh recover <operacja> [--przywroc-baze | --porzuc-prace] (porzuc-prace: tylko po przejsciu na prace, odklada baze pracy)'; recover "$2" "${3:-}" ;;
  compose) shift; compose_biezace "$@" ;;
  produkcja) [ "$#" -eq 1 ] || fail 'Uzycie: aktualizuj.sh produkcja'; produkcja ;;
  zdrowie) [ "$#" -eq 1 ] || fail 'Uzycie: aktualizuj.sh zdrowie'; zdrowie_pelne ;;
  *) fail 'Uzycie: aktualizuj.sh status|deploy|accept|recover|compose|produkcja|zdrowie' ;;
esac
