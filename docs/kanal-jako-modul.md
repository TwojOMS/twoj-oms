# Jak podpiąć nowy kanał sprzedaży

Przykład dotyczy fikcyjnego typu `polcien` o nazwie „Pracownia Półcień”. Rejestr modułów opisuje typ platformy; rejestr kanałów przechowuje konkretne połączenia i konta.

1. [ ] Utwórz własny plik opisu modułu, np. `modul-polcien.ts` w `src/domena/`. Zastosuj `OpisKanalu` z `src/core/kontrakty.ts`: podaj typ, nazwę, unikalną literę, odmianę nazwy, `idKatalogu` oraz `wzorzecLinku`. Wzorce linków są w `src/domena/link-pozycji.js`.
2. [ ] Dodaj opis pod kluczem `polcien` do `MODULY_KANALOW` w `src/domena/moduly-kanalow.ts`; `typ` musi być równy kluczowi. Typy i predykat znanych typów wynikają z rejestru. `modulZamowienia` wybiera opis po typie połączenia z rejestru kanałów (`OMS_KANALY` albo `kanaly_sprzedazy.typ`, nie z prefiksu klucza), więc zamówienie z kanału typu `polcien` dostaje ten opis.
3. [ ] Uzupełnij wszystkie umiejętności platformy w opisie:
   - `zdarzenia`: sposób pobierania zdarzeń, odpytywanie albo skrzynka;
   - `wymagaAkceptacji`: czy operator musi zaakceptować zamówienie przed realizacją;
   - `statusZwrotny`: brak zapisu, tylko status wysłania albo mapa statusów;
   - `numerListu`: brak zapisu, notatka albo przesyłki platformy;
   - `plikFaktury`: czy kupujący zamawia i otrzymuje plik faktury na platformie;
   - `wiadomosci`: obsługa wiadomości;
   - `wysylkaPlatformy`: wysyłka i etykiety platformy;
   - `terminWysylki`: termin otrzymywany z platformy;
   - `scalanie`: czy zamówienia kanału wolno scalać;
   - `stany`: brak zapisu stanów albo zapis dla produktów lub ofert.
4. [ ] W `kluczeEnv` wpisz uporządkowane sufiksy `sekrety` i `wymagane`, bez prefiksu konta. Każdy sekret musi znaleźć się też w wymaganych; dozwolone są wielkie litery, cyfry i podkreślenia, a pierwszy znak musi być literą. Zmienne środowiskowe zgłoś również w `docs/konfiguracja.json`.
5. [ ] Opisz `konfigurator`: ścieżkę, adres nowego połączenia, napis przycisku i kolejne kroki. Każdy krok ma formularz albo własny fragment `widok`, nigdy oba; numery są kolejne, identyfikatory kroków i pól w kroku unikalne, a opcje należą tylko do pól wyboru. Akcja formularza jest względna do ścieżki, `:kanal` oznacza klucz połączenia. Wspólne widoki i pomocnicze funkcje są w `src/core/web/konfigurator/krok-konfiguratora.ejs`, `src/core/web/konfigurator/kroki-konfiguratora.ejs` i `src/core/web/konfigurator/konfigurator.ts` (wspólne z kurierami). Własne fragmenty oraz usługi i trasy modułu trzeba dopisać; wartość sekretu nie może trafić do HTML.
6. [ ] Dodaj fabrykę typu do `createRejestrKanalow`, aby rejestr połączeń potrafił utworzyć konto nowego modułu. Fabryka i kontrola zgodności typów z rejestrem modułów są planowane.
7. [ ] Gdy `statusZwrotny` nie jest `brak`, przygotuj adapter `zwrotne` z metodą `ustawStatus`; przy `brak` nie udostępniaj tej metody. Zgodność adaptera z umiejętnością będzie sprawdzana przy składaniu modułu.
8. [ ] Zaimplementuj `KanalSprzedazy` z `src/core/kontrakty.ts` do importu: `pobierzStrone`, `kursorZ`, `zlozoneZ` i `mapuj`. Podłącz implementację i sprawdź stronicowanie, kursor oraz mapowanie na fikcyjnych danych.
9. [ ] Dodaj pozycję do `KATALOG_INTEGRACJI` w `src/domena/katalog-integracji.ts`. Jej `id` musi odpowiadać `idKatalogu` opisu; uzupełnij nazwę, opis, dostępność, logo i adres konfiguracji.
10. [ ] Uruchom walidację opisów `sprawdzOpisyKanalow` i testy modułu. Osobny strażnik nazw kanałów ma pilnować niedozwolonych rozgałęzień i listy wyjątków.

Sprawdź również formularz, brak sekretów w odpowiedzi, błędne konfiguracje i zachowanie każdej używanej umiejętności. Testy powinny pracować na fikcyjnych danych, bez połączeń do prawdziwej platformy.
