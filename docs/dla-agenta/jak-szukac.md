# Jak szukać w tym repozytorium

Kod się zmienia, więc zamiast „gdzie co leży” poniżej są **sposoby znalezienia**. Używaj `rg`
(ripgrep) albo `grep -rn`; wszystkie polecenia uruchamiaj z katalogu głównego repo.

## Od tego, co widać na ekranie, do kodu

| Masz | Szukaj | Wynik |
|---|---|---|
| napis na ekranie (przycisk, nagłówek, komunikat) | `rg -n "dokładny napis" src` | plik `.ejs` albo `.js` z komunikatem |
| adres w przeglądarce (`/zamowienia/12/zwrot`) | `rg -n "'/zamowienia/:id/zwrot'" src` | rejestracja trasy: `app.get` / `app.post` w `trasy*` modułu |
| pozycja w menu | `rg -n "etykieta: 'Nazwa'" src/moduly` | tablica `menu` w `modul.ts` (adres, uprawnienie, kolejność) |
| pytanie „kto może to zobaczyć” | `rg -n "uprawnienie\|uprawnienia" src/moduly/<moduł>/modul.ts` | klucz uprawnienia i domyślne role |
| styl elementu | `rg -n "\.nazwa-klasy" src/public` | CSS w `app.css` albo `oms-design.css` |

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

- Klienci HTTP: `src/oms/<integracja>/` (`allegro`, `woo`, `infakt`, `ksef`, `kurierzy`, `gus`, `meta`, `ga4`, `apilo`).
- Rejestr integracji i nazw kluczy: `src/integracje/klucze.js`; fabryki klientów (miejsce na atrapy): `src/integracje/fabryki.ts`.
- Atrapy używane w próbie i demo: `deploy/proba/atrapy/`.

## Od kodu do testu

Testy leżą lustrzanie: `src/moduly/zwroty/...` → `tests/moduly/zwroty/`, `src/domena/vat.js` → `tests/domena/vat*.test.js`.

```bash
rg -l "nazwaFunkcji" tests         # testy używające funkcji
npx vitest run tests/moduly/zwroty # uruchom jeden moduł
npx vitest run -t "fragment nazwy testu"
```

## Zanim zmienisz zachowanie

1. `rg -n "nazwaFunkcji" src tests` — zobacz wszystkich wywołujących i wszystkie testy.
2. Przeczytaj komentarz nad funkcją: wiele z nich zapisuje powód reguły i pomiar, który ją uzasadnił.
   Komentarze ze znakiem `⚠️` opisują pułapki, na których już ktoś się potknął.
3. Dopiero potem zmieniaj; test pierwszy, potem kod (patrz [zmiany-w-kodzie.md](zmiany-w-kodzie.md)).
