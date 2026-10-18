---
name: run-oms
description: Uruchom OMS lokalnie na zmyślonych danych demo i obejrzyj zmianę w działającym panelu. Używaj, gdy pada „uruchom OMS lokalnie”, „zobacz zmianę w działającym panelu”, „zrzut ekranu”, „sprawdź w przeglądarce”, „czy błędy w konsoli”, albo przed oddaniem zmiany w wyglądzie lub zachowaniu ekranu — także gdy pracuje kilku wykonawców naraz (każda kopia robocza ma własny port i własną bazę).
---

# OMS lokalnie — uruchom, zaloguj, obejrzyj, zatrzymaj

Skrypt `scripts/uruchom-lokalnie.mjs` stawia OMS z bieżącego kodu kopii roboczej:
zmyślona firma „Pracownia Półcień” (generator `scripts/demo-dane.mjs`, ok. 175 zamówień z 60 dni),
atrapy integracji (`deploy/proba/atrapy` — inFakt, KSeF, Woo, Allegro, DPD, poczta; serwer nic nie
wysyła), `OMS_TRYB=proba`, tylko `127.0.0.1`. Wyjątek po stronie przeglądarki: miniatury produktów
mają adresy demo publicznego (`ADRES_ZDJEC_DEMO` w `scripts/demo-dane-katalog.mjs`) — bez internetu
zobaczysz puste miniatury, reszta działa. Baza, log i konto leżą w katalogu tymczasowym
systemu, nie w repo. Każda kopia robocza (worktree) dostaje własny katalog, a bez `--port` — wolny port,
więc kilku wykonawców naraz nie wchodzi sobie w drogę.

Nie używaj tego do sprawdzania prawdziwej integracji (atrapa to nie inFakt ani Allegro) ani do
produkcyjnej konfiguracji — skrypt nie czyta żadnego `.env` i nie przekazuje serwerowi zmiennych
z twojej powłoki poza systemowymi (PATH, TEMP itp.).

## 1. Start

Z katalogu głównego kopii roboczej (Git Bash, PowerShell, bash — to samo polecenie):

```
node scripts/uruchom-lokalnie.mjs start
```

Opcje: `--port 3101` (konkretny port; zajęty = odmowa przed generatorem), `--katalog <ścieżka>`
(własny katalog zamiast domyślnego).

Ostatnia linia wyjścia to JSON:
`{"status":"dziala","adres":"http://127.0.0.1:<port>","port":…,"portWejscia":…,"pid":…,"login":"lokalny","log":"…/serwer.log","katalog":"…","msBaza":…,"msRazem":…}`

- Czas (pomiar na wolnym laptopie): generator 6–41 s zależnie od obciążenia, razem z serwerem
  11–49 s; od polecenia do zalogowanego ekranu w przeglądarce ok. 40 s. Polecenie wraca dopiero,
  gdy `/health` odpowiada, i samo kończy się po 60 s bez odpowiedzi (z ogonem logu).
- Drugi `start` w tej samej kopii, gdy serwer żyje → `"status":"juz-dziala"` z tym samym adresem.
- Każdy nowy `start` (po `stop`) = świeże demo na dziś. Zmiany w kodzie wymagają `stop` + `start`
  (serwer nie przeładowuje się sam).
- `node scripts/uruchom-lokalnie.mjs stan` — czy działa, adres, `health`.

## 2. Logowanie — bez hasła w twoim kontekście

```
node scripts/uruchom-lokalnie.mjs zaloguj
```

→ `{"status":"gotowe","link":"http://127.0.0.1:<portWejscia>/wejscie/<token>","jednorazowy":true,"waznySek":120,…}`

**Nie czytaj `konto.json` i nie wypisuj hasła** — ani w odpowiedzi, ani w poleceniu, ani w raporcie.
Konto `lokalny` (administrator, wszystkie ekrany) ma losowe hasło w `konto.json`, ale to plik dla
człowieka: hasło nie jest ci do niczego potrzebne. Polecenie `zaloguj` niczego takiego nie drukuje;
serwer sam loguje się tym kontem, gdy przeglądarka otworzy link.

- Link otwórz w przeglądarce **od razu i tylko raz**: pierwsze wejście ustawia ciasteczko sesji
  (HttpOnly) i przekierowuje na `<adres>/` (lista Zamówień); drugie wejście, link po 120 s i token
  z pomyłką dają 404/410 bez ciasteczka. Link zużyty albo wygasły → ponów `zaloguj`.
- Link i ciasteczko sesji traktuj jak sekret o krótkim życiu: nie wklejaj ich do raportu, zrzutów
  ani plików w repo. Link działa tylko na tym laptopie (127.0.0.1) i tylko dopóki żyje serwer ze
  `start`; ciasteczko znika z `stop`.
- Ciasteczka nie są izolowane portem: dwa serwery naraz (dwie kopie robocze) dzielą ciasteczko
  `sesja_oms_proba` na `127.0.0.1` i wylogowują się nawzajem — otwieraj je w osobnych kontekstach
  przeglądarki (Chrome DevTools MCP: `isolatedContext`) albo po kolei.
- `--wazny-sek N` (1–600) skraca albo wydłuża ważność linku; `--katalog K` jak przy `start`.
- Bez przeglądarki (test, skrypt): `GET <link>` bez podążania za przekierowaniem → 302 z nagłówkiem
  `set-cookie: sesja_oms_proba=…`; to ciasteczko wysyłasz w nagłówku `cookie`. Nie logujesz się
  `POST /login` — to wymagałoby hasła.

## 3. Oglądanie zmiany

Dowolne narzędzie przeglądarki, które umie: nową kartę, zmianę rozmiaru okna, zrzut i konsolę.
Kolejność:

1. `zaloguj` (punkt 2), potem otwórz link z wyniku w nowej karcie — to cała procedura logowania.
2. Przejdź na ekran, którego dotyczy zmiana. Przydatne adresy: `/` (Zamówienia),
   `/zamowienia/<id>` (karta), `/faktury`, `/magazyn`, `/raporty`, `/ustawienia`
   (przekierowuje na pierwszą podstronę).
3. Szerokość okna **1280**, zrzut; potem **1440**, zrzut. Zrzut po zalogowaniu; link wejścia nie trafia
   do raportu (jest już zużyty, ale to nawyk).
4. Odczytaj konsolę strony — błędy JS (`error`) i nieudane żądania to usterka do zgłoszenia albo
   naprawy, ostrzeżenia odnotuj. Znany szum, nie twoja zmiana: `403` na `/favicon.ico` (przeglądarka
   pyta sama, panel ma ikonę pod `/public/`) — sprawdź listą żądań sieci, czy błąd to właśnie on.
5. Kliknij to, co zmieniłeś (przycisk, filtr, formularz) i zrób zrzut wyniku.

Przykład — Chrome DevTools MCP: `zaloguj` w powłoce → `new_page` z `url` = `link` z wyniku (osobny
`isolatedContext`; albo `navigate_page` w istniejącej karcie) → po przekierowaniu stoisz zalogowany na `/`
→ `navigate_page` na ekran zmiany → `resize_page` 1280×900 → `take_screenshot` (`filePath`) →
`resize_page` 1440×900 → `take_screenshot` → `list_console_messages`. Nie ma tu `take_snapshot` +
`fill_form`: nie ma czego wypełniać. Inne narzędzia (Playwright MCP, Claude in Chrome, własny
Puppeteer): wystarczy, że umieją otworzyć adres URL i zostawić ciasteczka z odpowiedzi — otwórz link tak
jak zwykły adres (Playwright: `browser_navigate`), reszta kolejności jak wyżej. Ciasteczko nie jest
potrzebne w żadnym innym miejscu, więc nie musisz go odczytywać ani wstawiać ręcznie.

Akcje na atrapach („Wystaw fakturę”, „Wyślij do KSeF”, „Synchronizuj”, nadanie) zapisują tylko
w lokalnej bazie i w tabelach `atrapa_*`; prawdziwego nadania, KSeF ani maila nie ma. Część akcji
odmawia czytelnym 4xx („atrapa … nie obsługuje”) — to nie błąd twojej zmiany.

## 4. Stop — zawsze, także po błędzie

```
node scripts/uruchom-lokalnie.mjs stop
```

→ `{"status":"zatrzymany","pid":…,"port":…,"portWolny":true,"katalogUsuniety":true}`.
Zabija proces serwera, czeka na zwolnienie portu i kasuje katalog (bazę, log, konto).
`--zostaw` zostawia katalog (np. żeby obejrzeć bazę `oms.sqlite` albo `serwer.log`).
Gdy nic nie działa: `"status":"nie-dziala"`, kod 0.

Jeśli `stop` odmawia („proces żyje, ale adres nie odpowiada — to może nie być OMS”), PID z pliku
mógł trafić do innego procesu (np. po restarcie). Sprawdź, co to za proces; dopiero gdy to nasz
serwer (`node … uruchom-lokalnie.mjs serwer`) — `stop --sila`.

Przed oddaniem pracy upewnij się, że `stan` mówi `nie-dziala`. Na Windows wiszący serwer znajdziesz
po linii poleceń `uruchom-lokalnie.mjs serwer` (PowerShell:
`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*uruchom-lokalnie*'`).

## Gdy coś nie działa

| objaw | przyczyna i wyjście |
|---|---|
| `port N zajęty` | inny proces na porcie — pomiń `--port` (wolny wybierze się sam) albo podaj inny |
| link z `zaloguj` daje 404/410 | zużyty, starszy niż 120 s albo serwer już nie żyje — ponów `zaloguj` (a `stan`, jeśli dalej nic) |
| `serwer nie wstał … log` | błąd startu aplikacji; ogon logu jest w komunikacie, cały w `serwer.log` (`stop --zostaw` go zachowa) |
| `OMS_TRYB=proba, a ustawione są klucze integracji` | nie powinno się zdarzyć (skrypt nie przekazuje zmiennych powłoki); sprawdź, czy ktoś nie dopisał klucza do `ENV_DEMO` |
| `proces … żyje, ale nie odpowiada` przy `start` | serwer z poprzedniego startu zawisł — sprawdź proces, `stop --sila`, `start` |
| po zmianie kodu nic się nie zmieniło | serwer nie przeładowuje się sam — `stop` + `start` |

Test skryptu: `npx vitest run tests/instalacja/uruchom-lokalnie.test.js` (start na wolnym porcie,
`/health`, logowanie, lista Zamówień z danymi demo, stop zwalnia port; `zaloguj`: jednorazowy link,
brak hasła w wyjściu, wygasanie; zajęty port; stop bez serwera). Test sam sprząta serwery, także po porażce.
