# Lista klientów WDT

Kanoniczna zmienna to `OMS_KLIENCI_WDT`: adresy e-mail klientów rozdzielone przecinkami.
Adresy są przycinane, zamieniane na małe litery i deduplikowane. Kolejność nie ma znaczenia.
Ta sama lista trafia do specyfikacji zamówienia oraz blokady importu historii sklepu.

`OMS_HISTORIA_MAILE_WDT` jest zachowanym aliasem zgodności. Ustawienie wyłącznie aliasu
działa w obu miejscach. Nowa konfiguracja powinna używać `OMS_KLIENCI_WDT`.
Jeżeli obie zmienne są obecne, muszą zawierać równoważne listy po normalizacji.
Konflikt odmawia startu kompozycji i samodzielnego importu historii; nie wybiera listy
po cichu. Jawnie pusta zmienna również jest obecna: puste canonical i niepuste legacy
(lub odwrotnie) to konflikt. Brak obu oznacza pustą listę.

Dla zamówienia o kwocie 123,00 zł klient z listy ma na specyfikacji 123,00 zł netto,
a pozostali 100,00 zł netto. Import historii nie jest drugim przelicznikiem netto:
zatrzymuje zamówienie WDT przed zapisem, ponieważ archiwum nie zachowuje e-maila
potrzebnego do późniejszej klasyfikacji VAT. Pozostałe zamówienia zapisuje z kwotą brutto.

Specyfikacja pobiera nazwę i adres sprzedawcy z istniejących `DPD_NADAWCA_NAZWA`,
`DPD_NADAWCA_ULICA`, `DPD_NADAWCA_KOD`, `DPD_NADAWCA_MIASTO`, `DPD_NADAWCA_KRAJ`,
tak samo jak proforma i potwierdzenie wywozu. Dane prawne `OMS_SPRZEDAWCA_NIP/BDO`
pozostają oddzielne; nie tworzymy drugiej rodziny adresu sprzedawcy.
Ta nazwa trafia też do stopki i metadanych autora PDF. Bez nazwy generator nie przywraca
dawnej marki: autor to `Twój OMS`, a stopka pozostaje neutralna. Trasa HTTP nadal wymaga
nazwy i ulicy sprzedawcy. NIP i BDO pochodzą z istniejącego walidatora rdzenia;
np. `PL 123-456-32-18` daje NIP `1234563218`. Walidacja rachunku i NIP rdzenia pozostaje bez zmian.
