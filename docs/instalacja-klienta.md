# Instalacja Twój OMS — próba lokalna bez Dockera

**Serwer z Linuksem i Dockerem (zalecane):** instrukcja kopiuj-wklej od czystego Debiana do zalogowania z innego komputera jest w [docs/instalacja-docker.md](instalacja-docker.md). Poniżej — próba bez Dockera, na samym Node.

Ta instrukcja prowadzi przez lokalną próbę bez połączeń z Allegro, WooCommerce, kurierami, inFaktem, KSeF i pocztą. Próba potwierdza tylko start aplikacji, bazę, konto administratora, restart oraz kopię SQLite. Nie potwierdza gotowości żadnej integracji ani pierwszego nadania.

## Katalogi

Trzymaj program w osobnym katalogu wydania, a konfigurację i dane poza nim. Osobny katalog próby zawiera `proba.env`, `oms.sqlite`, `proformy/`, `etykiety/` oraz `backup-proba.sqlite`. Docelowa produkcja wymaga innego, pustego katalogu danych i osobnego pliku konfiguracji. Bazy próby nie przenosi się do produkcji. Kopie przenieś po sprawdzeniu na osobny, kontrolowany nośnik. Nie zapisuj ich w repozytorium ani w katalogu programu.

## Próba lokalna

Wymagany jest Node.js 24 i zainstalowane zależności (`npm ci`) w katalogu programu. Archiwum nie zawiera zależności: `npm ci` wymaga dostępu do rejestru npm albo kompletnego cache dla tego systemu. „Próba offline” oznacza tutaj brak połączeń z integracjami; paczka nie jest samowystarczalnym instalatorem na maszynę bez internetu. W PowerShell uruchom przygotowanie z nieużywanym lokalnym portem i pustym katalogiem instalacji:

```powershell
node scripts/instalacja-przygotuj.mjs --katalog C:/OMS-proba --port 39150
node scripts/instalacja-proba.mjs --katalog C:/OMS-proba --port 39150
```

Pierwsza komenda działa tylko na pustym katalogu i generuje losowe, lokalne hasło serwisowe w `proba.env`; nie pokazuje go na ekranie. Druga nasłuchuje wyłącznie na `127.0.0.1`, sprawdza `GET /health`, tworzy pierwsze konto administratora przez panel, restartuje proces, wykonuje `VACUUM INTO`, sprawdza `integrity_check`, odtwarza kopię do osobnego katalogu `odtworzenie/` i ponownie loguje administratora. Dane konta próby trafiają wyłącznie do pliku `administrator-proby.env` z trybem pliku 0600 (ochrona ACL Windows jest opisana poniżej). Zachowaj dane do logowania w menedżerze haseł przed usunięciem pliku. Powtórne przygotowanie katalogu z dowolnym plikiem albo próba uruchomienia wobec istniejącej bazy/WAL/SHM celowo kończy się odmową.

Po udanej próbie otwórz zachowany panel poniższą komendą, wejdź w przeglądarce na `http://127.0.0.1:39150/login` i zaloguj się danymi z lokalnego `administrator-proby.env`. Helper używa wyłącznie konfiguracji próby i adresu loopback. Zatrzymaj go przez Ctrl+C. Nie używaj danych próby w produkcji.

```powershell
node scripts/instalacja-otworz.mjs --katalog C:/OMS-proba --port 39150
```

Plikowy tryb `0600` chroni na POSIX; Windows ACL go nie zastępuje. Operator musi ograniczyć dostęp ACL do całego katalogu instalacji, zanim zapisze w nim konfigurację lub kopie. Dane do konta przechowaj w swoim menedżerze haseł, zanim usuniesz plik próby.

`/health` z próbą bez integracji może zgłaszać alarmy kanałów lub usług. Wynik próby oznacza gotowość HTTP i bazy, nie połączenie z usługami zewnętrznymi.

## Demo z wygenerowanymi zamówieniami

Jeśli chcesz obejrzeć zamówienia zamiast pustej listy, wybierz osobny, nowy katalog demo. Poniższa komenda sama wykonuje przygotowanie i próbę instalacji, tworzy administratora oraz trzy zamówienia DEMO-001, DEMO-002 i DEMO-003 z wymyślonymi osobami i produktami. Nie wykonuj wcześniej przygotowania tego katalogu: demo celowo odmawia pracy w każdym niepustym katalogu i przy dowiązaniach w ścieżce.

```powershell
node scripts/instalacja-demo.mjs --katalog C:/OMS-demo --port 39151
node scripts/instalacja-otworz.mjs --katalog C:/OMS-demo --port 39151
```

Po zakończeniu pierwszej komendy uruchom drugą, wejdź na http://127.0.0.1:39151/login i użyj danych z lokalnego administrator-proby.env w katalogu demo. Zobaczysz trzy zmyślone zamówienia, różne stany oraz produkty DEMO-SKU. Panel zatrzymaj Ctrl+C. Obowiązują te same wymagania Node, zależności npm i ograniczenia dostępu do katalogu co przy pustej próbie.

Kopia backup-proba.sqlite i katalog odtworzenie/ pochodzą z próby pustej bazy. Osobna backup-demo.sqlite oraz odtworzenie-demo/oms.sqlite zawierają wygenerowane zamówienia i administratora; generator sprawdza integralność kopii. Testy odbiorowe dodatkowo logują administratora i otwierają listę oraz szczegóły także po odtworzeniu danych demo. Nie zastępuj tym próby odtworzenia przyszłej bazy produkcyjnej.

Po nieudanym demo zachowaj jego wynik i użyj nowego pustego katalogu oraz wolnego portu. Nie ponawiaj generatora w katalogu z danymi; celowa odmowa chroni pozostałości próby. Przed ewentualnym ręcznym usunięciem sprawdź pełną ścieżkę i upewnij się, że jest to wyłącznie własne demo.

Demo kończy działanie po utworzeniu danych; nie instaluje usługi systemowej. Dzieci przygotowania i próby otrzymują pusty zestaw zmiennych środowiska, a konfiguracja integracji pochodzi wyłącznie z własnej próby. Dane demo i jego konto pozostają oddzielone od produkcji. Kontrola ścieżek i odmowa nadpisania nie zastępują ochrony dostępu ACL i nie są dowodem odporności na równoległą podmianę plików przez lokalnego administratora.

## Docelowa VM Linux — przygotowanie, nie odbiór wdrożenia

Na VM trzymaj program w `/opt/oms/program`, dane próby w `/opt/oms/proba`, a późniejsze dane produkcji w osobnym `/opt/oms/dane`. Po skopiowaniu paczki próbnej oraz instalacji Node 24 użytkownik usługi może wykonać:

```sh
install -d -m 0700 /opt/oms/proba
cd /opt/oms/program
npm ci --omit=dev
node scripts/instalacja-przygotuj.mjs --katalog /opt/oms/proba --port 3001
node scripts/instalacja-proba.mjs --katalog /opt/oms/proba --port 3001
```

To nadal jest tylko próba Node na loopback. Kontener Docker (wolumeny, użytkownik plików, restart, kopia) ma własną, przećwiczoną instrukcję: docs/instalacja-docker.md. Reverse proxy i HTTPS wymagają osobnego odbioru.

## Dane firmy i integracje

**W Dockerze** przejście na pracę i dodawanie integracji po kolei opisuje [docs/instalacja-docker.md](instalacja-docker.md), sekcje 8–9 (`aktualizuj.sh produkcja`, PRZ-062). Poniżej — zasady dla instalacji bez Dockera.

Ta paczka nie zawiera procedury uruchomienia produkcyjnego. `produkcja.env.example` jest szablonem do przyszłego, osobno odebranego wdrożenia. Wymaga własnego NIP, rachunku, dostępu serwisowego oraz bezwzględnych ścieżek bazy, proform i etykiet w innym, pustym katalogu. Nie używaj katalogu programu, bazy ani danych konta próby. Sam zapis pliku `produkcja.env` nie uruchamia aplikacji i nie ładuje konfiguracji. Puste dane prawne, katalog proform i hasło zatrzymują start.

Przy odbiorze reverse proxy trzeba wskazać jego konkretne adresy/CIDR w `OMS_TRUST_PROXY`. Brak wartości oznacza brak zaufania do nagłówków pośrednika; nigdy nie kopiuj przykładowych adresów bez sprawdzenia sieci. Wymagane są także kontrola dostępu, HTTPS i realna próba restartu usługi. Te czynności należą do odbioru docelowej instalacji.

Dodawaj integracje pojedynczo: najpierw jeden kanał Allegro albo WooCommerce, potem wybrany kurier, a następnie inFakt. Po każdym kroku uruchom kontrolowany test i odbiór z rzeczywistym kontem klienta. Nie podłączaj KSeF, poczty ani nie nadaj paczki w ramach tej próby.

## Ograniczenia obecnej wersji

OMS używa pełnej kompozycji modułów. Brak sekretów nie usuwa ekranów ani nie wyłącza technicznych zależności magazynu; część ekranów będzie pusta albo wyświetli brak konfiguracji. Ta partia nie dostarcza selektora modułów, operacyjnego magazynu, mostu dropshippingowego, GLS, sprzedaży stacjonarnej ani DCR Allegro.

Instalacja kontenerowa (Linux + Docker) ma osobną instrukcję: docs/instalacja-docker.md.
