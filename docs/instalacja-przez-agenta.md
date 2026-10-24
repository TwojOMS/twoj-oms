# Instalacja Twój OMS przez agenta AI

Scenariusz dla agenta (Claude Code, Codex lub innego), który ma postawić OMS dla człowieka. Człowiek
zwykle nie jest programistą: mów krótko, po ludzku, bez żargonu, a decyzje techniczne podejmuj sam.
Ważne decyzje i wszystko, co ma skutki poza komputerem, zostaw człowiekowi (lista w sekcji „Stop”).

Człowiek mógł dać Ci tylko link do tego pliku i pusty folder. Wtedy nie masz jeszcze repozytorium ani pewności,
że na komputerze jest Git. Czego brakuje, sprawdzasz i doinstalowujesz sam, po zgodzie człowieka (sekcja 1).
Gdy repozytorium jest już na dysku, przeczytaj [AGENTS.md](../AGENTS.md), zwłaszcza sekcję „Granice”, zanim
wykonasz cokolwiek na serwerze.

## 0. Zapytaj, zanim zaczniesz (jedna wiadomość, trzy pytania)

1. **Gdzie ma działać panel?** Własny serwer lub mały komputer z Linuksem (zalecane), VPS, czy tylko ten komputer na próbę.
2. **Czy chcesz najpierw obejrzeć panel na przykładowych danych, czy od razu podłączać sklepy?**
   Domyślnie zaczynasz od próby bez kluczy (ścieżka A) — niczego nie psuje i trwa kilka minut.
3. **Co chcesz podłączyć** (Allegro, WooCommerce, inFakt, DPD, InPost…)? To tylko do zapamiętania;
   integracje dodajesz dopiero po ścieżce A i B, pojedynczo.

Wybór ścieżki: panel ma działać na serwerze z Linuksem, do którego masz SSH (albo człowiek wkleja polecenia) →
od razu **ścieżka B**; jej sekcja 5 sama zakłada próbę z danymi DEMO, więc ścieżki A wtedy nie robisz.
Ścieżka A jest dla próby na komputerze, przy którym człowiek siedzi.

## 1. Przygotuj ten komputer: sprawdź, zapytaj, doinstaluj

Najpierw tylko sprawdzasz, niczego nie instalujesz:

| Co | Sprawdzenie | Kiedy potrzebne |
|---|---|---|
| system i powłoka | Windows (PowerShell), macOS, Linux | zawsze |
| Git | `git --version` | zawsze: pobranie repozytorium |
| Node.js 24 lub nowszy | `node --version` | ścieżka A; w ścieżce B do zbudowania paczki (na tym komputerze albo na serwerze) |
| klient SSH | `ssh -V` | ścieżka B, gdy łączysz się z serwerem sam (sekcja 2) |

Potem jedną wiadomością powiedz człowiekowi, co już jest, czego brakuje, co zainstalujesz i skąd, i poczekaj na „tak”.
Instaluj tylko to, czego brakuje, i tylko z tych źródeł. Nie wyłączaj antywirusa ani zapory, nie zmieniaj ustawień systemu.

| System | Git | Node.js 24 lub nowszy |
|---|---|---|
| Windows 10/11 | `winget install --id Git.Git -e` (bez winget: instalator z git-scm.com) | `winget install --id OpenJS.NodeJS.LTS -e` (bez winget: instalator LTS z nodejs.org) |
| macOS | `git --version` sam proponuje instalację narzędzi Xcode | instalator LTS z nodejs.org albo `brew install node` |
| Debian, Ubuntu | `sudo apt-get install -y git` | z nodejs.org; pakiet `nodejs` z Debiana 13 i Ubuntu 24.04 to wersja 20, za stara |

- Zgodę systemu daje człowiek: okno Windows „Czy zezwolić…”, okno instalatora na macOS, hasło `sudo`. Uprzedź go,
  że coś takiego zobaczy. Polecenia z `sudo` na tym komputerze daj mu do wklejenia w jego własnym terminalu:
  twój terminal nie jest interaktywny i hasła nie wpiszesz.
- Po instalacji nowy program często nie jest widoczny w bieżącej sesji agenta, bo zmienna PATH jest ta sama co
  przy starcie. Sprawdź go pełną ścieżką (Windows: `C:\Program Files\Git\cmd\git.exe`, `C:\Program Files\nodejs\node.exe`).
  Jeśli dalsze polecenia go nie widzą, poproś człowieka, żeby zamknął agenta i otworzył go ponownie w tym samym
  folderze, wznawiając rozmowę (Claude Code: `claude --continue`, Codex: `codex resume`).
- Wersję sprawdź po instalacji jeszcze raz (`git --version`, `node --version` — Node co najmniej v24).

Repozytorium: w pustym folderze `git clone https://github.com/TwojOMS/twoj-oms.git .`, w niepustym
`git clone https://github.com/TwojOMS/twoj-oms.git twoj-oms` i dalej pracujesz w `twoj-oms`. Niczego z folderu
człowieka nie kasuj. Teraz przeczytaj [AGENTS.md](../AGENTS.md).

## 2. Dostęp do serwera (ścieżka B)

Hasła SSH ani hasła `sudo` nie wpiszesz, bo twój terminal nie jest interaktywny. Nie proś o nie na czacie.

Polecenie na serwer dawaj człowiekowi jako **jedną linię** do jego terminala na tym komputerze:
`ssh -t LOGIN@ADRES "polecenie"`. Nigdy w dwóch krokach typu „zaloguj się, potem wpisz”: człowiek wklei drugą
linię w tym samym oknie Windowsa i odpowie mu `sudo` Windowsa („Sudo is disabled on this machine”). W PowerShellu 5.1
dawaj na zewnątrz cudzysłów, a w środku tylko apostrofy. PowerShell zdejmuje wewnętrzne cudzysłowy, więc
`'echo "a (b)"'` dociera do serwera jako `echo a (b)` i bash zgłasza błąd składni.

1. Zapytaj o adres serwera i login. Sprawdź: `ssh -o BatchMode=yes LOGIN@ADRES true`. Działa: idź do punktu 3.
   Przy pierwszym połączeniu SSH nie zna odcisku serwera i kończy się `Host key verification failed`. Pobierz odcisk
   (`ssh-keyscan -t ed25519 ADRES`) i pokaż człowiekowi jego skrót (`ssh-keygen -lf`, wiersz `SHA256:…`). Jeśli dostawca
   VPS podaje odcisk w panelu albo człowiek może go odczytać w konsoli serwera w panelu dostawcy
   (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), niech porówna. Zwykle nikt mu go nie dał. Wtedy powiedz to wprost,
   a po jego „tak” dopisz odcisk do `~/.ssh/known_hosts`. Dzięki temu terminal człowieka też nie zapyta o odcisk.
2. Serwer chce hasła: zaproponuj klucz SSH. Na tym komputerze utwórz go bez hasła:
   `ssh-keygen -t ed25519 -f ~/.ssh/twojoms -N "" -C twojoms-agent` (katalog `.ssh` załóż, jeśli go nie ma).
   PowerShell 5.1 gubi pusty argument `""` i ssh-keygen odpowiada „Too many arguments” — tam uruchom to przez
   `cmd /c`, z `%USERPROFILE%\.ssh\twojoms` zamiast `~/.ssh/twojoms`. Sprawdź, że powstały pliki `twojoms` i `twojoms.pub`.
   Klucz publiczny trafia na serwer raz, a hasło wpisuje człowiek. Najprościej w panelu dostawcy VPS (dodanie klucza SSH),
   inaczej człowiek wkleja w swoim terminalu:
   - Windows (PowerShell): `type $env:USERPROFILE\.ssh\twojoms.pub | ssh LOGIN@ADRES "mkdir -p ~/.ssh && chmod 700 ~/.ssh && tr -d '\r' | sed '1s/^\xef\xbb\xbf//' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"`.
     `tr` i `sed` są potrzebne: PowerShell w konsoli UTF-8 dokleja na początku niewidoczny znak (BOM). Wtedy serwer
     odrzuca klucz, choć polecenie kończy się bez błędu.
   - macOS, Linux: `ssh-copy-id -i ~/.ssh/twojoms.pub LOGIN@ADRES`

   Potem sprawdź punkt 1 jeszcze raz z `-i ~/.ssh/twojoms` — ma przejść bez pytania o hasło. Dalej łączysz się
   z tym kluczem. Powiedz człowiekowi, że kto ma ten plik, ten wchodzi na serwer.
3. `sudo`: sprawdź `ssh … sudo -n true`. Działa (root albo VPS z `sudo` bez hasła, częste w obrazach chmurowych):
   pracujesz sam. Gdy logujesz się jako root, a `sudo` nie ma, zainstaluj go (`apt-get install -y sudo`): polecenia
   w instrukcji mają `sudo`. Gdy `sudo` żąda hasła, człowiek wybiera jedną z dwóch dróg:
   - **polecenia do wklejenia**: człowiek loguje się na serwer (`ssh LOGIN@ADRES`), a ty czekasz, aż potwierdzi, że
     widzi znak zachęty serwera (`LOGIN@nazwa:~$`). Dopiero wtedy dajesz mu bloki, on wkleja je w tej sesji i odsyła
     wynik. Wolniej, ale na serwerze nic się nie zmienia;
   - **tymczasowe `sudo` bez hasła na czas instalacji**: człowiek wkleja w PowerShellu na tym komputerze jedną linię
     (LOGIN i ADRES podstawiasz ty) i wpisuje hasło do serwera oraz hasło `sudo`:
     `ssh -t LOGIN@ADRES "echo 'LOGIN ALL=(ALL) NOPASSWD:ALL' > /tmp/twojoms-sudo && sudo visudo -cf /tmp/twojoms-sudo && sudo install -m 0440 -o root -g root /tmp/twojoms-sudo /etc/sudoers.d/twojoms-instalacja && rm /tmp/twojoms-sudo"`.
     `visudo -cf` sprawdza linię, zanim cokolwiek trafi do `/etc/sudoers.d`, więc literówka nie zepsuje `sudo`.
     Po instalacji usuwasz ten plik, ale dopiero po odczytaniu hasła panelu (sekcja „Po instalacji”).
4. Bez SSH (człowiek nie chce albo nie może): wypisuj gotowe polecenia (bash) do wklejenia po kolei i proś o wynik
   każdego bloku.

## 3. Klucze i hasła wpisuje człowiek

- Nie proś o klucze, tokeny ani hasła na czacie: to, co człowiek wklei agentowi, dostaje też dostawca agenta.
  Nie wypisuj ich na ekran ani do logów.
- Poczta, inFakt, DPD, InPost, token KSeF (faktury kosztowe), klucz GUS: człowiek wpisuje je w panelu, w
  Ustawieniach → Sklepy i usługi (`/ustawienia/integracje`). NIP, BDO, rachunek i adres firmy wpisuje w Ustawieniach
  → Dane firmy. Ty prowadzisz go po ekranie (`docs/kurier-dpd.md`, `docs/kurier-inpost.md`, `docs/poczta-smtp.md`).
- Allegro i WooCommerce ustawia się tylko w pliku `/opt/oms/config/oms.env`. Linie bez tajemnic wpisujesz sam
  (`OMS_KANALY`, adres sklepu, `…_OD`, `…_MAPOWANIE`, `…_USER_AGENT`), a tajne zostawiasz puste (`…_CK=`, `…_CS=`,
  `…_CLIENT_ID=`, `…_CLIENT_SECRET=`). Człowiekowi dajesz jedno polecenie do jego terminala:
  `ssh -t LOGIN@ADRES sudo nano /opt/oms/config/oms.env` i mówisz, w której linii co wkleić (wklejanie: prawy
  przycisk myszy; zapis: Ctrl+O, Enter; wyjście: Ctrl+X). Potem sprawdzasz, że linie są wypełnione — bez wypisywania wartości
  (np. `grep -c '_CS=.' …`).
- Jeśli człowiek mimo to wklei klucz na czat: zapisz go tylko w pliku konfiguracji, nie powtarzaj go i powiedz,
  że następnym razem lepiej wpisać go samemu.

## Ścieżka A — próba lokalna (bez Dockera, bez kluczy)

Wymaga Node.js 24+ na tym komputerze (sekcja 1).

```bash
node --version                      # musi być v24 lub nowszy; jeśli nie — sekcja 1
npm ci
node scripts/instalacja-demo.mjs --katalog "$PWD/oms-demo" --port 39151
node scripts/instalacja-otworz.mjs --katalog "$PWD/oms-demo" --port 39151
```

- `--katalog` musi być ścieżką bezwzględną — przy względnej skrypt kończy się samym `INSTALACJA_DEMO_ODMOWA`.
- Ostatnie polecenie uruchamia panel na `127.0.0.1:39151` i działa, dopóki go nie przerwiesz (Ctrl+C) —
  uruchom je w tle albo w osobnym terminalu.
- Login i hasło administratora są w `./oms-demo/administrator-proby.env`. **Nie wypisuj hasła w odpowiedzi
  na czacie**; powiedz człowiekowi, w którym pliku jest, i że ma zapisać je w menedżerze haseł.
- Zweryfikuj: `GET http://127.0.0.1:39151/health` odpowiada, `/login` się ładuje, po zalogowaniu widać zamówienia
  DEMO-001…003. Logując się curlem, dodaj nagłówek `-H "Origin: http://ADRES:PORT"` (ten sam adres co w URL) —
  bez `Origin`/`Referer` ochrona CSRF odpowiada 403 i wygląda to jak awaria. Alarmy kanałów w `/health` bez kluczy integracji są w tej próbie normalne.
- Katalog i port muszą być puste/wolne. Przy odmowie (`INSTALACJA_ODMOWA_NADPISANIA`) wybierz nowy katalog —
  nie kasuj cudzego.

Szczegóły i ograniczenia: [instalacja-klienta.md](instalacja-klienta.md).

## Ścieżka B — serwer z Linuksem i Dockerem

Przeprowadź człowieka przez [instalacja-docker.md](instalacja-docker.md) w kolejności sekcji 1–7. Co z tego robisz
sam, jeśli masz dostęp do serwera (SSH, sekcja 2 wyżej):

1. Sprawdź system i uprawnienia: Debian/Ubuntu, `sudo`, wolne miejsce (min. 16 GB dysku, 2 GB RAM). Działający OMS
   zajmuje ok. 140 MB pamięci; przy kilkudziesięciu tysiącach zamówień w bazie po starcie nawet ok. 1 GB, wtedy lepiej 4 GB.
2. Zainstaluj Dockera z oficjalnego repozytorium (sekcja 1).
3. Zbuduj paczkę z klona repo (początek instrukcji) i rozpakuj ją według sekcji 3.
4. `docker compose build`, `docker compose run --rm instalacja`, `docker compose up -d` (sekcje 4–6).
5. Zweryfikuj `docker compose ps` (stan `healthy`) i `/health`. Dostęp z innego komputera: sekcja 7.

Gdy wysyłasz polecenia skryptem przez `ssh LOGIN@ADRES 'bash -s' < skrypt`, polecenie, które czyta wejście, zjada
resztę skryptu. Robi to `docker compose run`: w teście 24.10 start panelu się nie wykonał, a skrypt zakończył się
kodem 0. Dawaj takim poleceniom `</dev/null` albo wgraj skrypt plikiem (`scp`) i uruchom go `bash plik`. Po skrypcie
sprawdzaj `docker compose ps`, nie kod wyjścia.

Jeśli nie masz dostępu do serwera, nie zgaduj — wypisz człowiekowi gotowe polecenia (bash) do wklejenia
po kolei i poproś o wynik każdego bloku.

## Stop — zatrzymaj się i zapytaj człowieka

Zanim to zrobisz, wyjaśnij w jednym zdaniu, co się stanie, i poczekaj na wyraźne „tak”:

- instalacja programów na komputerze człowieka (sekcja 1), klucz SSH i tymczasowe `sudo` bez hasła na serwerze (sekcja 2);
- przejście z próby na **pracę** (sekcja 8 w `instalacja-docker.md`) — od tej chwili system zakłada prawdziwe dane firmy;
- `aktualizuj.sh accept` (nieodwracalny — człowiek sam loguje się nowym kontem i potwierdza dane firmy)
  oraz `recover … --porzuc-prace`;
- wpisanie **prawdziwych danych firmy** (NIP, numer rachunku, BDO) i **kluczy integracji** — wpisuje je człowiek,
  w panelu albo w pliku konfiguracji na serwerze (`/opt/oms/config/oms.env`, katalog 0700, plik 0600), nigdy w repo (sekcja 3);
- jakiekolwiek wystawienie faktury, nadanie paczki, wysyłka do KSeF, wiadomość do klienta;
- udostępnienie panelu poza siecią lokalną (router, VPN, HTTPS);
- usunięcie czegokolwiek z `/opt/oms/data`, `/opt/oms/backups`.

## Po instalacji

1. **Hasło administratora — zanim cokolwiek posprzątasz.** W próbie lokalnej powiedz, w którym pliku jest. Na serwerze
   daj człowiekowi jedną linię do jego terminala: `ssh -t LOGIN@ADRES "sudo cat /opt/oms/config/administrator-proby.env"`
   (po przejściu na pracę: `administrator.env`). Poczekaj, aż zaloguje się do panelu i zapisze hasło w menedżerze
   haseł. Dopiero potem sprzątasz dostęp (punkt 4). W teście 24.10 agent usunął `sudo` za wcześnie i człowiek utknął.
2. **Podsumowanie.** Każdy z tych punktów ma się w nim znaleźć — w teście 24.10 zabrakło dwóch ostatnich:
   - adres panelu i gdzie leży hasło,
   - co jeszcze nie jest podłączone i czego brakuje (np. kopii poza dyskiem — `docs/instalacja-docker.md`, „Codzienna obsługa”),
   - jak zatrzymać i uruchomić panel, jako jednolinijkowce do terminala człowieka:
     `ssh -t LOGIN@ADRES "sudo sh /opt/oms/aktualizuj.sh compose down"` i
     `ssh -t LOGIN@ADRES "sudo sh /opt/oms/aktualizuj.sh compose up -d"`,
   - wersja wydania i data instalacji do notatek człowieka (nie do repo): wiersz `biezace:` z
     `sudo sh /opt/oms/aktualizuj.sh status` — odczytaj go, zanim usuniesz tymczasowe `sudo`. W próbie lokalnej
     `git rev-parse --short HEAD`.
3. Zaproponuj **następny jeden krok**: pierwsza integracja w kolejności z sekcji 9 `instalacja-docker.md`
   (inFakt → sklep WooCommerce → Allegro → kurierzy). Po każdej integracji test z prawdziwym, ale niskoryzykownym zamówieniem.
   Poczta wychodząca (zaproszenia do kont, linki do hasła) jest osobnym, niezależnym krokiem: `docs/poczta-smtp.md`.
4. Posprzątaj dostęp z sekcji 2: tymczasowe `sudo` bez hasła usuń (`sudo rm /etc/sudoers.d/twojoms-instalacja`,
   potem `sudo -n true` ma odmówić, chyba że `sudo` bez hasła było tam od początku). Powiedz człowiekowi, gdzie leży klucz SSH (`~/.ssh/twojoms`) i jak odciąć
   agentowi serwer: usunąć z `~/.ssh/authorized_keys` na serwerze linię kończącą się na `twojoms-agent` albo klucz
   w panelu dostawcy VPS.

## Gdy coś nie działa

- Błędy `INSTALACJA_…` — komunikat mówi, co zrobić; nie ponawiaj w katalogu z częściowymi danymi.
- Kontener nie jest `healthy` — `sudo docker compose logs --tail=100 oms`, `deploy/klient/diagnostyka.sh`.
- Port zajęty — wybierz inny, zapisz który.
- Wynik, którego nie rozumiesz: nie ukrywaj go. Pokaż człowiekowi dokładny komunikat i powiedz, czego nie wiesz.
