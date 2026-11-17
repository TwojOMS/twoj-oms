# Twój OMS — instrukcja dla agenta

Ten plik czyta agent AI (Claude Code, Codex, inne) na początku sesji w tym repozytorium. Jest
**nawigacyjny**: uczy, jak szukać w kodzie, a nie mówi, co gdzie leży. Repo ma ponad 80 tys. linii
i jego użytkownik będzie je zmieniać — numer linii albo nazwa pliku z dokumentacji mogą być nieaktualne.
Gdy dokument i kod się rozmijają, wierz kodowi i testom.

Język: kod, komentarze, interfejs i commity są po polsku. Rozmawiaj z użytkownikiem w jego języku.

## 1. Zanim cokolwiek zrobisz

1. `git status --short` i `git log --oneline -5` — czy repo ma niezatwierdzone zmiany użytkownika.
2. `node --version` — wymagany Node **24+** (`node:sqlite` jest wbudowany; brak zewnętrznej bazy).
3. Przeczytaj [docs/dla-agenta/jak-szukac.md](docs/dla-agenta/jak-szukac.md), jeśli zadanie dotyka kodu.
4. Zadanie „zainstaluj”: [docs/instalacja-przez-agenta.md](docs/instalacja-przez-agenta.md).
5. Zadanie „dodaj funkcję / zmień ekran”: [docs/dla-agenta/zmiany-w-kodzie.md](docs/dla-agenta/zmiany-w-kodzie.md).

## 2. Granice — pytaj człowieka, nie zgaduj

Te działania mają skutki poza komputerem i nie wolno ich wykonać ani „spróbować na próbę”, jeśli
człowiek nie powiedział wprost, że chodzi o to konkretne działanie:

- nadanie paczki u kuriera, zakup etykiety, wystawienie faktury, wysyłka do KSeF, zapis w inFakcie;
- mail lub wiadomość do klienta sklepu, zapis w sklepie WooCommerce lub na koncie Allegro;
- wpisywanie kluczy integracji do plików konfiguracyjnych albo do formularzy w Ustawienia → Integracje
  (DPD, InPost, inFakt, poczta) — klucze podaje człowiek, ty ich nie zgadujesz, nie generujesz
  i **nie wypisujesz na ekran ani do logów**;
- otwieranie panelu na świat (przekierowanie portu, publiczny adres) bez HTTPS i bez zaufanych proxy;
- usuwanie bazy (`oms.sqlite`), kopii i plików w `data/`, `backups/`;
- cokolwiek z kluczem poświadczeń (`klucz.env`, zmienna `OMS_KLUCZ_SEKRETOW`), którym OMS szyfruje w bazie hasła
  i tokeny integracji. Klucza **nie wypisujesz** (do `sudo cat` dajesz człowiekowi polecenie, sam nie czytasz pliku
  na ekran), **nie generujesz zastępczego**, gdy baza ma zaszyfrowane poświadczenia, **nie kopiujesz razem z bazą**
  i **nie czyścisz katalogu konfiguracji hurtem** (`/opt/oms/config` albo katalog próby) — usuwasz tylko pliki,
  które instrukcja wymienia z nazwy. OMS odmawia startu przez klucz (komunikat z `OMS_KLUCZ_SEKRETOW`,
  `KLUCZ_NIEZGODNY`, `KLUCZ_POSWIADCZEN_ODMOWA`) = zatrzymaj się i zapytaj człowieka. Utrata klucza oznacza
  ponowne podłączenie integracji; decyduje o niej człowiek. Opis: `docs/instalacja-docker.md`, rozdział
  „Klucz poświadczeń”.

Tryb `OMS_TRYB=proba` blokuje start, gdy w środowisku jest jakikolwiek klucz integracji — to
zamierzona sieć bezpieczeństwa. Nie obchodź jej; zmień tryb dopiero na polecenie człowieka.

## 3. Mapa kodu (poziom ogólny)

| Gdzie | Co |
|---|---|
| `src/oms.js` → `src/main.ts` | punkt wejścia; składa moduły i otwiera bazę |
| `src/moduly/lista.ts` | **jedyna** lista włączonych modułów i ich kolejność |
| `src/moduly/<nazwa>/modul.ts` | opis modułu: konfiguracja z env, migracje, uprawnienia, menu, trasy, zegary |
| `src/moduly/<nazwa>/trasy*`, `widoki/`, `services/`, `db/`, `migracje/` | warstwy modułu |
| `src/core/` | wspólne: aplikacja Fastify, bezpieczeństwo, konta, poczta, baza, tryb próby |
| `src/domena/` | czyste reguły biznesowe bez sieci i bazy (kwoty, VAT, statusy, mapowania) |
| `src/oms/` | klienci integracji (`ls src/oms`: m.in. Allegro, ERLI, WooCommerce, inFakt, Fakturownia, KSeF, kurierzy, GUS) i historyczne tabele |
| `src/integracje/` | rejestr integracji i fabryki klientów (miejsce na atrapy w testach i demo) |
| `src/public/` | CSS i skrypty przeglądarkowe |
| `scripts/` | instalacja, kopie, strażniki, generator danych demo |
| `deploy/klient/` | obraz i compose dla instalacji w Dockerze, skrypt aktualizacji, kopia poza dyskiem |
| `deploy/proba/`, `deploy/demo/` | atrapy integracji i start środowiska demo/próby |
| `tests/` | Vitest; głównie `tests/moduly/<moduł>`, `tests/domena`, `tests/core`; resztę znajdzie `rg -l nazwaFunkcji tests` |
| `docs/` | instalacja, konfiguracja, aktualizacje; `docs/konfiguracja.json` to maszynowy rejestr zmiennych env |

Kontrakt modułu (`ModulOms`) jest w `src/core/kontrakty.ts`. Moduł deklaruje `wymaga` (kolejność
budowania), `konfiguracja(env)` (rzuca błąd przy złej wartości — **nie podstawia po cichu domyślnej**),
`migracje`, `uprawnienia`, `menu`, `zbuduj(ctx)` (trasy, zegary, usługi, zdrowie).

## 4. Twarde reguły repozytorium

- **Zero danych firmy w kodzie.** NIP, numer BDO, rachunek, adres i nazwy kanałów pochodzą z
  konfiguracji (plik `oms.env` albo Ustawienia w panelu), nigdy z domyślnych wartości w kodzie. Dane w testach są fikcyjne.
- **Sekrety nigdy do repo** (`.env`, `.env.*`, `*.sqlite` są w `.gitignore`; pliki `*.env` instalatora — `proba.env`,
  `administrator-proby.env` — nie, więc katalog instalacji trzymaj poza repozytorium).
- **TypeScript tylko ze składnią usuwalną** (`erasableSyntaxOnly`): bez `enum`, `namespace` i
  parametrów-właściwości. Importy względne piszemy z rozszerzeniem `.ts` / `.js` jak w sąsiednich plikach.
- **Migracje bazy wyłącznie addytywne** — nowe tabele, kolumny, indeksy. Bez `DROP`, `RENAME`, transakcji w migracji,
  zmiany typu kolumny i nowych ograniczeń na istniejących tabelach; kolumna `NOT NULL` wymaga `DEFAULT`. Pilnują tego
  `scripts/straznik-migracji.mjs` i kontrola schematu przy starcie bazy. Numeracja `NNNN-opis` w katalogu `migracje/`
  modułu, rejestracja w tablicy `migracje` w `modul.ts`.
- **Nowa albo zmieniona zmienna środowiskowa** → wpis w `docs/konfiguracja.json`; `scripts/straznik-konfiguracji.mjs`
  skanuje kod i musi zgłosić 0 błędów. Hashe plików w tym rejestrze trzeba odświeżyć po zmianie
  wskazanego pliku (komunikat strażnika wskazuje plik).
- **Test najpierw, potem kod.** Zmiana zachowania zmienia też jego test — w tym samym commicie. Zielone
  testy nie dowodzą, że test cokolwiek chroni: po poprawce złam kod celowo (mutacja) i sprawdź, że test pada.
- **Pieniądze** (faktury, VAT, płatności, KSeF), nadania i migracje tych danych: poproś o niezależny
  przegląd przed scaleniem.

## 5. Bramki

```bash
npm run typy                               # tsc, ma dać 0 błędów
npx vitest run tests/moduly/<moduł>        # w trakcie pracy: tylko dotknięty moduł
npm run sprawdz -- -- --maxWorkers=2   # pełna: typy, strażniki, wszystkie testy (kilkadziesiąt minut)
```

- Na Windowsie testy PDF szukają `pdftotext` (Poppler) w `PATH`; bez niego pada uruchomienie programu, nie walidacja.
- Pojedynczy plik, który padł na timeoucie RPC pod obciążeniem, uruchom ponownie osobno.
- `--maxWorkers=2` jest potrzebne: bez limitu Vitest uruchamia zbyt wiele procesów.

## 6. Praca w repozytorium użytkownika

Użytkownik dostaje to repo jako własną kopię (fork). Rób zmiany w gałęzi, małymi commitami. Nie
przepisuj historii, nie wypychaj na zdalne repo bez prośby. Aktualizacja z wydania nadrzędnego:
`git fetch` + `git merge` (konflikty w plikach, które użytkownik zmienił, rozstrzygasz razem z nim).
Wydanie na serwer przez `deploy/klient/aktualizuj.sh` samo robi kopię bazy przed uruchomieniem nowej wersji;
kopię na żądanie robi kontener kopii (polecenie „kopia teraz” w `docs/instalacja-docker.md`). Nie używaj
`scripts/backup-db.mjs` — to narzędzie innego układu katalogów i bez ustawionych zmiennych kończy się błędem.

## 7. Częste pułapki

- `OMS_TRYB` bez wartości oznacza **produkcję**. Pierwsze uruchomienie ustaw jawnie na `proba`.
- Bez `OMS_TRUST_PROXY` panel nie ufa nagłówkom pośrednika; wpisuj tylko konkretne adresy proxy. Za pośrednikiem
  bez tej zmiennej ochrona logowania przed zgadywaniem haseł liczy próby po adresie pośrednika, wspólnym dla wszystkich
  (opis: `docs/konfiguracja.md`).
- Integracje z Ustawienia → Integracje (m.in. DPD, InPost, inFakt, Fakturownia, poczta) i dane firmy z Ustawienia →
  Firma zapisują się w bazie, ale
  **plik konfiguracji z tą samą integracją wygrywa**: ekran jest wtedy tylko do odczytu. Zanim szukasz błędu na
  ekranie, sprawdź, czy tej integracji nie ma w `oms.env`.
- Panel po zwykłym HTTP nie nadaje się do internetu; HTTPS i kontrola dostępu to osobny krok.
- Baza, kopie i konfiguracja żyją **poza** katalogiem programu — nie umieszczaj ich w repo. Dotyczy to też
  `klucz.env`: `.gitignore` go nie pomija.
- Poświadczenia integracji w bazie (`sekrety_json`, tokeny kanałów i KSeF, sekret sesji) czyta i zapisuje tylko warstwa
  z przypiętym sejfem (`rg -n "sejfBazy|przypnijSejf" src scripts`). Surowy `UPDATE` albo `INSERT` jawnego tekstu
  w te kolumny kończy się odmową startu — OMS nie szyfruje takiej wartości po cichu. Stan bazy bez klucza pokaże
  `node scripts/sekrety.mjs stan --baza <plik>`.
- Komentarz mówi, dlaczego kod jest taki — bez numerów zadań, dat, osób i odsyłaczy do dokumentów spoza repo.
  W `src/` pilnuje tego `tests/core/straznik-numerow-zadan-w-komentarzach.test.js`. W `tests/`, `scripts/` i `deploy/`
  zostały jeszcze ślady `PRZ-nnn` z historii projektu: opisują powód zmiany, ale tablicy zadań w repo nie ma.
