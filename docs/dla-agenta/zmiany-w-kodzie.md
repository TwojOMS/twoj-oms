# Jak wprowadzać zmiany

Receptury dla najczęstszych próśb użytkownika. Najpierw znajdź wzór w istniejącym module
([jak-szukac.md](jak-szukac.md)) i naśladuj jego układ — nie wymyślaj nowego.

## Przepływ każdej zmiany

1. Zadaj użytkownikowi pytania, bez których wynik byłby inny (co ma się pokazać, dla kogo, co przy braku danych).
2. Znajdź najbliższy istniejący odpowiednik (podobny ekran, podobna kolumna) i przeczytaj jego trasę, widok i test.
3. Napisz test, który pada (`npx vitest run <plik>` — zobacz czerwony).
4. Zmień kod, aż test przejdzie.
5. **Mutacja:** złam nową logikę celowo i sprawdź, że test pada. Test, który przechodzi na zepsutym kodzie, nic nie chroni.
6. `npm run typy` oraz testy dotkniętego modułu; przy pieniądzach i nadaniach także `tests/moduly/faktury` i `tests/moduly/wysylka`.
7. Pokaż użytkownikowi zmianę w działającym panelu w trybie próby (zrzut ekranu albo opis kroków) i dopiero wtedy commituj.

## Zmiana wyglądu lub tekstu

Widoki to szablony EJS: `src/moduly/<moduł>/widoki/*.ejs`, wspólny szkielet w `src/core/web/`. Style:
`src/public/app.css`, `src/public/oms-design.css`. Zmieniaj tekst tam, gdzie go znalazłeś przez `rg`;
sprawdź, czy test nie asertuje starego napisu (`rg -n "stary napis" tests`) i zmień go razem z kodem.

## Nowe pole lub kolumna w tabeli

1. Dodaj **addytywną** migrację: plik `NNNN-opis.ts` (lub `.sql`) w `src/moduly/<moduł>/migracje/` z kolejnym
   numerem i dopisz ją do tablicy `migracje` w `modul.ts`. `node scripts/straznik-migracji.mjs` odrzuci `DROP`,
   `RENAME` i zmianę typu.
2. Odczyt i zapis: warstwa `db/` modułu albo `src/oms/db/`.
3. Pokaż pole w widoku i dopisz test na zapis oraz odczyt. Istniejące wiersze mają wartość domyślną —
   zdecyduj z użytkownikiem, jaką.

## Nowy ekran (zakładka)

1. Trasy: plik w `src/moduly/<moduł>/trasy/` rejestrujący `app.get/post`; podpięcie w `zbuduj` w `modul.ts`.
2. Widok `.ejs` w `widoki/`.
3. Wpis w `menu` (`dzial`, `etykieta`, `adres`, `uprawnienie`, `kolejnosc`) i w `uprawnienia` (klucz, etykieta,
   role, które dostają dostęp od razu).
4. Test trasy: zbuduj aplikację przez `tests/pomoc/zbuduj-oms.ts` i sprawdź kod 200, zawartość i odmowę
   dla konta bez uprawnienia. Szukaj gotowych wzorów: `rg -l "zbudujOms" tests/moduly`.

## Nowa integracja z zewnętrznym serwisem

1. Klient HTTP w `src/oms/<nazwa>/`; odczyt kluczy z `env` (nigdy z kodu) i wpis w `src/integracje/klucze.js`,
   żeby tryb próby je blokował.
2. Dostęp do klienta przez fabrykę (`src/integracje/fabryki.ts`), żeby testy i demo mogły podstawić atrapę
   (`deploy/proba/atrapy/`). Testy **nigdy** nie łączą się z prawdziwą siecią.
3. Wpisz nowe zmienne do `docs/konfiguracja.json` i uruchom strażnik konfiguracji.
4. Jeśli użytkownik ma wpisywać dane w panelu, nie tylko w pliku: wzorem jest ekran DPD (`rg -l "ustawienia-dpd" src`).
   Dane idą do tabeli `konfiguracja_integracji` (ustawienia jawne osobno od sekretów), plik konfiguracji wygrywa
   z ekranem (zapis przy zmiennych z pliku = 409), a hasło nie wraca na ekran i nie trafia do dziennika.

## Nowy moduł

Skopiuj najmniejszy moduł o podobnym zakresie (np. `src/moduly/zwroty/`), nadaj `nazwa`, `wymaga`, dopisz go
do `MODULY` w `src/moduly/lista.ts`. Kolejność budowania wynika z `wymaga`; cykl zależności kończy się błędem startu.

## Zmiana, która dotyka pieniędzy

Faktury, VAT, płatności, KSeF, nadania: oprócz testów poproś użytkownika o ręczne porównanie wyniku z
dokumentem, który zna (np. fakturą z poprzedniego miesiąca). Nie wystawiaj faktur ani nie nadawaj paczek,
żeby „sprawdzić” — w trybie próby korzystaj z atrap.

## Commit

Mały, jedna rzecz, opis „co i dlaczego”. Test i kod w tym samym commicie. Bez `.env`, baz, kopii i kluczy.
