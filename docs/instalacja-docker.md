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

Jeśli polecenie skończy się innym błędem `INSTALACJA_…`, zapisz go, wyczyść oba katalogi
(także pliki ukryte) i powtórz krok 5:
`sudo find /opt/oms/data /opt/oms/config -mindepth 1 -delete`.
To kasuje tylko próbę — przy pierwszej instalacji nie ma tam innych danych.

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
internetu.** Dostęp spoza biura (VPN, HTTPS) to osobny krok.

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
W Ustawieniach → Konta załóż konta imienne dla siebie i pracowników — konto `administrator` zostaw
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
kopii (jeśli jest) kopie próby znikają same po 30 kopiach pracy. Archiwum próby na dysku skasuj po
`accept`, gdy przestanie być potrzebne: `sudo rm -r /opt/oms/proba-archiwum` — razem z nim znikają
bazy pracy odłożone przez `recover` (`produkcja-odlozona-*`).

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

**inFakt — też z ekranu:** Ustawienia → Integracje → Faktury → inFakt (klucz API, „Sprawdź połączenie”).
Pierwsze podłączenie z ekranu włącza zakładkę FAKTURY po ponownym uruchomieniu OMS-u
(`sudo sh /opt/oms/aktualizuj.sh compose restart oms` — klucz leży w bazie, więc sam restart wystarcza);
późniejsza zmiana klucza działa od razu. Wtedy linii `INFAKT_API_KEY` nie wpisuj — gdy jest w pliku, wygrywa
nad ekranem. Adres API (`INFAKT_API_URL`) i archiwum sprzedaży (`INFAKT_ARCHIWUM`) ustawia się tylko w pliku.

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
Integracje → kanał → połącz; OMS pokazuje kod i adres. Otwórz go w przeglądarce **zalogowanej
na konto Allegro tego kanału** — wiązanie dotyczy konta zalogowanego w przeglądarce, nie wpisanego
w konfiguracji. Do połączenia `zdrowie` pokazuje alarm „Kanał allegro_pilot nie jest połączony
z Allegro…” — to oczekiwane; po połączeniu znika. Granica raportu tym samym poleceniem co przy
sklepie (`produkcja-pierwszy-start.mjs --granice`), zaraz po `compose up -d`.

**Kurier DPD — najprościej z ekranu:** Ustawienia → Integracje → Kurierzy → DPD Polska (login, numer
klienta i hasło od DPD, typ etykiety, przycisk „Sprawdź połączenie”). Krok po kroku, ze szkicem maila
do DPD: `docs/kurier-dpd.md`. Wtedy linii `DPD_URL`…`DPD_INFO_CHANNEL` niżej nie wpisuj — gdy są w pliku,
wygrywają nad ekranem.

**Kurier InPost — też z ekranu:** Ustawienia → Integracje → Kurierzy → InPost (paczkomaty) (token API
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
zamówienia — ustawia się w Ustawienia → Integracje → Poczta albo w pliku (`SMTP_…`, `MAIL_FROM`); krok po
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

Odtworzenie po awarii dysku (nieprzećwiczone na sprzęcie): kroki 1–4 na nowym dysku; zamiast
kroku 5 skopiuj z nośnika najnowszą `oms-RRRR-MM-DD.sqlite` jako `/opt/oms/data/oms.sqlite` oraz
katalogi `pliki/etykiety` i `pliki/proformy` do `/opt/oms/data/`, wykonaj
`sudo chown -R 10001:10001 /opt/oms/data`, wstaw `oms.env` do `/opt/oms/config` z miejsca, w którym
go przechowujesz (na nośniku go nie ma — są w nim hasła), potem kroki 6–7. Dlatego zaraz po
instalacji zapisz zawartość `/opt/oms/config/oms.env` w menedżerze haseł (tak jak hasło administratora).

Serwer wirtualny (VPS) w kontenerze LXC/OpenVZ bywa bez współdzielonych punktów montowania
(`findmnt -o PROPAGATION /` nie wypisuje `shared`) — wtedy kontenery z nośnikiem nie wystartują;
na takim serwerze kopię poza dyskiem robi się inaczej (np. pobieranie kopii przez sieć), poza tą instrukcją.

## Gdy coś nie działa

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
