# Publiczne zdjęcia
Osobny proces udostępnia wyłącznie GET/HEAD `/z/<sha256>.jpg` (także png i webp).
Panel OMS-u NIE jest wystawiany; obraz nie zawiera jego kodu ani bazy.
W OMS ustaw `OMS_PUBLICZNY_ADRES_ZDJEC=https://zdjecia.przyklad.pl` (bez `/z`).
Na hoście ustaw `OMS_KATALOG_ZDJEC` na istniejący katalog zdjęć OMS-u, obok bazy.
Z katalogu repo buduj/uruchamiaj przez `docker compose -f deploy/zdjecia/compose.yaml up -d --build`.
UID 1000 musi mieć prawo odczytu zdjęć i przejścia przez katalog; wolumen jest tylko do odczytu.
Proces używa `OMS_ZDJECIA_PORT` (domyślnie 3002) i `OMS_KATALOG_ZDJEC` (domyślnie `./zdjecia`).
Compose udostępnia port 3002 tylko lokalnemu proxy; nie montuj katalogu bazy.
W sieci domowej wzór `tunel.yml` dopuszcza wyłącznie `/z/*`, reszta daje 404.
Tunel wymaga osobnego skonfigurowania i dostępu do sieci kontenera `zdjecia`.
Instalacja z publicznym adresem wymaga tylko reguły `/z/*` w swoim proxy i powyższej zmiennej w OMS.
