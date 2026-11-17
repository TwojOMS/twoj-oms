# Instalacja OMS w Dockerze na Linuksie

Od czystego Debiana do zalogowania w panelu z innego komputera. Każde polecenie wklejasz w terminalu
serwera (bash), po kolei. Pierwsze uruchomienie to próba z trzema wymyślonymi zamówieniami —
**bez żadnych kluczy Allegro, sklepu, kurierów ani inFaktu**. Integracje dodaje się później.

Sprawdzone na Debianie 13 (amd64), 2 rdzenie, 4 GB RAM, dysk 16 GB; przejście sekcji 1–7 od czystego
systemu zajęło ok. 2 minut samych poleceń (pomiar 16.10.2026). Wymagany internet na czas
instalacji (repozytorium Dockera, obraz Node, paczki npm) i konto z `sudo`.

Potrzebujesz dwóch plików: `oms-XXXXXXXXXXXX.tar.gz` i `oms-XXXXXXXXXXXX.tar.gz.sha256`. Powstają z
klona repozytorium, na dowolnym komputerze z Git i Node 24 (katalog wyjściowy musi być nowy, ścieżka bezwzględna).
Polecenia działają w bashu i w PowerShellu na Windowsie:

```bash
git clone https://github.com/TwojOMS/twoj-oms.git twoj-oms
cd twoj-oms
node scripts/paczka-klienta.mjs --commit "$(git rev-parse HEAD)" --wyjscie /tmp/oms-paczka
```

Ostatnie polecenie wypisuje pełną ścieżkę archiwum (na Windowsie `/tmp/oms-paczka` to `C:\tmp\oms-paczka`).
Node nie jest potrzebny na serwerze — tylko na komputerze, na którym budujesz paczkę. Paczka zawiera kod dokładnie z tego commita (bez niezatwierdzonych zmian), więc własne zmiany najpierw
zatwierdź w Git. Skopiuj oba pliki z katalogu wyjściowego do katalogu domowego na serwerze, np. z innego komputera (pełne nazwy plików —
PowerShell nie rozwija `*`): `scp oms-XXXXXXXXXXXX.tar.gz oms-XXXXXXXXXXXX.tar.gz.sha256 uzytkownik@adres-serwera:`
(na serwerze musi działać SSH — pakiet `openssh-server`; można też przenieść pliki pendrive'em).
W katalogu domowym ma być tylko jedna paczka.

Jeśli `sudo true` odpowiada „is not in the sudoers file” albo „command not found” (Debian
instalowany z hasłem roota), wykonaj raz `su - -c "apt-get install -y sudo && usermod -aG sudo $USER"`,
podaj hasło roota, wyloguj się i zaloguj ponownie.

**Przed każdym blokiem poleceń** wpisz osobno `sudo -v` i podaj hasło. Inaczej pytanie o hasło
w środku wklejonego bloku „zje” następną linię bloku jako hasło.

## 1. Docker

Z oficjalnego repozytorium Dockera, nie pakiet `docker.io` z Debiana: Debian 13 ma w nim Dockera
26.1 i osobny, starszy `docker-compose`, a instrukcja korzysta z wtyczki `docker compose`
w bieżącej wersji (pole `required` w `env_file`) i z `buildx`.

Na świeżym serwerze w chmurze system przez pierwsze minuty sam się aktualizuje i `apt-get` odpowiada wtedy
„Could not get lock”. Najpierw poczekaj, aż skończy: `sudo cloud-init status --wait` (bez `cloud-init` — na
serwerze postawionym z płyty — polecenie nie istnieje i ten krok pomijasz).

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo docker compose version
```

Ostatnie polecenie wypisuje wersję Compose. Docker uruchamia się sam przy starcie systemu.

## 2. Katalogi

Kod, konfiguracja, dane i kopie leżą osobno. OMS w kontenerze pracuje jako użytkownik o numerze
10001 — on musi być właścicielem katalogów konfiguracji, danych i kopii.

```bash
sudo install -d -m 0755 /opt/oms /opt/oms/releases /opt/oms/kopia-zewnetrzna
sudo install -d -m 0700 -o 10001 -g 10001 /opt/oms/config /opt/oms/data /opt/oms/backups
```

`/opt/oms/kopia-zewnetrzna` to miejsce na pendrive albo dysk USB z kopią poza serwerem — opis
w sekcji „Kopia poza dyskiem” na końcu.

W `/opt/oms/config` instalacja założy też plik `klucz.env` — klucz, którym OMS szyfruje w bazie hasła
i tokeny integracji. Należy do użytkownika 10001 i ma tryb 600, tak jak `oms.env`. Nigdy nie leży
w `/opt/oms/data` i nie trafia do żadnej kopii. Opis: rozdział „Klucz poświadczeń” na końcu.

## 3. Paczka

```bash
cd ~
sha256sum -c oms-*.tar.gz.sha256
WYDANIE=$(basename oms-*.tar.gz .tar.gz)
sudo tar -xzf "$WYDANIE.tar.gz" -C /opt/oms/releases
sudo install -m 0755 "/opt/oms/releases/$WYDANIE/deploy/klient/aktualizuj.sh" /opt/oms/aktualizuj.sh
sudo install -d -m 0700 /opt/oms/update-state
echo "$WYDANIE" | sudo tee /opt/oms/update-state/biezace > /dev/null
cd "/opt/oms/releases/$WYDANIE/deploy/klient"
```

`sha256sum` musi wypisać `OK`. Jeśli wypisze `FAILED`, plik jest uszkodzony — pobierz go ponownie.
Kolejne polecenia wykonujesz w tym katalogu (`deploy/klient` rozpakowanej paczki).
Po instalacji pliki paczki z katalogu domowego można usunąć (`rm ~/oms-*.tar.gz ~/oms-*.tar.gz.sha256`) —
wydanie leży już w `/opt/oms/releases`, a aktualizacja używa nowej paczki pod pełną nazwą.

## 4. Obraz

```bash
sudo docker compose build
```

Trwa od minuty do kilku minut, zależnie od łącza: pobiera obraz Node 24 i zależności npm. Obraz powstaje lokalnie, z tej paczki,
i ma wpisaną wersję (`org.opencontainers.image.revision`).

## 5. Pierwsze uruchomienie: próba i demo

```bash
sudo docker compose run --rm instalacja
```

Kończy się wierszem z `"status":"instalacja-zakonczona"`. Polecenie, bez dostępu do sieci,
uruchamia OMS na pustej bazie, zakłada konto administratora, sprawdza restart, kopię i jej
odtworzenie oraz dodaje trzy zmyślone zamówienia DEMO-001…003. Konfigurację zapisuje
w `/opt/oms/config/oms.env`, dane konta w `/opt/oms/config/administrator-proby.env`.
Opis zmiennych, ich wymagalności i odpowiedników w panelu znajdziesz w [tabeli zmiennych](zmienne.md) (`docs/zmienne.md`).
Drugi raz odmówi (`INSTALACJA_ODMOWA_NADPISANIA`) — nie nadpisuje istniejących danych.

Klucz poświadczeń powstaje sam, w `/opt/oms/config/klucz.env`. Przed wierszem `"status"` wynik
pokazuje jego id (8 znaków) i polecenie `sudo cat /opt/oms/config/klucz.env`. Wyświetl plik i zapisz
jego zawartość w menedżerze haseł, razem z id i datą. Bez klucza kopia bazy nie odda podłączonych
integracji (rozdział „Klucz poświadczeń”).

Jeśli polecenie skończy się innym błędem `INSTALACJA_…`, zapisz go, wyczyść katalog danych (także
pliki ukryte), usuń trzy pliki instalatora z katalogu konfiguracji i powtórz krok 5:

```bash
sudo find /opt/oms/data -mindepth 1 -delete
sudo rm -f /opt/oms/config/oms.env /opt/oms/config/administrator-proby.env /opt/oms/config/produkcja.env.example
```

To kasuje tylko próbę — przy pierwszej instalacji nie ma tam innych danych. `klucz.env` zostaje:
przy powtórzeniu instalator go sprawdzi i użyje, nie nadpisze. Nie kasuj całego `/opt/oms/config` —
przy odtwarzaniu leży tam klucz przyniesiony z menedżera haseł. Jedyny wyjątek: błąd
`INSTALACJA_KLUCZ_ODMOWA` przy pierwszej instalacji (plik klucza pusty albo ucięty, np. po zaniku
prądu). Wtedy w bazie nie ma jeszcze nic zaszyfrowanego — usuń też `klucz.env`, a instalator założy nowy.

## 6. Start panelu

```bash
sudo docker compose up -d
sudo docker compose ps
```

Po około minucie kolumna STATUS przy `oms` pokazuje `(healthy)`. Panel i kopia zapasowa
uruchamiają się same po restarcie serwera.

## 7. Logowanie z innego komputera

```bash
hostname -I
sudo cat /opt/oms/config/administrator-proby.env
```

Pierwsze polecenie podaje adresy serwera — w sieci lokalnej to zwykle pierwszy, np. `192.168.…`
(`172.17.…`, `172.18.…` to wewnętrzne sieci Dockera). Drugie — login i hasło administratora.
Na innym komputerze w tej samej sieci otwórz w przeglądarce `http://ADRES-SERWERA:3001/login`
i zaloguj się. Zobaczysz trzy zamówienia DEMO. Zapisz hasło w menedżerze haseł.

Panel działa po zwykłym HTTP, bez szyfrowania. **Nie przekierowuj portu 3001 na routerze do
internetu.** Dostęp spoza biura przygotuj według [sekcji 7a](#7a-dostęp-spoza-biura-przez-https).

## 7a. Dostęp spoza biura przez HTTPS

Zrób ten krok po przejściu na pracę (sekcja 8), przed udostępnieniem panelu innym osobom.
Przejście na pracę zastępuje konfigurację próby — jeśli sprawdzasz HTTPS wcześniej, powtórz
ustawienie proxy i adresu panelu po przejściu. Zalecany wariant: **Caddy na tym samym serwerze**,
przed OMS-em w Dockerze. Caddy szyfruje połączenie z przeglądarką i sam uzyskuje oraz odnawia
certyfikat Let's Encrypt. Poniższe polecenia wykonujesz na Debianie 13, tak jak poprzednie kroki.

**1. Przygotuj domenę i dostęp do serwera.** W panelu DNS swojej domeny dodaj rekord A
`oms.przyklad.pl` wskazujący na publiczny adres IPv4 serwera (wszędzie niżej zastąp tę domenę
swoją). Rekord AAAA dodaj tylko przy działającym publicznym IPv6; błędny usuń. W zaporze
dostawcy serwera otwórz TCP 80 i 443; w biurze przekieruj na routerze wyłącznie te dwa porty
na serwer OMS i dopuść je w jego zaporze. Port 80 jest potrzebny także do uzyskania/odnowienia
certyfikatu i przekierowania HTTP na HTTPS. Za CGNAT bez własnego publicznego adresu wybierz
tunel opisany na końcu tej sekcji.

Compose publikuje `0.0.0.0:${OMS_PORT_LAN:-3001}:3001`, czyli HTTP na wszystkich adresach IPv4
hosta, a nie tylko na `127.0.0.1`. W kontenerze `OMS_PORT` jest ustawione na stałe na 3001;
zmiana `OMS_PORT` w `oms.env` nie zmieni tego mapowania. Poniżej używamy portu hosta 3001;
jeśli wcześniej zmieniłeś `OMS_PORT_LAN`, wpisz swój port w `reverse_proxy`.
**Port HTTP nie może być osiągalny z internetu:** na routerze nie przekierowuj 3001,
na VPS-ie zamknij go w zaporze dostawcy (także inne porty poza potrzebnymi, np. SSH).
Samo zablokowanie portu w UFW hosta może nie wystarczyć, bo Docker ma własne reguły.
Z komputera poza biurem sprawdź, że `curl --connect-timeout 5 http://PUBLICZNY-IP:3001/login`
nie łączy się z panelem. Jeśli pokazuje stronę, najpierw zamknij ten dostęp.

**2. Zainstaluj Caddy i zapisz konfigurację.** Przed blokiem wykonaj osobno `sudo -v`.

```bash
sudo apt-get update
sudo apt-get install -y caddy
sudo nano /etc/caddy/Caddyfile
```

Zastąp zawartość pliku (zapis Ctrl+O, Enter, wyjście Ctrl+X):

```caddyfile
{
    acme_ca https://acme-v02.api.letsencrypt.org/directory
}

oms.przyklad.pl {
    reverse_proxy 127.0.0.1:3001
}
```

Nie dodawaj reguł `header` z nagłówkami bezpieczeństwa — nie dubluj ich w proxy: panel wysyła
je sam. Caddy przekazuje adres gościa w `X-Forwarded-For` i protokół w `X-Forwarded-Proto`.

**3. Ustaw zaufany adres proxy.** To adres bezpośredniego pośrednika widziany przez OMS,
nie adres komputera gościa. Przy OMS uruchomionym bezpośrednio na hoście byłoby to
`OMS_TRUST_PROXY=127.0.0.1`. W tej instalacji Docker może zamienić adres źródłowy na bramę
swojej sieci. Odczytaj ją (standardowy Compose z tej instrukcji ma jedną sieć):

```bash
sudo docker inspect oms --format '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}'
sudo nano /opt/oms/config/oms.env
```

Dodaj jedną linię `OMS_TRUST_PROXY=ADRES-BRAMY`, zastępując `ADRES-BRAMY` wynikiem, np.
`OMS_TRUST_PROXY=172.18.0.1`. Nie kopiuj przykładowego adresu bez sprawdzenia. Jeśli Twoja
konfiguracja Dockera zachowuje loopback, użyj `127.0.0.1`; poprawność potwierdź próbą z punktu 5.
Format: dokładny IPv4/IPv6 albo CIDR, kilka adresów oddzielonych przecinkami **bez spacji**.
Nie wpisuj `true`, `*`, zakresu `/0` ani całej sieci użytkowników. Zaufanie bramie oznacza
zaufanie ruchowi z hosta i wymaga zamknięcia bezpośredniego portu HTTP z punktu 1.
Zapisz plik i odtwórz kontener (sam `restart` nie wczytuje zmienionego `env_file`):

```bash
sudo sh /opt/oms/aktualizuj.sh compose up -d --force-recreate oms
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

Jeśli walidacja lub uruchomienie odmawia, sprawdź `sudo journalctl -u caddy -n 50 --no-pager`.
Najpierw popraw domenę, DNS lub dostępność portów 80/443; nie omijaj błędów certyfikatu w przeglądarce.

**4. Sprawdź HTTPS i linki.** Na innym komputerze:

```bash
curl -I https://oms.przyklad.pl/login
```

Oczekiwane: HTTP 200 oraz poniższe nagłówki (wielkość liter nazw nie ma znaczenia):

```text
X-Frame-Options: DENY
Content-Security-Policy: frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: same-origin
Strict-Transport-Security: max-age=15552000
```

Zaloguj się pod `https://oms.przyklad.pl/login`. W narzędziach przeglądarki (F12 → Sieć,
odpowiedź POST `/login`) ciasteczko sesji w `Set-Cookie` ma `Secure` i `HttpOnly`.
Sam GET `/login` nie ustawia sesji. Panel dodaje HSTS i `Secure` według `X-Forwarded-Proto`
także bez `OMS_TRUST_PROXY` — te flagi nie potwierdzają poprawnego adresu gościa.
W Ustawienia → Integracje → Poczta wychodząca, w sekcji „Adres OMS-u w mailach” (Adres panelu), zapisz `https://oms.przyklad.pl`,
bez `/login`. To adres linków w mailach, m.in. zaproszeń i ustawiania hasła. Jeżeli pole jest
zablokowane przez istniejące `OMS_ADRES_PANELU`, popraw jego wartość w `oms.env` i odtwórz
kontener tym samym poleceniem co wyżej.

**5. Sprawdź blokadę prób na koncie próbnym.** Wyloguj się i dla jednego wymyślonego,
nieistniejącego loginu wpisz pięć razy błędne hasło w ciągu minuty. Piąta odmowa uruchamia
blokadę (HTTP 429), a szósta próba także zwraca HTTP 429 i „Za dużo nieudanych prób”
(widać w F12 → Sieć).
Z drugiego łącza, np. telefonu z wyłączonym Wi-Fi, pierwsza błędna próba tego samego loginu
powinna dać zwykłą odmowę, bez 429. Jeśli od razu dzieli blokadę, OMS widzi wspólny adres:
popraw `OMS_TRUST_PROXY` i powtórz po wygaśnięciu blokady (co najmniej minuta).
Bez tej zmiennej wszyscy za proxy dzielą adres, a ochrona przed zgadywaniem haseł jest słabsza.
Nie przeprowadzaj próby wieloma loginami ani na koncie pracownika.

**Tunel Cloudflare** jest alternatywą bez otwierania portów przychodzących: uruchom `cloudflared`
na tym samym hoście lub w kontenerze i skieruj jego publiczną nazwę na HTTP OMS. W `OMS_TRUST_PROXY`
wpisz adres bezpośredniego pośrednika widziany przez OMS: adres kontenera/hosta `cloudflared`
(przy przejściu przez publikowany port Dockera może to być brama), **nie zakresy adresów Cloudflare**.
Nie ufaj całej sieci kontenerów; po zmianie adresu tunelu zaktualizuj wpis i odtwórz OMS.
Powtórz kontrolę protokołu HTTPS, flag ciasteczka, adresu panelu i oddzielnych blokad jak wyżej;
bezpośredni port HTTP nadal ma być zamknięty z internetu.

VPN (np. WireGuard) pozwala korzystać z panelu przez prywatną sieć bez wystawiania go do internetu.

## 8. Przejście na pracę

Próba z demo zostaje w archiwum, praca startuje na **pustej bazie z nowym kontem administratora**.
Z próby nie przechodzi nic: zamówienia DEMO, konto próby i jej kopie nie mieszają się z prawdziwymi
danymi. Przygotuj dane firmy: NIP, numer rachunku (26 cyfr), BDO (jeśli firma ma), nazwę i adres firmy.
Adres firmy (`DPD_NADAWCA_…`) możesz zostawić pusty i wpisać po przejściu w panelu: Ustawienia → Firma
(bez niego OMS nie wystawi proformy ani specyfikacji). Wpisany w pliku ma pierwszeństwo przed panelem.

```bash
sudo sh /opt/oms/aktualizuj.sh produkcja
```

Pierwsze wywołanie niczego nie przełącza: zakłada plik `/opt/oms/config/produkcja.env` (z losowym
hasłem konta serwisowego) i wypisuje pola do uzupełnienia. Otwórz go:

```bash
sudo nano /opt/oms/config/produkcja.env
```

Wpisz wartości zaraz po `=` — bez spacji tuż po `=` i bez cudzysłowów; spacje wewnątrz wartości są
w porządku (`DPD_NADAWCA_NAZWA=Pilot sp. z o.o.`). Wartość ze znakiem `$` ujmij w apostrofy
(`NAZWA='wartość'`). Przejście wymaga wydania z tą funkcją — starsze odpowie samym `Uzycie:`
albo `WYDANIE_BEZ_PRZEJSCIA`; wtedy najpierw aktualizacja (`docs/aktualizacja-klienta-v0.md`). Zapisz: Ctrl+O, Enter, wyjdź: Ctrl+X. Potem drugi raz:

```bash
sudo -v
sudo sh /opt/oms/aktualizuj.sh produkcja
```

Odmawia, dopóki brakuje pól (`PRODUKCJA_NIEWYPELNIONE_POLA:` z ich nazwami) albo gdy wpisano wartość
z próby (`PRODUKCJA_WARTOSC_Z_PROBY:`). Gdy wszystko jest, zatrzymuje próbę (panel stoi kilkanaście
sekund), robi jej kopię ze sprawdzeniem spójności, przenosi dane próby do
`/opt/oms/proba-archiwum/OPERACJA/`, uruchamia OMS na pustej bazie, zakłada konto `administrator`
i robi pierwszą kopię. Kończy wierszem `NEEDS_ACCEPT operacja=…` — zapisz numer operacji
(np. `20261016-201242-81ed`); niżej wpisujesz go zamiast słowa `OPERACJA`. Do odbioru `status` pokazuje
`blokada: TAK`, `etap=czeka_na_akceptacje` i zdanie „proces aktualizatora nie działa…” — to stan oczekiwany,
nie awaria: przejście skończyło pracę i czeka na Twoją decyzję. Zgubiony numer operacji odczytasz
tym samym poleceniem `sudo sh /opt/oms/aktualizuj.sh status`: w sekcji blokady stoi wiersz `operacja=…`.
Jeśli OMS nie przyjmie konfiguracji (np. błędny NIP), przejście samo wraca do próby
(`WYCOFANE …`) i pokazuje ostatnie linie dziennika z nazwą zmiennej — popraw `produkcja.env`
i powtórz polecenie.

Odbiór:

```bash
sudo cat /opt/oms/config/administrator.env
sudo sh /opt/oms/aktualizuj.sh zdrowie
```

Zaloguj się nowym kontem (`http://ADRES-SERWERA:3001/login`): lista zamówień jest pusta.
W Ustawieniach → Zespół i dostęp → Użytkownicy załóż konta imienne dla siebie i pracowników — konto `administrator` zostaw
na awarię. `zdrowie` wypisuje `"ok": true` albo alarmy i uwagi (np. brak kopii poza dyskiem).
Jeśli wszystko się zgadza:

```bash
sudo sh /opt/oms/aktualizuj.sh accept OPERACJA
```

Zamiast tego powrót do próby: `sudo sh /opt/oms/aktualizuj.sh recover OPERACJA` — próba wraca ze
swoimi danymi, baza pracy trafia do archiwum, konfiguracja pracy z powrotem do `produkcja.env`.
`recover` działa też po przerwaniu przejścia (zanik prądu, zamknięte okno terminala) —
`sudo sh /opt/oms/aktualizuj.sh status` podpowiada, co dalej. Po `accept` tej drogi powrotu nie ma.
Gdy w bazie pracy są już zamówienia, `recover` odmawia (`PRACA_MA_ZAMOWIENIA`): powrót odłożyłby je
do archiwum, a ponowne przejście zaczęłoby od pustej bazy i proform od numeru 1. Tylko świadomie:
`recover OPERACJA --porzuc-prace`. Dopóki trwa odbiór, nie kasuj `/opt/oms/proba-archiwum`.

Konto `serwis` z pliku konfiguracji po założeniu administratora już nie loguje. Zapisz hasło
administratora i — teraz, zanim dopiszesz klucze integracji — zawartość `/opt/oms/config/oms.env`
w menedżerze haseł (`sudo cat` wyświetla ją na ekranie; po sekcji 9 byłyby tam klucze). Na nośniku
kopii (jeśli jest) kopie próby znikają same po 30 kopiach pracy.

Klucz poświadczeń (`/opt/oms/config/klucz.env`) przejście zostawia na miejscu: próba i praca mają
ten sam klucz. Nie jest przenoszony ani archiwizowany, a `recover` go nie rusza.

Archiwum próby `/opt/oms/proba-archiwum/OPERACJA/` zawiera: katalog danych próby (`data/` — baza
z zamówieniami DEMO, proformy, etykiety), jej kopie (`backups/`, `kopia/`) i jej pliki konfiguracji
(`config/oms.env` z hasłem konta serwisowego próby, `config/administrator-proby.env`,
`config/produkcja.env.example`). Do `accept` leży tam też kopia `config/produkcja.env` — potrzebna tylko
do powrotu; `accept` ją usuwa. Po `recover` dochodzi `produkcja-odlozona-…/` z bazą pracy, a czasem
także z `oms.env` i `administrator.env` pracy. Te pliki konfiguracji są jawne, jak każdy plik `.env` —
archiwum traktuj jak katalog z hasłami. Nic nie usuwa go samo, także po przerwanym albo nigdy
niezaakceptowanym przejściu. Skasuj je po `accept`, gdy przestanie być potrzebne:
`sudo rm -r /opt/oms/proba-archiwum` — razem z nim znikają bazy pracy odłożone przez `recover`.

## 9. Integracje po kolei

Kolejność: **inFakt → sklep WooCommerce → Allegro → kurierzy (DPD, InPost)**. Jedna naraz —
gdy coś nie działa, wiadomo co. Każda wygląda tak samo: dopisujesz linie do konfiguracji,
uruchamiasz OMS od nowa i sprawdzasz. Poczta, inFakt, DPD i InPost mają też ekrany w Ustawieniach →
Integracje (poniżej przy każdej jest o tym akapit); plik konfiguracji zawsze wygrywa z ekranem.

```bash
sudo nano /opt/oms/config/oms.env
sudo -v
sudo sh /opt/oms/aktualizuj.sh compose up -d
sudo sh /opt/oms/aktualizuj.sh status
sudo sh /opt/oms/aktualizuj.sh zdrowie
```

Konfigurację czyta dopiero `compose up -d` (`restart` jej nie czyta). `status` po kilkunastu
sekundach pokazuje `zdrowie: HTTP=200`. Jeśli OMS nie wstał, dziennik podaje nazwę błędnej zmiennej
(bez wartości): `sudo sh /opt/oms/aktualizuj.sh compose logs --tail 30 oms` — popraw linię
i powtórz `compose up -d`. Po każdej integracji zrób diagnostykę („Gdy coś nie działa”) i zachowaj
plik — to punkt odniesienia, gdy kolejna integracja coś zepsuje.

Wartości z panelu dostawcy wklejasz po `=`. Przykłady niżej mają nazwy firmy Pilot — zamień je
na swoje.

**inFakt** (faktury sprzedaży; bez niego OMS wystawia tylko proformy):

```
INFAKT_API_KEY=klucz-z-inFaktu
```

Sprawdzenie: w `zdrowie` sekcja `czuwaczOstrzezen` ma `"wlaczony": true`, zakładka FAKTURY pokazuje
faktury z konta. Zły klucz albo brak łączności z inFaktem: FAKTURY ładują się ok. 10 s i pokazują błąd
sieci (zmierzone na próbie bez dostępu do API).

**inFakt — też z ekranu:** Ustawienia → Integracje → inFakt (klucz API, „Sprawdź połączenie”).
Pierwsze podłączenie z ekranu włącza zakładkę FAKTURY po ponownym uruchomieniu OMS-u
(`sudo sh /opt/oms/aktualizuj.sh compose restart oms` — klucz leży w bazie, więc sam restart wystarcza);
późniejsza zmiana klucza działa od razu. Wtedy linii `INFAKT_API_KEY` nie wpisuj — gdy jest w pliku, wygrywa
nad ekranem. Adres API (`INFAKT_API_URL`) i archiwum sprzedaży (`INFAKT_ARCHIWUM`) ustawia się tylko w pliku.

**Program do faktur — wybór z ekranu:** Ustawienia → Faktury i podatki → Program do faktur (Brak / inFakt /
Fakturownia; TwojeFaktury — wkrótce). Bez wyboru działa inFakt, gdy ma klucz. Szczegóły:
`docs/modul-faktur.md`.

**Sklep WooCommerce** — klucze REST ze sklepu (WooCommerce → Ustawienia → Zaawansowane → REST API,
uprawnienia „odczyt/zapis”):

```
OMS_KANALY=[{"klucz":"woo_pilot","typ":"woo","prefiks":"WOO_PILOT","etykieta":"sklep.przyklad.pl","raport":"SKLEP_PILOT"}]
OMS_RAPORTY_NAZWY_KANALOW={"SKLEP_PILOT":"sklep.przyklad.pl"}
WOO_PILOT_URL=https://sklep.przyklad.pl
WOO_PILOT_CK=ck_…
WOO_PILOT_CS=cs_…
WOO_PILOT_MAPOWANIE={"instancje":{"3":{"metoda":"dpd"},"5":{"metoda":"inpost_paczkomat"}},"poPozycji":[]}
WOO_PILOT_OD=RRRR-MM-DD
```

Linie `OMS_KANALY=[]` i `OMS_RAPORTY_NAZWY_KANALOW={}` już są w pliku — zamień je, nie dopisuj
drugi raz. `klucz` — małe litery, cyfry i `_`; **sklep nie może zaczynać się od `allegro`**;
klucza nie zmieniaj po pierwszym zamówieniu (siedzi w każdym zamówieniu). `prefiks` — ten sam
napis wielkimi literami, przedrostek pozostałych linii. `etykieta` — nazwa na ekranach, `raport` —
nazwa kanału w raporcie sprzedaży (wielkie litery; nie `SKLEP`, `ALLEGRO`, `RECZNE`, `B2B`,
`DROPSHIPPING`, `GDD`, `INDYWIDUALNE`). `OD` — dzień, od którego OMS pobiera zamówienia (data
złożenia): dzień startu pracy w OMS albo wcześniejszy, **nigdy przyszły** — zamówień sprzed `OD`
OMS nie pobierze nigdy, także po jego późniejszym obniżeniu; **bez `OD` pobierze całą historię
sklepu**. `MAPOWANIE` — numer każdej metody wysyłki sklepu
(WooCommerce → Ustawienia → Wysyłka → strefa → metoda, liczba po `instance_id=` w adresie)
i metoda OMS: `dpd`, `inpost_paczkomat` albo `odbior_osobisty`.

Raport sprzedaży potrzebuje dla nowego kanału granicy — dnia, po którym liczy jego zamówienia;
bez niej zakładka RAPORTY odmawia („nie wie, gdzie przebiega granica historii”). Po `compose up -d`
zakłada ją polecenie (dzień przed `OD`, liczony sam; istniejące granice zostają, kanały wpisane przed
przejściem na pracę dostały ją już wtedy):

```bash
sudo sh /opt/oms/aktualizuj.sh compose exec -T oms node scripts/produkcja-pierwszy-start.mjs --granice
```

Wypisuje założone granice, np. `"zalozone":["SKLEP_PILOT=…"]`. Granicy nie da się później zmienić —
nie wpisuj jej ręcznie z datą w dniu `OD` albo później (narzędzie ręczne odmówi), bo zamówienia od `OD`
zniknęłyby z raportu.

Sprawdzenie: po 2–3 minutach w `zdrowie`, w sekcji `poller` → `zrodla`, kanał `woo_pilot` ma datę
`ostatniPrzebiegAt` i `"blad": null` (zły adres albo klucze: `"blad": "Sklep nieosiągalny…"`);
zamówienia od daty `OD` są na liście, filtr kanału pokazuje etykietę.

**Allegro** — najpierw własna aplikacja w Allegro Developer (daje client ID i secret), potem
wpisy w konfiguracji i połączenie konta.

*Aplikacja w Allegro.* Zaloguj się na konto sprzedawcy i wejdź na `https://apps.developer.allegro.pl`
(konto musi mieć włączone logowanie dwustopniowe). Zarejestruj nową aplikację:

- nazwa — dowolna; Allegro pokaże ją przy wyrażaniu zgody (np. „OMS mojej firmy”);
- typ: **„Aplikacja będzie działać w środowisku bez dostępu do przeglądarki albo klawiatury”** —
  OMS łączy konto przez device flow (kod do przepisania). Adresu przekierowania nie podajesz.
  **Typu nie da się zmienić później** — przy złym wyborze rejestrujesz aplikację od nowa;
- zaakceptuj regulamin REST API.

Po zapisaniu otwórz aplikację na liście i **zaznacz uprawnienia (scope)**, których OMS potrzebuje:
`allegro:api:orders:read`, `allegro:api:orders:write`, `allegro:api:sale:offers:read`,
`allegro:api:shipments:read`, `allegro:api:shipments:write`, `allegro:api:messaging`,
`allegro:api:disputes`. Zakresy trafiają do połączenia w chwili wiązania konta — dopisane później
nie zadziałają, dopóki nie połączysz kanału ponownie (OMS pokazuje wtedy przy kanale, których brakuje).
Client ID i Client Secret skopiuj ze strony aplikacji do konfiguracji niżej.

Regulamin REST API (wersja od 1.09.2026) — trzy rzeczy, które dotyczą każdej instalacji:

- **jeden klucz na konto** (poradnik Allegro pisze jeszcze o pięciu — rozstrzyga regulamin). Jeśli
  masz już zarejestrowaną inną aplikację, sprawdź listę przed dodaniem nowej. Integratorów
  autoryzowanych przez OAuth (BaseLinker, Apilo itp.) to nie dotyczy — działają na własnych kluczach;
- klucz trzeba **użyć w ciągu 30 dni** od rejestracji, a OMS ma odpytywać Allegro co najmniej raz
  na 90 dni — inaczej Allegro może klucz usunąć. Rejestruj aplikację wtedy, gdy podłączasz kanał;
- **klucza nie przekazuj nikomu** (także wykonawcy, który stawia Ci OMS) — za udostępnienie
  regulamin przewiduje karę umowną. Wykonawca może wpisać go na Twoim serwerze, ale aplikacja
  ma być zarejestrowana na Twoim koncie.

Jedna aplikacja wystarcza do kilku kont Allegro: każdy kanał ma te same `CLIENT_ID`/`CLIENT_SECRET`,
a konto wybiera się przy połączeniu (niżej).

*Konfiguracja.* Drugi kanał dopisujesz do tej samej listy `OMS_KANALY`:

```
OMS_KANALY=[{"klucz":"woo_pilot",…},{"klucz":"allegro_pilot","typ":"allegro","prefiks":"ALLEGRO_PILOT","etykieta":"Allegro Pilot","raport":"ALLEGRO_PILOT"}]
OMS_RAPORTY_NAZWY_KANALOW={"SKLEP_PILOT":"sklep.przyklad.pl","ALLEGRO_PILOT":"Allegro Pilot"}
ALLEGRO_PILOT_CLIENT_ID=…
ALLEGRO_PILOT_CLIENT_SECRET=…
ALLEGRO_PILOT_USER_AGENT=PilotOMS/1.0 (+https://przyklad.pl)
ALLEGRO_PILOT_OD=RRRR-MM-DD
```

**Klucz kanału Allegro musi zaczynać się od `allegro_`** — po nim panel rozpoznaje zamówienia
Allegro (wysyłka, faktury, terminy, statystyki); przy innym kluczu `zdrowie` pokazuje alarm.
`USER_AGENT` ma postać `nazwa/wersja (+https://adres)`. Po `compose up -d`: Ustawienia →
Integracje → Moje połączenia, przy koncie Allegro tego kanału → „Połącz z Allegro”; OMS pokazuje kod i adres. Otwórz go w przeglądarce **zalogowanej
na konto Allegro tego kanału** — wiązanie dotyczy konta zalogowanego w przeglądarce, nie wpisanego
w konfiguracji. Do połączenia `zdrowie` pokazuje alarm „Kanał allegro_pilot nie jest połączony
z Allegro…” — to oczekiwane; po połączeniu znika. Granica raportu tym samym poleceniem co przy
sklepie (`produkcja-pierwszy-start.mjs --granice`), zaraz po `compose up -d`.

**Kurier DPD — najprościej z ekranu:** Ustawienia → Integracje → DPD (login, numer
klienta i hasło od DPD, typ etykiety, przycisk „Sprawdź połączenie”). Krok po kroku, ze szkicem maila
do DPD: `docs/kurier-dpd.md`. Wtedy linii `DPD_URL`…`DPD_INFO_CHANNEL` niżej nie wpisuj — gdy są w pliku,
wygrywają nad ekranem.

**Kurier InPost — też z ekranu:** Ustawienia → Integracje → InPost (token API
ShipX, numer organizacji, opcjonalny paczkomat nadawczy, „Sprawdź połączenie”). Krok po kroku:
`docs/kurier-inpost.md`. Wtedy linii `INPOST_…` niżej nie wpisuj — gdy są w pliku, wygrywają nad ekranem.

**Wydruk etykiet na drukarce w biurze** (Zebra i inne drukarki etykiet) robi mały program na komputerze
z Windowsem przy drukarce — instrukcja: `deploy/drukarka/README.md`.

**Kurierzy w pliku.** Kurier ustawiony w pliku wymaga adresu nadawcy też w pliku: `DPD_NADAWCA_…`
(jeśli zostawiłeś go pustego przy przejściu na pracę, uzupełnij go teraz). Dopisz telefon i e-mail (InPost
bez nich nie nada):

```
DPD_NADAWCA_TELEFON=…
DPD_NADAWCA_EMAIL=…
DPD_URL=…
DPD_LOGIN=…
DPD_PASSWORD=…
DPD_FID=…
DPD_INFO_URL=…
DPD_INFO_CHANNEL=…
INPOST_TOKEN=…
INPOST_ORGANIZACJA=…
```

Adresy i dane DPD pochodzą z umowy (dostęp do API DPD Polska), token i numer organizacji InPost —
z panelu ShipX (API). Każdy kurier osobno, ze sprawdzeniem `zdrowie` po każdym. **Pierwsze
nadanie to prawdziwa paczka i prawdziwy koszt** — zrób je świadomie, na jednym zamówieniu.

**Poczta wychodząca (SMTP)** — zaproszenia do kont, linki do hasła, wiadomości do klientów z karty
zamówienia — ustawia się w Ustawienia → Integracje → Poczta wychodząca albo w pliku (`SMTP_…`, `MAIL_FROM`); krok po
kroku, z wiadomością próbną: `docs/poczta-smtp.md`. Plik wygrywa z ekranem.

KSeF jest poza tą instrukcją.

## Codzienna obsługa

Polecenia wykonuj przez `/opt/oms/aktualizuj.sh compose …` — zawsze trafiają do bieżącego wydania.
`docker compose` uruchomione w katalogu STAREGO wydania (po aktualizacji zostają dwa poprzednie)
przełączyłoby OMS z powrotem na stary obraz.

| Co | Polecenie |
|---|---|
| stan OMS i aktualizacji | `sudo sh /opt/oms/aktualizuj.sh status` |
| pełna odpowiedź `/health` (alarmy, uwagi) | `sudo sh /opt/oms/aktualizuj.sh zdrowie` |
| kontenery | `sudo sh /opt/oms/aktualizuj.sh compose ps` |
| dziennik | `sudo sh /opt/oms/aktualizuj.sh compose logs --tail 100 oms` |
| kopia teraz | `sudo sh /opt/oms/aktualizuj.sh compose exec -T kopia node deploy/klient/kopia.mjs teraz` |
| zatrzymanie (dane zostają) | `sudo sh /opt/oms/aktualizuj.sh compose down` |
| ponowny start (także po zmianie plików w `/opt/oms/config`) | `sudo sh /opt/oms/aktualizuj.sh compose up -d` |
| poświadczenia w bazie: id wymaganego klucza, sprzątanie pliku | `sudo sh /opt/oms/aktualizuj.sh sekrety stan` |
| aktualizacja do nowego wydania | `docs/aktualizacja-klienta-v0.md` |

Kopie robi kontener `oms-kopia` (sprawdza co godzinę, co jest potrzebne):

- baza → `/opt/oms/backups/oms-RRRR-MM-DD.sqlite`: raz dziennie po 03:00 UTC, a gdy serwer był
  wyłączony — zaraz po włączeniu (najpóźniej 26 h po poprzedniej); 14 ostatnich;
- etykiety i proformy → `/opt/oms/backups/pliki-RRRR-MM-DD.tgz` co 7 dni, 2 ostatnie archiwa;
- jeśli ustawiono kopię poza dyskiem (niżej): najnowsza kopia bazy i wszystkie etykiety i proformy
  także na pendrive/dysk USB.

Panel pokazuje alarm w `/health` (i diagnostyka w sekcji „Kopie”), gdy najnowsza kopia ma 48 h
albo więcej, gdy kopii nie ma i gdy nośnika kopii zewnętrznej brakuje. Bez kopii poza dyskiem
`/health` ma stałą uwagę: kopie na tym samym dysku co baza giną razem z nim.

Sprawdzenie najnowszej kopii (spójność i liczba zamówień):

```bash
sudo sh /opt/oms/aktualizuj.sh compose run --rm --no-deps kopia node -e "const{DatabaseSync}=require('node:sqlite');const f=require('fs').readdirSync('/opt/oms/backups').filter(n=>/^oms-.*\.sqlite$/.test(n)).sort().pop();const d=new DatabaseSync('/opt/oms/backups/'+f,{readOnly:true});console.log(f,d.prepare('PRAGMA integrity_check').get().integrity_check,d.prepare('SELECT count(*) AS n FROM zamowienia').get().n)"
```

Wynik: nazwa pliku, `ok` i liczba zamówień.

Co jest w kopiach i czego w nich nie ma:

| co kopiujemy | gdzie jest klucz | co odtwarzamy | co trzeba podłączyć ponownie |
|---|---|---|---|
| baza: kopie dzienne (`/opt/oms/backups/oms-*.sqlite`) i na nośniku | nie ma go w kopii — `/opt/oms/config/klucz.env` i menedżer haseł | zamówienia, faktury, proformy w bazie, konta, ustawienia, poświadczenia integracji zapisane w panelu (z kluczem tej kopii) | klucze reklam (Meta Ads, Google Analytics 4, Google Ads); integrację, której token dostawca zdążył unieważnić; bez klucza — wszystkie integracje zapisane w panelu, tokeny Allegro i KSeF |
| etykiety i proformy (`pliki-*.tgz`, na nośniku `pliki/`) | nie dotyczy | pliki PDF | nic |
| kopia operacji aktualizatora (`/opt/oms/backups/operacje/…`) | nie ma go w kopii | bazę sprzed aktualizacji przy `recover … --przywroc-baze`, na tym samym serwerze | nic |
| konfiguracja `/opt/oms/config` (`oms.env`, `kopia.env`) | nie dotyczy | nie ma jej w żadnej kopii OMS-u — tylko w menedżerze haseł | integracje wpisane w `oms.env`, jeśli nie ma go w menedżerze |
| klucz `/opt/oms/config/klucz.env` | — | nie ma go w żadnej kopii OMS-u — tylko w menedżerze haseł (z id i datą) | — |
| klucze reklam (`/opt/oms/data/reklamy-sekrety`) | nie są szyfrowane | nie ma ich w kopii dziennej ani na nośniku | po odtworzeniu podłącza się je ponownie |

Kopia całego serwera (migawka maszyny wirtualnej, kopia całego `/opt/oms`) zawiera bazę i klucz razem.
Taką kopię chroń jak hasła — podział na dwa pliki jej nie zabezpiecza.

## Kopia poza dyskiem (pendrive, dysk USB)

Awaria dysku serwera (np. pamięci eMMC w małym komputerze) zabiera bazę i wszystkie kopie
z `/opt/oms/backups`. Nośnik zewnętrzny, podłączony na stałe, dostaje codziennie kopię bazy
i wszystkie etykiety i proformy (pliki tylko dopisywane; 30 ostatnich kopii bazy).

Nośnik musi mieć co najmniej kilka GB. **Formatowanie kasuje jego zawartość.** Podłącz go
i sprawdź jego nazwę (kolumny NAME, SIZE, MODEL — wybierz ten o rozmiarze pendrive'a, nie dysk systemowy):

```bash
lsblk -o NAME,SIZE,MODEL,FSTYPE,MOUNTPOINTS
```

Dalej, z właściwą nazwą zamiast `sdX1` (przykład: `sdb1`):

```bash
sudo mkfs.ext4 -F -L OMS-KOPIA /dev/sdX1
sudo install -d -m 0755 /opt/oms/kopia-zewnetrzna/nosnik
echo 'LABEL=OMS-KOPIA /opt/oms/kopia-zewnetrzna/nosnik ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload
sudo mount /opt/oms/kopia-zewnetrzna/nosnik
sudo chown 10001:10001 /opt/oms/kopia-zewnetrzna/nosnik
sudo chmod 0700 /opt/oms/kopia-zewnetrzna/nosnik
sudo mountpoint /opt/oms/kopia-zewnetrzna/nosnik && sudo touch /opt/oms/kopia-zewnetrzna/nosnik/.oms-cel-kopii
echo 'OMS_KOPIA_ZEWNETRZNA=/opt/oms/kopia-zewnetrzna/nosnik' | sudo tee /opt/oms/config/kopia.env
sudo sh /opt/oms/aktualizuj.sh compose up -d
sudo sh /opt/oms/aktualizuj.sh compose exec -T kopia node deploy/klient/kopia.mjs teraz
```

`mountpoint` musi wypisać „is a mountpoint”. Jeśli wypisze „is not a mountpoint”, montowanie się nie
udało (zła partycja, brak etykiety) — znacznik nie powstanie, a panel pokaże alarm „brak nośnika”;
popraw nazwę urządzenia i powtórz blok. Ostatnie polecenie robi kopię od razu i wypisuje, co skopiowało. Plik `.oms-cel-kopii` oznacza
nośnik: gdy pendrive zostanie odłączony, `/opt/oms/kopia-zewnetrzna/nosnik` jest pustym katalogiem
na dysku serwera — kopia tam nie pisze (to byłaby „kopia poza dyskiem” na tym samym dysku), a panel
pokazuje alarm „brak nośnika”. `nofail` w `/etc/fstab` pozwala serwerowi wstać bez nośnika.
Nośnik montuje się w podkatalogu `nosnik`, nie w samym `/opt/oms/kopia-zewnetrzna`: tylko wtedy
kontenery widzą jego podłączenie i odłączenie bez restartu (sprawdzone na VM 10.10).

Serwer wirtualny (VPS) w kontenerze LXC/OpenVZ bywa bez współdzielonych punktów montowania
(`findmnt -o PROPAGATION /` nie wypisuje `shared`) — wtedy kontenery z nośnikiem nie wystartują;
na takim serwerze kopię poza dyskiem robi się inaczej (np. pobieranie kopii przez sieć), poza tą instrukcją.

### Odtworzenie po awarii dysku

Procedura nieprzećwiczona jeszcze na sprzęcie. Potrzebujesz trzech rzeczy: nośnika z kopią
oraz z menedżera haseł zawartości `klucz.env` i `oms.env` pracy. Na nośniku nie ma ani klucza, ani
konfiguracji — dlatego zaraz po instalacji i po każdej zmianie zapisuj oba pliki w menedżerze haseł.

⚠️ **Na odtworzonej bazie nie uruchamiaj instalatora** (`docker compose run --rm instalacja`) **ani
`aktualizuj.sh produkcja`.** Instalator zakłada próbę z danymi DEMO. `produkcja` odkłada cały katalog
danych do archiwum i uruchamia OMS na pustej bazie — odtworzona baza firmy wylądowałaby w archiwum.

1. Na nowym dysku wykonaj kroki 1–4 tej instrukcji. Kroku 5 nie wykonujesz.
2. Wstaw konfigurację z menedżera haseł. W `klucz.env` wklej linię `OMS_KLUCZ_SEKRETOW=…`,
   w `oms.env` całą zapisaną treść:

   ```bash
   sudo nano /opt/oms/config/klucz.env
   sudo nano /opt/oms/config/oms.env
   sudo chown 10001:10001 /opt/oms/config/klucz.env /opt/oms/config/oms.env
   sudo chmod 600 /opt/oms/config/klucz.env /opt/oms/config/oms.env
   ```

3. Podłącz nośnik tylko do odczytu, skopiuj najnowszą kopię bazy do katalogu roboczego i sprawdź ją
   (`RRRR-MM-DD` — data z listy plików):

   ```bash
   sudo mkdir -p /mnt/oms-kopia
   sudo mount -o ro LABEL=OMS-KOPIA /mnt/oms-kopia
   sudo ls /mnt/oms-kopia
   sudo install -d -m 0700 -o 10001 -g 10001 /opt/oms/odtwarzanie
   sudo install -m 0600 -o 10001 -g 10001 /mnt/oms-kopia/oms-RRRR-MM-DD.sqlite /opt/oms/odtwarzanie/oms.sqlite
   sudo sh /opt/oms/aktualizuj.sh sekrety sprawdz --baza /opt/oms/odtwarzanie/oms.sqlite
   ```

   Sprawdzenie bada spójność pliku i odszyfrowuje każde poświadczenie kluczem z `klucz.env`. Dalej
   idziesz tylko po ostatnim wierszu `KLUCZ_ZGODNY`. `KLUCZ_NIEZGODNY: kopia wymaga id X, podano id Y`
   znaczy, że kopia powstała pod innym kluczem — znajdź w menedżerze haseł wpis z id X (rozdział
   „Klucz poświadczeń”, „Historia kluczy”). `BAZA_USZKODZONA` — weź starszą kopię. Kopia sprzed
   szyfrowania (`format: brak znacznika`) przechodzi bez względu na klucz; OMS zaszyfruje ją przy
   starcie kluczem z `klucz.env`.
4. Wstaw sprawdzoną bazę oraz etykiety i proformy z nośnika (kontenery jeszcze nie działają):

   ```bash
   sudo mv /opt/oms/odtwarzanie/oms.sqlite /opt/oms/data/oms.sqlite
   sudo rm -f /opt/oms/data/oms.sqlite-wal /opt/oms/data/oms.sqlite-shm
   sudo cp -a /mnt/oms-kopia/pliki/etykiety /mnt/oms-kopia/pliki/proformy /opt/oms/data/
   sudo chown -R 10001:10001 /opt/oms/data
   sudo umount /mnt/oms-kopia
   ```

5. Sprawdź przed startem: `OMS_TRYB` w `oms.env` nie może być `proba` (pusty albo `produkcja`);
   adres panelu i lista kanałów mają być takie jak przed awarią. Ścieżek danych nie poprawiasz —
   ustawia je `compose.yaml`.

   ```bash
   sudo grep -E '^(OMS_TRYB|OMS_ADRES_PANELU|OMS_KANALY)=' /opt/oms/config/oms.env
   ```

6. Start i logowanie: kroki 6–7. Logujesz się kontem z odtworzonej bazy, nie kontem z instalacji.
   Potem `sudo sh /opt/oms/aktualizuj.sh zdrowie` i lista zamówień.

Po odtworzeniu: kopię poza dyskiem włącz blokiem poleceń z tej sekcji, ale **bez pierwszego polecenia
(`mkfs.ext4`)** — formatowanie skasowałoby nośnik z kopiami. Klucze reklam (Meta Ads, Google
Analytics 4, Google Ads) podłącz ponownie — nie ma ich w kopii. Jeśli dostawca odrzuci token
(Allegro, KSeF), podłącz tę integrację od nowa: kopia oddaje poświadczenia z dnia kopii, a nie
gwarancję, że dostawca je jeszcze przyjmie.

## Klucz poświadczeń

Poświadczenia integracji są szyfrowane w bazie: hasła, klucze API i tokeny zapisane z ekranów
Ustawień oraz tokeny dostępu Allegro i KSeF. Klucz leży w pliku `/opt/oms/config/klucz.env` — jedna
linia `OMS_KLUCZ_SEKRETOW=` i 43 znaki. Kopia bazy bez tego klucza odda zamówienia, faktury i konta,
ale nie poświadczenia: integracje trzeba będzie podłączyć od nowa.

Każdy klucz ma id — 8 znaków, np. `3f9a0c1e`. Id wolno pokazać i zapisać w notatkach, po nim
rozpoznasz klucz. Samej wartości klucza nie wklejaj do czatu, zgłoszenia ani maila.

### Zapis klucza i historia kluczy

Klucz powstaje sam: przy instalacji (krok 5) albo przy pierwszej aktualizacji do wydania, które
szyfruje poświadczenia (`docs/aktualizacja-klienta-v0.md`). Oba polecenia podają jego id. Zapisz go od razu:

```bash
sudo cat /opt/oms/config/klucz.env
```

W menedżerze haseł zapisz linię `OMS_KLUCZ_SEKRETOW=…` jako osobny wpis, z id i datą. OMS nie
kopiuje klucza nigdzie: nie ma go w kopii dziennej, na nośniku ani w kopii operacji aktualizatora.
Menedżer haseł to jedyne miejsce poza serwerem. Nie kopiuj klucza na nośnik razem z bazą.

Każdy klucz, którym zaszyfrowano trzymaną kopię, zostaje w menedżerze haseł z id i datą — także po
wymianie klucza. Kopie dzienne znikają po 14 dniach, na nośniku po 30 kopiach, własne archiwa — gdy je
usuniesz. Id klucza, którego wymaga kopia, odczytasz z samej kopii, bez klucza (wiersz
`wymagane id kluczy:`):

```bash
sudo sh /opt/oms/aktualizuj.sh sekrety stan --baza /opt/oms/backups/oms-RRRR-MM-DD.sqlite
```

Kopię spod starego klucza odtwarza się tak: w `klucz.env` zostaje bieżący klucz (`OMS_KLUCZ_SEKRETOW`),
a w drugiej linii dopisujesz klucz tej kopii jako `OMS_KLUCZ_SEKRETOW_POPRZEDNI=…`. Przy starcie OMS
przeszyfruje bazę na bieżący klucz; potem linię `…_POPRZEDNI` usuwasz (punkty 4–5 w „Wymiana klucza”).
Działa dla kopii sprzed dowolnej liczby wymian — potrzebny jest tylko klucz o id z tej kopii.

### Czego szyfrowanie nie daje

- Nie chroni przed kimś, kto ma uprawnienia administratora (root) na serwerze albo dostał się do
  działającego OMS-u — taka osoba ma bazę i klucz.
- Kopia całej maszyny albo całego `/opt/oms` zawiera bazę i klucz razem — podział na dwa pliki jej
  nie zabezpiecza.
- Nie szyfruje danych klientów, zamówień, faktur ani etykiet.
- Nie obejmuje poświadczeń wpisanych do `oms.env` (ten plik jest jawny z założenia), kluczy reklam ani
  plików w archiwum próby (`/opt/oms/proba-archiwum`, sekcja 8). Klucze reklam (Meta Ads, Google
  Analytics 4, Google Ads) leżą w plikach w katalogu danych (`/opt/oms/data/reklamy-sekrety`), nie są
  szyfrowane ani objęte dzienną kopią — po odtworzeniu podłącza się je ponownie.
- Nie przywraca ważności tokenu, który dostawca zdążył unieważnić — odtworzona kopia oddaje
  poświadczenia, a nie gwarancję, że Allegro czy KSeF je jeszcze przyjmą.

### OMS nie wstaje przez klucz

OMS sprawdza klucz przy każdym starcie, zanim cokolwiek zmieni w bazie. Brak klucza albo klucz
niepasujący do bazy kończy się odmową startu; OMS nigdy nie tworzy klucza zastępczego. Objaw:
`sudo sh /opt/oms/aktualizuj.sh compose ps` pokazuje `oms` jako `restarting`, a dziennik
(`sudo sh /opt/oms/aktualizuj.sh compose logs --tail 30 oms`) ma linię `Błąd konfiguracji:` z jednym
z komunikatów:

| komunikat | znaczy | co zrobić |
|---|---|---|
| `Brak klucza poświadczeń OMS_KLUCZ_SEKRETOW` | nie ma pliku `klucz.env` albo linia jest pusta | wstaw klucz z menedżera haseł (niżej) |
| `zła postać klucza — oczekiwane 43 znaki` | wklejony klucz jest ucięty albo ma dodatkowy znak | wklej jeszcze raz całą linię |
| `Baza jest zaszyfrowana kluczem o id X, w konfiguracji jest klucz o id Y` | w pliku jest inny klucz | znajdź w menedżerze haseł klucz o id X |
| `Baza z nowszego wydania` albo `nieznaną wersję formatu` | bazę zapisało nowsze wydanie OMS-u | uruchom wydanie, które ją zapisało (`docs/aktualizacja-klienta-v0.md`) |
| `jest uszkodzone` albo `ma niezaszyfrowane poświadczenia` | jeden zapis nie daje się odczytać | `sekrety porzuc` (niżej), potem ta integracja od nowa |

Najpierw zobacz, czego chce baza (działa bez klucza i przy zatrzymanym OMS-ie):

```bash
sudo sh /opt/oms/aktualizuj.sh sekrety stan
```

`wymagane id kluczy:` — id klucza, którego potrzebuje baza; `klucz w konfiguracji: id …` — id klucza
z pliku. Gdy klucz w pliku ma złą postać, `stan` też odmawia — popraw plik.

**Klucz jest w menedżerze haseł.** Wpisz do pliku linię `OMS_KLUCZ_SEKRETOW=…` z menedżera, sprawdź,
dopiero potem uruchom:

```bash
sudo nano /opt/oms/config/klucz.env
sudo chown 10001:10001 /opt/oms/config/klucz.env
sudo chmod 600 /opt/oms/config/klucz.env
sudo sh /opt/oms/aktualizuj.sh sekrety sprawdz
sudo sh /opt/oms/aktualizuj.sh compose up -d
```

`sprawdz` ma skończyć się wierszem `KLUCZ_ZGODNY`. `KLUCZ_NIEZGODNY` — to nie ten klucz; szukaj dalej.

**Klucza nie ma nigdzie.** Poświadczeń zaszyfrowanych utraconym kluczem nie odczyta nikt. Zostaje
jedna droga: nowy klucz i porzucenie nieczytelnych poświadczeń. Zamówienia, faktury, konta i ustawienia
integracji zostają. Znikają hasła i klucze integracji zapisane w panelu, tokeny Allegro i sesja KSeF;
wszyscy logują się od nowa. Jeśli plik `klucz.env` istnieje (z niepasującym kluczem), najpierw odłóż go
pod inną nazwą — nie kasuj, może pasować do którejś kopii:

```bash
sudo mv /opt/oms/config/klucz.env /opt/oms/config/klucz.env.niepasujacy
```

Dalej:

```bash
sudo sh /opt/oms/aktualizuj.sh compose stop oms kopia
sudo sh /opt/oms/aktualizuj.sh sekrety porzuc --nowy-klucz --potwierdz-wszystkie
sudo cat /opt/oms/config/klucz.env
sudo sh /opt/oms/aktualizuj.sh compose up -d
```

Narzędzie najpierw zapisuje nowy klucz (`KLUCZ_UTWORZONY id …`), potem jedną transakcją usuwa
poświadczenia (`PORZUCONE: …`). Nowy klucz zapisz w menedżerze haseł, z id i datą. Potem podłącz
integracje ponownie w panelu i połącz kanały Allegro. Jeśli polecenie przerwało się po
`KLUCZ_UTWORZONY`, powtórz je bez `--nowy-klucz`:
`sudo sh /opt/oms/aktualizuj.sh sekrety porzuc --potwierdz-wszystkie`.

**Klucz jest dobry, ale jedno poświadczenie jest nieczytelne.** Podgląd wypisuje nazwy w postaci
`integracja:<nazwa>`, `kanal:<kanał>`, `ksef` albo `sesja`:

```bash
sudo sh /opt/oms/aktualizuj.sh sekrety porzuc
sudo sh /opt/oms/aktualizuj.sh compose stop oms kopia
sudo sh /opt/oms/aktualizuj.sh sekrety porzuc --potwierdz NAZWA
sudo sh /opt/oms/aktualizuj.sh compose up -d
```

Usuwa tylko poświadczenia wskazanej integracji; jej ustawienia i powiązania zostają. Potem podłącz ją ponownie.

⛔ Nie usuwaj `klucz.env` i nie wpisuj nowego klucza „na próbę”, gdy baza ma zaszyfrowane
poświadczenia. OMS z innym kluczem i tak nie wstanie, a stary klucz bywa jedyną drogą do kopii.

### Polecenia `aktualizuj.sh sekrety`

| polecenie | co robi | OMS |
|---|---|---|
| `sekrety stan [--baza PLIK]` | liczby zapisów (jawne, puste, uszkodzone, pod kluczem o id …), wymagane id kluczy (bez klucza), format danych, czy czeka sprzątanie pliku | może pracować |
| `sekrety sprawdz [--baza PLIK]` | spójność pliku i odszyfrowanie wszystkiego; ostatni wiersz `KLUCZ_ZGODNY` albo `KLUCZ_NIEZGODNY: kopia wymaga id X, podano id Y` (też `BAZA_USZKODZONA`, `POSWIADCZENIA_USZKODZONE`) | może pracować |
| `sekrety klucz-zapewnij` | plik klucza jest — sprawdza go i niczego nie zmienia; nie ma — tworzy nowy klucz, chyba że baza ma zaszyfrowane poświadczenia (wtedy odmowa). Robi to sam `deploy` | może pracować |
| `sekrety porzuc` | podgląd nieczytelnych poświadczeń | może pracować |
| `sekrety porzuc --potwierdz NAZWA…` albo `--potwierdz-wszystkie` | usuwa wskazane poświadczenia | **zatrzymany** |
| `sekrety porzuc --nowy-klucz --potwierdz-wszystkie` | po utracie klucza: nowy klucz i usunięcie nieczytelnych poświadczeń | **zatrzymany** |
| `sekrety odszyfruj` | zamienia poświadczenia z powrotem na jawne — tylko do powrotu na wydanie sprzed szyfrowania; robi to sam `recover` | **zatrzymany** |
| `sekrety sprzataj` | przepakowuje plik bazy po zaszyfrowaniu (niżej) | **zatrzymany** |

Polecenia oznaczone „zatrzymany” przy pracującym OMS-ie kończą się odmową `SEKRETY_OMS_DZIALA`, bez
opcji wymuszenia: OMS mógłby zapisać bazę zaraz po narzędziu. Kolejność: `sudo sh /opt/oms/aktualizuj.sh
compose stop oms kopia`, polecenie, `sudo sh /opt/oms/aktualizuj.sh compose up -d`. Ścieżkę pliku
klucza ustala aktualizator — opcji `--plik` nie podajesz. `--baza` działa tylko przy `stan` i `sprawdz`;
plik spoza `/opt/oms/data` (np. kopia) narzędzie czyta tylko do odczytu. W trakcie niezamkniętej
aktualizacji polecenie używa obrazu nowego wydania i blokady tej aktualizacji. Przerwane polecenie
zapisu zostawia własną blokadę: `status` pokazuje `typ=sekrety`, a `sudo sh /opt/oms/aktualizuj.sh
recover OPERACJA` ją zdejmuje. Baza jest wtedy w stanie sprzed polecenia albo po nim, nigdy w połowie.

### Sprzątanie pliku bazy

Po pierwszym zaszyfrowaniu i po wymianie klucza stare wartości zostają w wolnych miejscach pliku
bazy. OMS przepakowuje plik przy starcie (baza 1 GB: 12,6 s, pomiar 17.11.2026) i potrzebuje na to
wolnego miejsca do dwóch rozmiarów bazy. Dzienne kopie wolnych miejsc nie przenoszą; kopia całego
pliku albo katalogu danych (np. migawka maszyny) — tak, dopóki sprzątanie się nie uda.

Gdy brakuje miejsca albo plik jest zajęty, OMS startuje normalnie, a `/health` ma uwagę „Sprzątanie
pliku bazy po zaszyfrowaniu poświadczeń nie jest zakończone”. Zwolnij miejsce — sprzątanie powtórzy
się przy następnym starcie. Od razu:

```bash
sudo sh /opt/oms/aktualizuj.sh compose stop oms kopia
sudo sh /opt/oms/aktualizuj.sh sekrety sprzataj
sudo sh /opt/oms/aktualizuj.sh compose up -d
```

Wynik `SPRZATNIETE` albo `NIC_DO_SPRZATANIA` — gotowe; `ODLOZONE: …` podaje przyczynę.

### Wymiana klucza

Wymieniasz klucz, gdy mógł go zobaczyć ktoś niepowołany albo gdy odchodzi osoba, która go znała.
OMS pracuje w trakcie punktów 1–2.

1. Sprawdź stan i zanotuj id obecnego klucza (`klucz w konfiguracji: id …`). Wiersz nie może mieć
   dopisku `poprzedni:` — wtedy poprzednia wymiana nie jest skończona (dokończ ją punktami 4–5). Obecny
   klucz musi być w menedżerze haseł z id i datą.

   ```bash
   sudo sh /opt/oms/aktualizuj.sh sekrety stan
   ```

2. Wpisz nowy klucz do pliku; obecny przechodzi do drugiej linii jako `OMS_KLUCZ_SEKRETOW_POPRZEDNI`.
   Polecenie wypisuje tylko `gotowe` — bez tego słowa plik się nie zmienił:

   ```bash
   sudo sh -c 'cd /opt/oms/config && k=$(openssl rand -base64 32 | tr "/+" "_-" | tr -d "=") && [ ${#k} -eq 43 ] && umask 077 && { echo "OMS_KLUCZ_SEKRETOW=$k"; sed -n "s/^OMS_KLUCZ_SEKRETOW=/OMS_KLUCZ_SEKRETOW_POPRZEDNI=/p" klucz.env; } > klucz.env.nowy && chown 10001:10001 klucz.env.nowy && mv klucz.env.nowy klucz.env && echo gotowe'
   ```

3. Uruchom OMS ponownie. Przy starcie przeszyfruje poświadczenia na nowy klucz (w dzienniku linia
   `poświadczenia: zaszyfrowano kluczem …`). Nikt nie jest wylogowywany.

   ```bash
   sudo sh /opt/oms/aktualizuj.sh compose up -d --force-recreate oms
   ```

4. Sprawdź: wszystkie zapisy są `pod kluczem` nowego id, `poprzednim: 0`, `sprzątanie pliku: nie czeka`.
   Nowy klucz (pierwsza linia pliku) zapisz w menedżerze haseł z id i datą. Starego wpisu nie kasuj —
   otwiera kopie sprzed wymiany.

   ```bash
   sudo sh /opt/oms/aktualizuj.sh sekrety stan
   sudo cat /opt/oms/config/klucz.env
   ```

5. Usuń linię poprzedniego klucza i uruchom OMS ponownie:

   ```bash
   sudo sed -i '/^OMS_KLUCZ_SEKRETOW_POPRZEDNI=/d' /opt/oms/config/klucz.env
   sudo chown 10001:10001 /opt/oms/config/klucz.env
   sudo chmod 600 /opt/oms/config/klucz.env
   sudo sh /opt/oms/aktualizuj.sh compose up -d --force-recreate oms
   ```

**Wymiana klucza a odwołanie poświadczeń — to dwa różne środki.** Wymiana klucza nie odbiera dostępu
komuś, kto już ma bazę razem z kluczem albo odczytane tokeny: dostawcy nadal przyjmują te same
poświadczenia. Po wycieku bazy z kluczem (np. kopia całego serwera w obcych rękach) odwołaj
poświadczenia u dostawców — Allegro, KSeF, sklep, kurierzy, program do faktur, poczta — i zapisz nowe
w panelu. Sama wymiana klucza wystarcza, gdy wyciekł tylko klucz, bez bazy; stare kopie ten stary klucz
nadal otwiera, dopóki je trzymasz.

## Gdy coś nie działa

### Administrator zapomniał hasła

Właściciel serwera z dostępem SSH uruchamia `sudo sh /opt/oms/aktualizuj.sh link-hasla LOGIN`.
Bez `LOGIN` polecenie wypisze same loginy administratorów. Konto musi być włączone.
Otwórz wypisany link w przeglądarce i ustaw nowe hasło; gdy podano samą ścieżkę, doklej ją do adresu panelu.
Link działa raz przez 48 godzin i unieważnia wcześniejsze linki konta — traktuj go jak hasło, nie przesyłaj w zgłoszeniu.
Polecenie zapisuje w dzienniku kont ślad „konsola serwera”, bez tokenu; samo nie zmienia hasła ani nie wysyła maila.

```bash
cd ~
sudo sh -c 'sh "/opt/oms/releases/$(cat /opt/oms/update-state/biezace)/deploy/klient/diagnostyka.sh"'
```

Skrypt zapisuje w katalogu domowym plik `oms-diagnostyka-….txt`: wersję, stan kontenerów,
`/health`, wolne miejsce, wiek ostatniej kopii, ostatnie 200 linii dziennika, wersje systemu
i Dockera. Hasła, klucze i inne wartości z `/opt/oms/config` są w nim zastąpione przez `***`,
a w dzienniku także adresy e-mail, numery telefonów i tokeny. Imion i adresów klientów
w treści dziennika skrypt nie rozpozna — przejrzyj plik, zanim go odeślesz.

## Czego ta instrukcja nie obejmuje

- KSeF i wysyłki maili (SMTP).
- Aktualizacji do nowego wydania — `docs/aktualizacja-klienta-v0.md`.
- Procesorów ARM (np. Raspberry Pi): obraz nie był na nich sprawdzony.
