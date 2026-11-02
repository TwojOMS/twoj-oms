# Mapa pól: migawka dokumentu → FA(3) 1-0E (PRZ-123 C01)

Wejście: migawka TwojeFaktury w wersji 1 (`docs/plany/PRZ-122-twojefaktury.md`, rozdział „Migawka dokumentu”).
Wyjście: XML zgodny ze schematem `fa3/schemat_FA3_v1-0E.xsd` (przestrzeń `http://crd.gov.pl/wzor/2025/06/25/13775/`).
Mapę czyta generator `src/domena/fa3-xml.js` (C02) i korekty (C08). Walidator do testów: `tests/pomoc/xsd-fa3.js`
(`walidujFa3`, `walidujUpo`), test `tests/domena/xsd-fa3-prz123.test.js`.

Zasady ogólne:

- **Kolejność elementów = kolejność sekwencji XSD** (numer `#` w tabelach). Element nieobowiązkowy bez wartości
  w migawce — **pomijamy** (nigdy pusty element: typy `TZnakowy*` mają `minLength=1`).
- Kwoty: grosze migawki → `TKwotowy` (generator pisze `-?\d+\.\d{2}`, zawsze dwa miejsca, minus w korekcie; wzorzec XSD `-?([1-9]\d{0,15}|0)(\.\d{1,2})?`), np. `12345` → `123.45`.
  C02: zapis wyłącznie na liczbach całkowitych (`kwotaFa3`), nie `(gr / 100).toFixed(2)` — to myli się przy
  bardzo dużych kwotach (9000000000000001 gr → `…0.02`); nie-całe grosze = wyjątek.
  Cena jednostkowa `P_9A` — `TKwotowy2` (do 8 miejsc) = napis `cenaNettoJedn` bez zmian. Ilość `P_8B` — `TIlosci`
  (do 6 miejsc) = napis `ilosc` bez zmian.
- Daty `RRRR-MM-DD` → `TDataT` (2006-01-01…2050-01-01). `DataWytworzeniaFa` — `xsd:dateTime` w zakresie
  **2025-09-01T00:00:00Z…2050-01-01T23:59:59Z** (starszy `utworzonoAt` = odrzucenie przez schemat).
- Napisy: ucieczka `&`, `<`, `>` (i `"` w atrybutach); UTF-8 bez BOM. `TZnakowy` ≤ 256 znaków, `TZnakowy512` ≤ 512.
  C02 (zgodnie z planem): generator koduje wszędzie pięć znaków `&` `<` `>` `"` `'`, a `\r` jako `&#13;` (parser XML
  zamieniłby surowe `\r\n` w komentarzu na `\n`); znak niedozwolony w XML 1.0 (sterujące poza `\t` `\n` `\r`,
  samotne surogaty) = wyjątek generatora. Długości pól generator nie sprawdza (tylko XSD w testach).
  Zapis: wcięcia po 2 spacje, końce linii `\n`, nowa linia na końcu pliku.
- Adres (`TAdres`): `KodKraju` = `kraj`; `AdresL1` = `ulica`; `AdresL2` = `kod miasto` (spacja; bez pustych części).
  Gdy `ulica` = null, a jest `kod`/`miasto` → `AdresL1` = `kod miasto`, bez `AdresL2`. Gdy brak wszystkiego →
  bez elementu `Adres` (dozwolone tylko w `Podmiot2`/`Podmiot3`; `Podmiot1/Adres` jest obowiązkowy).

## Korzeń `Faktura`

| # | element | obow. | z migawki |
|---|---|---|---|
| 1 | `Naglowek` | tak | stałe + `utworzonoAt` |
| 2 | `Podmiot1` | tak | `sprzedawca` |
| 3 | `Podmiot2` | tak | `nabywca` |
| 4 | `Podmiot3` (0…100) | nie | `odbiorca` (najwyżej jeden) |
| — | `PodmiotUpowazniony` | nie | nie używamy |
| 5 | `Fa` | tak | reszta dokumentu |
| 6 | `Stopka` | nie | `uwagi`, `sprzedawca.bdo` |
| — | `Zalacznik` | nie | nie używamy |

## `Naglowek` (`TNaglowek`)

| # | element | obow. | wartość |
|---|---|---|---|
| 1 | `KodFormularza` | tak | `FA`, atrybuty `kodSystemowy="FA (3)"`, `wersjaSchemy="1-0E"` |
| 2 | `WariantFormularza` | tak | `3` |
| 3 | `DataWytworzeniaFa` | tak | `utworzonoAt` znak w znak (np. `2026-11-03T09:14:05.000Z`) — bez zegara |
| 4 | `SystemInfo` | nie | `Twój OMS` (`TZnakowy`) |

## `Podmiot1` — sprzedawca

| # | element | obow. | z migawki |
|---|---|---|---|
| 1 | `PrefiksPodatnika` | nie | `PL`, gdy `adnotacje.wdt`; inaczej pomijamy (patrz DS 9) |
| 2 | `DaneIdentyfikacyjne/NIP` | tak | `sprzedawca.nip` (`TNrNIP`, 10 cyfr) |
| 2 | `DaneIdentyfikacyjne/Nazwa` | tak | `sprzedawca.nazwa` (`TZnakowy512`) |
| 3 | `Adres` | tak | `kraj`, `ulica`, `kod`, `miasto` |
| 4 | `DaneKontaktowe` (0…3) | nie | jeden: `Email` = `email`, `Telefon` = `telefon` (≤ 16 znaków po zdjęciu spacji; nadal dłuższy — wyjątek generatora, nie ciche pominięcie); obu brak → bez elementu |

## `Podmiot2` — nabywca

| # | element | obow. | z migawki |
|---|---|---|---|
| 1 | `DaneIdentyfikacyjne` (wybór) | tak | `nip` → `NIP`; inaczej `nipUe` → `KodUE` = `nipUe.kraj` (tylko kod z `TKodyKrajowUE`: Grecja `EL`, nie `GR`; inny kod — wyjątek generatora), `NrVatUE` = `nipUe.numer` (bez prefiksu kraju); inaczej (osoba prywatna) → `BrakID` = `1` |
| 1 | `DaneIdentyfikacyjne/Nazwa` | nie | `nabywca.nazwa` (zawsze, gdy jest) |
| 2 | `Adres` | nie | `kraj`, `ulica`, `kod`, `miasto` (zasada adresu wyżej) |
| 3 | `DaneKontaktowe/Email` | nie | `nabywca.email` |
| 4 | `JST` | tak | `nabywca.jst` ? `1` : `2` |
| 5 | `GV` | tak | `2` zawsze |

## `Podmiot3` — odbiorca (gdy `odbiorca` ≠ null; po `Podmiot2`, przed `Fa`)

| # | element | obow. | z migawki |
|---|---|---|---|
| 1 | `DaneIdentyfikacyjne` (wybór) | tak | `nip` → `NIP`; `idWew` → `IDWew` (`TNIPIdWew`, `NIP-NNNNN`); żadnego → `BrakID` = `1` |
| 1 | `DaneIdentyfikacyjne/Nazwa` | nie | `odbiorca.nazwa` (niepusta z niezmiennika) |
| 2 | `Adres` | nie | `kraj`, `ulica`, `kod`, `miasto` |
| 3 | `Rola` | tak | `rola` `odbiorca` → `2` („jednostka wewnętrzna, oddział nabywcy”), `jst` → `8` („JST — odbiorca”) |

## `Fa`

| # | element | obow. | z migawki |
|---|---|---|---|
| 1 | `KodWaluty` | tak | `waluta` (`PLN`; migawka v1 dopuszcza tylko PLN, więc bez `P_14_xW` i kursów) |
| 2 | `P_1` | tak | `dataWystawienia` |
| 3 | `P_1M` | nie | `miejsceWystawienia` |
| 4 | `P_2` | tak | `numer` |
| 5 | `P_6` | nie | `dataSprzedazy`, **tylko gdy ≠ null i ≠ `dataWystawienia`** (DS 3) |
| 6 | `P_13_1`, `P_14_1` | parą | stawka `23`: netto, VAT |
| 7 | `P_13_2`, `P_14_2` | parą | stawka `8` |
| 8 | `P_13_3`, `P_14_3` | parą | stawka `5` |
| 9 | `P_13_6_1` | nie | stawka `0` (krajowa) — netto |
| 10 | `P_13_6_2` | nie | stawka `0 WDT` — netto |
| 11 | `P_13_7` | nie | stawka `zw` — netto |
| 12 | `P_15` | tak | `sumy.bruttoGr` (w KOR: `korekta.roznica.bruttoGr`) |
| 13 | `Adnotacje` | tak | tabela niżej |
| 14 | `RodzajFaktury` | tak | `rodzaj` (`VAT` \| `KOR`) |
| 15–17 | `PrzyczynaKorekty`, `TypKorekty`, `DaneFaKorygowanej` | KOR | tabela „Korekta” |
| 18 | `DodatkowyOpis` | nie | nie używamy (DS 1) |
| 19 | `FaWiersz` (1…10000) | nie* | `pozycje` (*zawsze wypisujemy) |
| 20 | `Platnosc` | nie | tabela niżej |

`P_13_x`/`P_14_x` z `sumy.stawki` (w KOR z `korekta.roznica.stawki`); stawka nieobecna na dokumencie — bez pary.
Pola stawek 22/7/4/3, `P_13_4`, `P_13_5`, `P_13_6_3`, `P_13_8…11` — nie używamy (TwojeFaktury ich nie ma).

### `Fa/Adnotacje`

| # | element | wartość |
|---|---|---|
| 1 | `P_16` (metoda kasowa) | `adnotacje.metodaKasowa` ? `1` : `2` (dziś zawsze `2`) |
| 2 | `P_17` (samofakturowanie) | `2` |
| 3 | `P_18` (odwrotne obciążenie) | `adnotacje.odwrotneObciazenie` ? `1` : `2` |
| 4 | `P_18A` (MPP) | `adnotacje.mpp` ? `1` : `2` |
| 5 | `Zwolnienie` | `zwolnienie` ≠ null → `P_19` = `1` + jedno z `P_19A` (rodzaj `ustawa`) / `P_19B` (`dyrektywa`) / `P_19C` (`inna`) = `podstawa`; inaczej `P_19N` = `1` |
| 6 | `NoweSrodkiTransportu/P_22N` | `1` |
| 7 | `P_23` (procedura uproszczona) | `2` |
| 8 | `PMarzy/P_PMarzyN` | `1` |

### `Fa/FaWiersz` (jeden na pozycję, w kolejności `lp`)

| # | element | z pozycji |
|---|---|---|
| 1 | `NrWierszaFa` | `lp` (w KOR numeracja ciągła przez wiersze „przed” i „po”) |
| 2 | `P_7` | `nazwa` (`TZnakowy512`) |
| 3 | `P_8A` | `jm` |
| 4 | `P_8B` | `ilosc` |
| 5 | `P_9A` | `cenaNettoJedn` (8 miejsc) |
| 6 | `P_11` | `nettoGr` |
| 7 | `P_11Vat` | `vatGr` — tylko stawki `23`/`8`/`5` (DS 4) |
| 8 | `P_12` | `stawka`: `23`/`8`/`5`/`0 WDT`/`zw` bez zmian, **`0` → `0 KR`** (DS 2) |
| 9 | `StanPrzed` | `1` w wierszach z `korekta.pozycjePrzed` (KOR) |

Bez `P_9B`/`P_11A` (metoda od brutto) i bez `P_6A` (data wspólna w `P_6`).

### `Fa/Platnosc`

| # | element | z migawki |
|---|---|---|
| 1 | `Zaplacono` + `DataZaplaty` | `zaplacono: true` → `1` + `dataZaplaty` (DS 6) |
| 2 | `TerminPlatnosci/Termin` | `termin`, gdy ≠ null i `zaplacono: false` |
| 3 | `FormaPlatnosci` albo `PlatnoscInna`+`OpisPlatnosci` | `przelew` → `6`, `karta` → `2`, `gotowka` → `1`; `pobranie` → `PlatnoscInna` `1` + `OpisPlatnosci` `Pobranie`; `inny` → `PlatnoscInna` `1` + `OpisPlatnosci` `Inna` (DS 5) |
| 4 | `RachunekBankowy` | `NrRB` = `platnosc.rachunek ?? sprzedawca.rachunek`, `NazwaBanku` = `sprzedawca.bank`; bez rachunku — bez elementu |

Brak wszystkiego (nie zapłacono, brak terminu i rachunku) → mimo to `Platnosc` z formą płatności.

## Korekta (`rodzaj = 'KOR'`)

C02: `xmlFa3` odmawia migawki `KOR` wyjątkiem („korekta nie jest obsługiwana w tym generatorze (C08)”) — poniższe
pola dopisuje C08.

| # | element | z migawki |
|---|---|---|
| 15 | `PrzyczynaKorekty` | `korekta.przyczyna` (`TZnakowy` ≤ 256) |
| 16 | `TypKorekty` | `korekta.typ` (`1` data faktury pierwotnej, `2` data korekty, `3` inna) |
| 17 | `DaneFaKorygowanej/DataWystFaKorygowanej` | `korekta.dataKorygowanej` |
| 17 | `DaneFaKorygowanej/NrFaKorygowanej` | `korekta.numerKorygowanej` |
| 17 | `DaneFaKorygowanej` (wybór) | `ksefKorygowanej` ≠ null → `NrKSeF` `1` + `NrKSeFFaKorygowanej`; inaczej `NrKSeFN` `1` |
| 19 | `FaWiersz` | najpierw `pozycjePrzed` ze `StanPrzed` `1`, potem `pozycje` (stan po) — DS 7 |
| 6–12 | `P_13_x`, `P_14_x`, `P_15` | z `korekta.roznica` (minus przy zmniejszeniu) |
| 20 | `Platnosc` | **pomijany** (`minOccurs=0`): zapłata, termin i rachunek pierwotnej nie dotyczą kwoty korekty (P_15 ujemne przy zwrocie) |

## `Stopka`

| # | element | z migawki |
|---|---|---|
| 1 | `Informacje/StopkaFaktury` | `uwagi` (`TTekstowy`, 1…3500, `xsd:string` — nowe linie zostają) — DS 1 |
| 2 | `Rejestry/BDO` | `sprzedawca.bdo` (≤ 9 znaków) — DS 8 |

Oba puste → bez `Stopka`.

## Pola migawki bez odpowiednika w FA(3)

`wersja`, `seria`, `b2b` (wynika z `Podmiot2`), `sumy.regulaVat`, `sumy.nettoGr`/`vatGr` (FA(3) ma tylko per stawka
i `P_15`), `platnosc.sposob` dla `pobranie`/`inny` poza opisem, `zrodlo`, `korekta.sumyPrzed`.

## Rozstrzygnięcia (DS — do przejrzenia przez kierownika)

1. **Komentarz `uwagi` → `Stopka/Informacje/StopkaFaktury`, nie `Fa/DodatkowyOpis`.** `StopkaFaktury` to `TTekstowy`
   (do 3500 znaków, zwykły tekst z liniami), więc mieści `uwagi` ≤ 1000 w jednym polu. `DodatkowyOpis` to pary
   klucz–wartość po ≤ 256 znaków (`TZnakowy`, sprawdzone: 300 znaków → błąd `maxLength`), a XSD opisuje je jako
   „dodatkowe dane … w tym wymagane przepisami prawa, dla których nie przewidziano innych pól” — komentarz handlowy
   to nie ten przypadek. Jak wizualizacja MF pokazuje stopkę — nie sprawdzone (broszury FA(3) nie ma w repo).
2. **Stawka `0` (krajowa) → `P_12` = `0 KR`, suma w `P_13_6_1`.** XSD nie zna wartości `0` (sprawdzone: błąd
   `enumeration`); `0 KR` = „0% na terytorium kraju z wyłączeniem WDT i eksportu”. `0 WDT` → `P_13_6_2`.
3. **`P_6` tylko, gdy data sprzedaży różni się od daty wystawienia.** Opis XSD: „o ile taka data jest określona
   i różni się od daty wystawienia”; zgodne z migawką (`null` = taka jak data wystawienia).
4. **`P_11Vat` tylko przy stawkach z podatkiem (23/8/5).** Opis XSD: kwota podatku z art. 106e ust. 10; przy `0 KR`,
   `0 WDT`, `zw` podatku nie ma (schemat przyjmuje też `0.00`, ale pole byłoby bez treści). PRZ-122 DO SPRAWDZENIA 1.
5. **`pobranie` i `inny` → `PlatnoscInna` + `OpisPlatnosci`.** `TFormaPlatnosci` ma tylko 1 gotówka, 2 karta, 3 bon,
   4 czek, 5 kredyt, 6 przelew, 7 mobilna; pobranie u kuriera nie jest żadną z nich.
6. **`zaplacono: true` bez `dataZaplaty` — generator odmawia** (wyjątek, nie zgadywana data): w XSD `Zaplacono`
   i `DataZaplaty` są parą obowiązkową. Migawka dziś tego nie wymusza (`sprawdzMigawke` przyjmuje `null`) — C02
   albo niezmiennik w migawce (zmiana kształtu poza C01).
7. **Korekta „przed i po” (`StanPrzed`).** Wiersze `pozycjePrzed` ze znacznikiem `StanPrzed` = `1`, potem wiersze
   po korekcie, numeracja `NrWierszaFa` ciągła; sumy `P_13_x`/`P_15` = różnica. Sprawdzone schematem (wariant
   z `NrKSeF` i z `NrKSeFN`); czy KSeF wymaga dodatkowo `Podmiot2K`/`IDNabywcy` — PRZ-122 DO SPRAWDZENIA 13 (C08).
8. **`sprzedawca.bdo` → `Stopka/Rejestry/BDO`** — jedyne pole BDO w FA(3).
9. **`PrefiksPodatnika` = `PL` przy WDT, poza WDT elementu nie ma** (plan PRZ-123, C02 „WDT (sprawdzone 27.10
   w przepisie)”: art. 106e ust. 1 pkt 24 lit. a w zw. z art. 97 ust. 10 pkt 2). Schemat przyjmuje oba warianty
   (element opcjonalny, `fixed="PL"`), więc pilnuje tego asercja w złotym WDT — mutacja (g) planu.
10. **`NrVatUE` = `nipUe.numer` bez prefiksu kraju** (kraj idzie w `KodUE`). Wzorzec XSD `(\d|[A-Z]|\+|\*){1,12}`:
    tylko wielkie litery i cyfry, do 12 znaków. `zbudujMigawke` usuwa spacje i myślniki (`cyfry()`), ale nie
    zdejmuje prefiksu (`DE123…`) ani nie podnosi liter — generator (C02) zdejmuje prefiks równy `kraj` (Grecja: prefiks `EL`) i podnosi
    litery; numer nadal niezgodny ze wzorcem = wyjątek generatora.

## Sprawdzone schematem (C01, walidator `tests/pomoc/xsd-fa3.js`, skrypt poza repo)

Kontrolka dodatnia w teście (B2B 23%, `Podmiot3` rola 2, stopka) i warianty: WDT (`KodUE`/`NrVatUE`, `0 WDT`,
zapłacono), zwolnienie z `P_19A` + osoba prywatna + pobranie + BDO, osoba prywatna bez nazwy i adresu z `0 KR`,
JST (`JST` 1, `Podmiot3` z `IDWew` i rolą 8, trzy stawki, `P_6`, stopka wielowierszowa), KOR z `NrKSeF`
i `StanPrzed`, KOR z `NrKSeFN` i kwotami ujemnymi — wszystkie `ok`. Odrzucone zgodnie z mapą: `P_12` = `0`,
`DodatkowyOpis` 300 znaków, `DataWytworzeniaFa` z 2024 r.

**Uwaga dla C07 (UPO):** przykład UPO MF ze środowiska testowego (`NazwaPodmiotuPrzyjmujacego` „Ministerstwo
Finansów - środowisko testowe (TE)”) **nie przechodzi** własnego schematu (`fixed="Ministerstwo Finansów"`) —
UPO z testowego MF nie walidujemy XSD w działaniu (i tak nie walidujemy — „Decyzje techniczne” PRZ-123).
