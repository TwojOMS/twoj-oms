# Jak szukać w tym repozytorium

Kod się zmienia, więc zamiast „gdzie co leży” poniżej są **sposoby znalezienia**. Używaj `rg`
(ripgrep) albo `grep -rn`; wszystkie polecenia uruchamiaj z katalogu głównego repo.

## Od tego, co widać na ekranie, do kodu

| Masz | Szukaj | Wynik |
|---|---|---|
| napis na ekranie (przycisk, nagłówek, komunikat) | `rg -n "dokładny napis" src` | plik `.ejs` albo `.js` z komunikatem |
| adres w przeglądarce (`/zamowienia/12/zwrot`) | `rg -n "'/zamowienia/:id/zwrot'" src` | rejestracja trasy: `app.get` / `app.post` w `trasy*` modułu |
| pozycja w menu | `rg -n "etykieta: ?'Nazwa'" src/moduly` | tablica `menu` w `modul.ts` (adres, uprawnienie, kolejność) |
| pytanie „kto może to zobaczyć” | `rg -n "uprawnienie\|uprawnienia" src/moduly/<moduł>/modul.ts` | klucz uprawnienia i domyślne role |
| styl elementu | `rg -n "\.nazwa-klasy" src/public` | CSS w `src/public/*.css`, najczęściej `oms-design.css` albo `oms-uklad.css` |

## Od zmiennej środowiskowej do kodu i dokumentacji

```bash
rg -n "OMS_NAZWA" src              # kto ją czyta
rg -n "OMS_NAZWA" docs/konfiguracja.json docs/konfiguracja.md
```

Każda zmienna musi mieć wpis w `docs/konfiguracja.json`; `node scripts/straznik-konfiguracji.mjs`
zgłasza zmienne czytane w kodzie, których tam brakuje.

## Od danych do kodu

- Tabela w bazie: `rg -n "CREATE TABLE.*nazwa" src` (migracje w `src/moduly/*/migracje/`, bazowy schemat
  w `src/moduly/rdzen/migracje/0001-baseline.sql`).
- Zapytania do tabeli: `rg -n "FROM nazwa\b|INTO nazwa\b|UPDATE nazwa\b" src` — zwykle `src/oms/db/` albo `db/` modułu.
- Reguła biznesowa (kwota, VAT, status, mapowanie): `src/domena/` — czyste funkcje; najpierw zajrzyj tam,
  potem do usług modułu. Nazwy plików mówią o temacie (`vat.js`, `status.js`, `allegro-mapowanie.js`).

## Od integracji do kodu

- Klienci HTTP: `src/oms/<integracja>/` (pełna lista: `ls src/oms`).
- Rejestr integracji i nazw kluczy: `src/integracje/klucze.js`; fabryki klientów (miejsce na atrapy): `src/integracje/fabryki.ts`.
- Atrapy używane w próbie i demo: `deploy/proba/atrapy/`.
- Integracje wpisywane w panelu (Ustawienia → Integracje: m.in. DPD, InPost, inFakt, Fakturownia, poczta; dane firmy: Ustawienia → Firma):
  `rg -n "konfiguracja_integracji|wczytajKonfiguracjeIntegracji" src` — zapis w bazie i trasy ekranów (`ustawienia-*.js`
  w `trasy/` modułów `wysylka`, `faktury`, `koszty`; poczta w `ustawienia/trasy/poczta.js`); reguła „plik konfiguracji wygrywa” jest przy budowie klienta (zwykle `modul.ts`, dla poczty `uslugi.ts` modułu).

## Od poświadczeń integracji do kodu

- Poświadczenia zapisane w bazie są szyfrowane kluczem `OMS_KLUCZ_SEKRETOW`. Sejf, format zapisu i klasy wartości:
  `src/core/bezpieczenstwo/sejf-sekretow.js`; kontrola przed startem, konwersja i sprzątanie pliku:
  `konwersja-sekretow.js` obok. Które kolumny: `rg -n "MIEJSCA_SEKRETOW" src`.
- Kto przypina sejf do uchwytu bazy i kto go używa: `rg -n "przypnijSejf|sejfBazy" src scripts deploy`. Uchwyt bez
  przypiętego sejfu odmawia odczytu sekretu — to zamierzone, nie omijaj tego.
- Narzędzie operatora: `scripts/sekrety.mjs` (polecenia w nagłówku pliku), u klienta przez
  `deploy/klient/aktualizuj.sh sekrety …`. Testy: `rg -l "sekrety|sejf" tests`.
- Zasady dla agenta: klucza nie wypisuj, nie generuj zastępczego przy zaszyfrowanej bazie, nie kopiuj go razem
  z bazą, nie czyść katalogu konfiguracji hurtem. Odmowa startu przez klucz = zatrzymaj się i zapytaj człowieka
  ([AGENTS.md](../../AGENTS.md), sekcja „Granice”).

## Od kodu do testu

Testy leżą zwykle lustrzanie (wyjątki znajdzie `rg -l nazwaFunkcji tests`): `src/moduly/zwroty/...` → `tests/moduly/zwroty/`, `src/domena/vat.js` → `tests/domena/vat*.test.js`.

| katalog w `src` | gdzie są testy |
|---|---|
| `src/domena/` | `tests/domena/` |
| `src/oms/` (baza, KSeF, kurierzy, integracje, usługi) | `tests/oms/`, `tests/instalacja/` (instalator, aktualizator), `tests/konfiguracja*` |
| `src/integracje/` | `tests/integracje/` |
| `src/core/` | `tests/core/` (także strażniki repozytorium) |
| `src/public/` | `tests/public/` |
| `src/zdjecia-publiczne/` | `tests/zdjecia-publiczne/` |
| `src/moduly/<moduł>/` | `tests/moduly/<moduł>/` |
| `src/moduly/kanaly/` | `tests/moduly/kanaly/`, `tests/kanaly/` i pliki `tests/moduly/kanaly-*.test.ts` |
| `src/moduly/lista.ts` | pliki w korzeniu `tests/moduly/` |

Pomocniki leżą w `tests/pomoc/`, dane w `tests/dane/` i `tests/fixtures/` (to nie są testy).

```bash
rg -l "nazwaFunkcji" tests         # testy używające funkcji
npx vitest run tests/moduly/zwroty # uruchom jeden moduł
npx vitest run -t "fragment nazwy testu"
npm run test:zwiazane -- src/sciezka/pliku.js  # testy importujące plik (dla szeroko używanych: setki)
```

## Zanim zmienisz zachowanie

1. `rg -n "nazwaFunkcji" src tests` — zobacz wszystkich wywołujących i wszystkie testy.
2. Przeczytaj komentarz nad funkcją: wiele z nich zapisuje powód reguły i pomiar, który ją uzasadnił.
   Komentarze ze znakiem `⚠️` opisują pułapki, na których już ktoś się potknął.
3. Dopiero potem zmieniaj; test pierwszy, potem kod (patrz [zmiany-w-kodzie.md](zmiany-w-kodzie.md)).
