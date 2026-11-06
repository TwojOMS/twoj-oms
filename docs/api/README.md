# API v1 — dla programów, które współpracują z Twoim OMS-em

API pod `/api/v1` pozwala programowi (sklepowi, arkuszowi, skryptowi, agentowi AI) czytać zamówienia,
produkty, stany i sprzedaż, a także zakładać zamówienia, karty produktów i ruchy magazynowe. Program loguje się
**kluczem API**, nie hasłem konta.

Pełny opis każdej trasy, pól i odpowiedzi: [`openapi.json`](openapi.json) (OpenAPI 3.1, w tym katalogu repozytorium).
Ten plik pokazuje, jak zacząć, i zbiera zasady wspólne dla wszystkich tras.

## Spis

- [Wypróbuj na demo](#wypróbuj-na-demo)
- [Klucz API](#klucz-api)
- [Zasady wspólne](#zasady-wspólne)
- [Ja — sprawdzenie klucza](#ja--sprawdzenie-klucza)
- [Zamówienia — odczyt](#zamówienia--odczyt)
- [Zamówienia — zapis i proforma](#zamówienia--zapis-i-proforma)
- [Produkty](#produkty)
- [Stany magazynowe](#stany-magazynowe)
- [Sprzedaż](#sprzedaż)
- [Druk](#druk)
- [Błędy](#błędy)
- [Limit wywołań](#limit-wywołań)
- [Idempotency-Key — bezpieczne ponawianie zapisu](#idempotency-key--bezpieczne-ponawianie-zapisu)
- [Bezpieczeństwo](#bezpieczeństwo)

## Wypróbuj na demo

Demo publiczne <https://demo.twojoms.pl> ma jawny klucz tylko do odczytu. Dane są zmyślone („Pracownia Półcień”),
a baza wraca do stanu początkowego co godzinę — klucz wtedy działa dalej.

```
toms_demodemo_tylko-odczyt_demo-twojoms_Pracownia-Polcien
```

Zakresy: `zamowienia:odczyt`, `produkty:odczyt`, `stany:odczyt`, `sprzedaz:odczyt`. Każdy zapis i druk tym kluczem
kończy się `403` z kodem `brak_zakresu`.

```bash
export OMS=https://demo.twojoms.pl
export KLUCZ=toms_demodemo_tylko-odczyt_demo-twojoms_Pracownia-Polcien
curl -s "$OMS/api/v1/ja" -H "Authorization: Bearer $KLUCZ"
curl -s "$OMS/api/v1/zamowienia?ile=3" -H "Authorization: Bearer $KLUCZ"
```

Limit 120 wywołań na minutę jest wspólny dla wszystkich, którzy w tej chwili używają klucza demo.

## Klucz API

**Zakładanie:** Ustawienia → Zespół i dostęp → **Klucze API** (`/ustawienia/klucze-api`). Ekran widzi tylko
administrator. Podajesz nazwę (np. „sklep — synchronizacja stanów”), zaznaczasz zakresy i opcjonalnie datę
wygaśnięcia. Klucz działa do końca wybranego dnia według UTC.

Klucz pokazuje się **raz**, zaraz po założeniu. OMS przechowuje tylko jego skrót SHA-256, więc później nie da się go
odczytać. Zgubiony klucz odwołujesz („Odwołaj”) i zakładasz nowy. Lista pokazuje przy każdym kluczu prefiks,
zakresy, twórcę, datę ostatniego użycia i adres IP.

Klucz wygląda tak: `toms_` + 8 znaków prefiksu + `_` + 43 znaki. W żądaniu idzie w nagłówku:

```
Authorization: Bearer toms_ab12cd34_…
```

Na `/api/v1` działa **wyłącznie** klucz. Ciasteczko sesji ani hasło (Basic) nie otwierają tych adresów.
Klucz nie otwiera też ekranów panelu. Wyjątkiem są kolejki druku (zakres `druk`, niżej).

**Zakresy** — daj programowi tylko te, których potrzebuje:

| zakres | otwiera |
|---|---|
| `zamowienia:odczyt` | `GET /zamowienia`, `GET /zamowienia/{id}`, dostawa, stan wysyłki, wyszukiwanie po karcie i po numerze |
| `zamowienia:zapis` | `POST /zamowienia/z-karty`, `POST /zamowienia/{id}/w-realizacji` |
| `proformy:zapis` | `POST /zamowienia/{id}/proforma`, `GET /proformy/{id}/pdf` |
| `produkty:odczyt` | `GET /produkty`, `GET /produkty/{id}` |
| `produkty:zapis` | `POST /produkty`, `PATCH /produkty/{id}` |
| `stany:odczyt` | `GET /stany` |
| `stany:zapis` | `POST /stany/ruchy` |
| `sprzedaz:odczyt` | `GET /sprzedaz` |
| `druk` | kolejki druku etykiet i faktur (poza `/api/v1`) |

Na liście jest też `zdjecia:zapis` — dziś nie otwiera żadnej trasy.

## Zasady wspólne

- Adresy w tym pliku podaję bez przedrostka: `/zamowienia` oznacza `$OMS/api/v1/zamowienia`.
- JSON w UTF-8. Ciało żądania wysyłaj z `Content-Type: application/json`.
- Kwoty w nowych polach są w **groszach** (liczba całkowita, `suma_gr`, `cena_gr`). Trasy przeniesione z dawnego API
  panelu (zakładanie zamówienia z karty, sprzedaż) zostały przy złotych — `openapi.json` mówi to przy każdym polu.
- Daty w odpowiedziach: ISO 8601 w UTC (`2026-11-06T09:15:00.000Z`). Filtry dzienne (`od`, `do`) to dni w strefie
  Europe/Warsaw, włącznie.
- **Listy** stronicuje się kursorem: `?po=<id>&ile=<n>`. `ile` od 1 do 200, domyślnie 100. Sortowanie po `id`
  rosnąco. Odpowiedź: `{ "pozycje": [...], "nastepny": <id albo null> }`. Następną stronę pobierasz z
  `po=<nastepny>`; `null` znaczy koniec.

W przykładach:

```bash
export OMS=https://oms.twoja-firma.pl      # adres Twojego OMS-u
export KLUCZ=toms_…                         # klucz z Ustawień
```

Na Windowsie w PowerShellu pisz `curl.exe` zamiast `curl`, a zmienne ustaw przez `$env:OMS = '…'`.

## Ja — sprawdzenie klucza

Bez zakresu. Dobre pierwsze wywołanie: mówi, czy klucz działa i co otwiera.

```bash
curl -s "$OMS/api/v1/ja" -H "Authorization: Bearer $KLUCZ"
```

```json
{ "nazwa": "sklep — synchronizacja stanów", "prefiks": "ab12cd34", "zakresy": ["produkty:odczyt", "stany:odczyt"] }
```

## Zamówienia — odczyt

Zakres `zamowienia:odczyt`.

```bash
# lista: filtry status, kanal, numer, od, do (dni RRRR-MM-DD, Europe/Warsaw)
curl -s "$OMS/api/v1/zamowienia?status=nowe&od=2026-11-01&ile=50" -H "Authorization: Bearer $KLUCZ"

# szczegóły: pozycje, dostawa, płatność, faktura
curl -s "$OMS/api/v1/zamowienia/1234" -H "Authorization: Bearer $KLUCZ"

# sam adres dostawy i stan wysyłki (numer przesyłki)
curl -s "$OMS/api/v1/zamowienia/1234/dostawa" -H "Authorization: Bearer $KLUCZ"
curl -s "$OMS/api/v1/zamowienia/1234/stan-wysylki" -H "Authorization: Bearer $KLUCZ"

# wyszukanie po numerze w sklepie (parametr sklep wymagany) i po identyfikatorze karty z zewnętrznego panelu
curl -s "$OMS/api/v1/zamowienia/po-numerze/12345?sklep=WOO" -H "Authorization: Bearer $KLUCZ"
curl -s "$OMS/api/v1/zamowienia/z-karty/karta-77" -H "Authorization: Bearer $KLUCZ"
```

Pozycja listy:

```json
{ "id": 1234, "numer": "12345", "kanal": "WOO", "status": "nowe", "utworzone_at": "2026-11-05T08:12:00.000Z",
  "klient": { "imie": "Jan", "nazwisko": "Kowalski", "email": "jan@example.com" }, "suma_gr": 15900, "waluta": "PLN" }
```

Status jest wyliczany z faktów zamówienia: `nowe`, `indywidualne`, `w_realizacji`, `wyslane`, `zwrot`, `anulowane`
albo klucz statusu własnego z Ustawień. Nazwy kanałów (`kanal`) pochodzą z konfiguracji Twojego OMS-u.

## Zamówienia — zapis i proforma

**Założenie zamówienia z karty** — zakres `zamowienia:zapis`. Do programów, które prowadzą własną kartę sprawy
(np. panel zamówień indywidualnych); `kartaId` to jej identyfikator. Druga próba z tym samym `kartaId` nie zakłada
drugiego zamówienia: zwraca `409` z `id` i `numer` istniejącego. Trasa wymaga włączonego kanału zamówień
indywidualnych (`OMS_KANAL_INDYWIDUALNY`), inaczej `503`.

```bash
curl -s -X POST "$OMS/api/v1/zamowienia/z-karty" \
  -H "Authorization: Bearer $KLUCZ" -H "Content-Type: application/json" \
  -d '{"kartaId":"karta-77",
       "klient":{"first_name":"Jan","last_name":"Kowalski","email":"jan@example.com","phone":"500100200",
                 "address_1":"ul. Przykładowa 1","postcode":"00-001","city":"Warszawa","country":"PL"},
       "chceFakture":false,"kosztDostawyBrutto":"15.00",
       "pozycje":[{"nazwa":"Lampa stołowa","sku":"LAMPA-01","ilosc":1,"cena_brutto":"249.00"}]}'
# 201 → {"id":1235,"numer":"IND/2026/0042"}
```

Ceny w tej trasie są w złotych (`cena_brutto`, `kosztDostawyBrutto`). Pozostałe pola (`dostawa`, `nip`, `uwagi`,
`vat` pozycji) opisuje `openapi.json`.

**W realizacji** — zakres `zamowienia:zapis`. Ponowne wywołanie zachowuje pierwszy czas rozpoczęcia.

```bash
curl -s -X POST "$OMS/api/v1/zamowienia/1235/w-realizacji" -H "Authorization: Bearer $KLUCZ"
```

**Proforma z PDF** — zakres `proformy:zapis`. Wystawienie zwraca adres PDF, który pobierasz tym samym kluczem.

```bash
curl -s -X POST "$OMS/api/v1/zamowienia/1235/proforma" -H "Authorization: Bearer $KLUCZ"
# 201 → {"id":17,"numer":"PRO/11/2026/17","pdfUrl":"/api/v1/proformy/17/pdf"}

curl -s "$OMS/api/v1/proformy/17/pdf" -H "Authorization: Bearer $KLUCZ" -o proforma-17.pdf
```

Bez skonfigurowanych proform obie trasy odpowiadają `503`.

## Produkty

Karta produktu to ta sama karta co w zakładce MAGAZYN. `w_sklepach` pokazuje jej powiązania z produktami w sklepach.

**Odczyt** — zakres `produkty:odczyt`. Filtry: `sku` (dokładne, bez względu na wielkość liter), `kategoria`,
`zmienione_od` (ISO 8601 ze strefą), `wycofane` = `nie` (domyślnie), `tak` albo `wszystkie`.

```bash
curl -s "$OMS/api/v1/produkty?zmienione_od=2026-11-01T00:00:00Z" -H "Authorization: Bearer $KLUCZ"
curl -s -i "$OMS/api/v1/produkty/42" -H "Authorization: Bearer $KLUCZ"     # -i: pokaż nagłówek ETag
```

```json
{ "id": 42, "sku": "LAMPA-01", "nazwa": "Lampa stołowa", "opis": null, "ean": null, "cena_gr": 24900,
  "stawka_vat": "23", "kategoria": "Lampy", "wymiary": { "szerokosc_mm": 300, "wysokosc_mm": 450, "glebokosc_mm": null },
  "waga_g": 1200, "wycofana": false, "utworzony_at": "…", "zmieniony_at": "…", "w_sklepach": [] }
```

**Założenie** — zakres `produkty:zapis`. Wymagana tylko `nazwa`. SKU musi być wolne (porównanie bez względu na
wielkość liter), inaczej `409 sku_zajete`. Wymiary podajesz parą szerokość + wysokość (głębokość opcjonalnie) albo
wcale — inny układ to `400 wymiary`.

```bash
curl -s -i -X POST "$OMS/api/v1/produkty" \
  -H "Authorization: Bearer $KLUCZ" -H "Content-Type: application/json" \
  -H "Idempotency-Key: produkt-LAMPA-02" \
  -d '{"nazwa":"Lampa wisząca","sku":"LAMPA-02","cena_gr":39900,"stawka_vat":"23",
       "wymiary":{"szerokosc_mm":400,"wysokosc_mm":300},"waga_g":1800}'
# 201, nagłówki Location: /api/v1/produkty/43 i ETag
```

**Zmiana** — zakres `produkty:zapis`. Zmienia tylko podane pola. Wymaga nagłówka `If-Match` z ETagiem karty
(z `GET` albo z poprzedniego zapisu, razem z cudzysłowami). Gdy karta zmieniła się w międzyczasie, dostajesz
`409 zmieniona` z aktualną kartą w polu `karta`. Brak `If-Match` → `428`.

```bash
ETAG=$(curl -s -i "$OMS/api/v1/produkty/43" -H "Authorization: Bearer $KLUCZ" | grep -i '^etag:' | cut -d' ' -f2- | tr -d '\r')
curl -s -X PATCH "$OMS/api/v1/produkty/43" \
  -H "Authorization: Bearer $KLUCZ" -H "Content-Type: application/json" \
  -H "If-Match: $ETAG" \
  -d '{"cena_gr":37900}'
```

## Stany magazynowe

Działają tylko, gdy stany są włączone w Ustawienia → Magazyn. Przy wyłączonych obie trasy odpowiadają
`409 stany_wylaczone`.

**Odczyt** — zakres `stany:odczyt`. Stan liczony jak w OMS-ie, z uwzględnieniem zamówień. Pole `od` to chwila
ostatniego włączenia stanów (od niej liczy się historia).

```bash
curl -s "$OMS/api/v1/stany?sku=LAMPA-01" -H "Authorization: Bearer $KLUCZ"
# {"pozycje":[{"karta_id":42,"sku":"LAMPA-01","stan":7,"od":"2026-10-01T00:00:00.000Z"}],"nastepny":null}
```

**Ruch** — zakres `stany:zapis`, nagłówek `Idempotency-Key` **wymagany** (bez niego `428`). Rodzaje: `przyjecie`
(ilość > 0) i `korekta` (ilość ≠ 0, wymagany `powod`, do 500 znaków). Kartę wskazujesz dokładnie jednym z pól
`sku` albo `karta_id`.

```bash
curl -s -X POST "$OMS/api/v1/stany/ruchy" \
  -H "Authorization: Bearer $KLUCZ" -H "Content-Type: application/json" \
  -H "Idempotency-Key: dostawa-2026-11-06-LAMPA-01" \
  -d '{"sku":"LAMPA-01","rodzaj":"przyjecie","ilosc":10}'
# 201 → {"karta_id":42,"sku":"LAMPA-01","rodzaj":"przyjecie","ilosc":10,"powod":null,"stan":17}

curl -s -X POST "$OMS/api/v1/stany/ruchy" \
  -H "Authorization: Bearer $KLUCZ" -H "Content-Type: application/json" \
  -H "Idempotency-Key: inwentaryzacja-2026-11-06-42" \
  -d '{"karta_id":42,"rodzaj":"korekta","ilosc":-2,"powod":"inwentaryzacja: uszkodzone klosze"}'
```

## Sprzedaż

Zakres `sprzedaz:odczyt`. Zamówienia złożone w przedziale dni (Europe/Warsaw, oba wymagane, `od` ≤ `do`).
Kwota jest tekstem w złotych.

```bash
curl -s "$OMS/api/v1/sprzedaz?od=2026-11-01&do=2026-11-06" -H "Authorization: Bearer $KLUCZ"
# {"zamowienia":[{"numer":"12345","kanal":"WOO","kwotaBrutto":"159.00","dataZlozenia":"…","dzien":"2026-11-05"}]}
```

## Druk

Zakres `druk`. Klucz z tym zakresem otwiera kolejki druku, z których korzystają czuwacze na komputerze z drukarką
(`deploy/drukarka/`: w pliku konfiguracji czuwacza wpisz pole `klucz`). To nie są trasy `/api/v1` i odpowiadają
po staremu: lista w JSON, plik jako bajty, błąd pozycji jako zwykły tekst. Odmowa klucza (401, 403, 429) ma format
`{kod, powod}` jak w API.

```bash
# etykiety kurierskie (ZPL)
curl -s "$OMS/kolejka-druku" -H "Authorization: Bearer $KLUCZ"
curl -s "$OMS/kolejka-druku/15/zpl" -H "Authorization: Bearer $KLUCZ" -o etykieta-15.zpl
curl -s -X POST "$OMS/kolejka-druku/15/wydrukowano" -H "Authorization: Bearer $KLUCZ" -H "Origin: $OMS"
curl -s -X POST "$OMS/kolejka-druku/15/blad" -H "Authorization: Bearer $KLUCZ" -H "Origin: $OMS" \
  -H "Content-Type: application/json" -d '{"powod":"brak papieru"}'

# faktury i proformy do druku (PDF)
curl -s "$OMS/kolejka-druku-faktur" -H "Authorization: Bearer $KLUCZ"
```

Zapisy na kolejkach (`wydrukowano`, `blad`) wymagają nagłówka `Origin` z adresem OMS-u — tak jak dotąd czuwacze.
Na `/api/v1` `Origin` nie jest potrzebny.

## Błędy

Błąd ma postać:

```json
{ "kod": "brak_zakresu", "powod": "Klucz nie ma zakresu produkty:zapis." }
```

`kod` jest stały i nadaje się do porównania w programie; `powod` to zdanie po polsku dla człowieka.

| status | `kod` | kiedy |
|---|---|---|
| 400 | `stronicowanie` | złe `po` albo `ile` |
| 400 | `filtr` | zły filtr listy (status, data, powtórzony parametr) |
| 400 | `zadanie` | ciało nie jest poprawnym JSON-em albo nie pasuje do schematu |
| 400 | `walidacja`, `wymiary`, kod pola karty | złe dane ruchu albo karty (przy karcie dodatkowo `pole`) |
| 400 | `idempotencja` | `Idempotency-Key` pusty albo dłuższy niż 200 znaków |
| 401 | `klucz` | brak, zły, odwołany albo wygasły klucz |
| 403 | `brak_zakresu` | klucz nie ma zakresu tej trasy |
| 404 | `brak` | nie ma takiego zamówienia, karty albo adresu |
| 409 | `sku_zajete` | SKU ma już inna karta (w polu `id` jej numer) |
| 409 | `zmieniona` | karta zmieniła się od pobrania ETagu |
| 409 | `stany_wylaczone` | stany magazynowe są wyłączone |
| 409 | `idempotencja` | ruch z tym `Idempotency-Key` jest już zapisany |
| 413 / 415 | `plik` / `typ` | za duże ciało / zły `Content-Type` |
| 422 | `idempotencja` | ten `Idempotency-Key` był już użyty na innym adresie |
| 428 | `if_match` / `idempotencja` | brak `If-Match` przy zmianie karty / brak `Idempotency-Key` przy ruchu |
| 429 | `limit` | przekroczony limit (nagłówek `Retry-After` w sekundach) |
| 500 | `blad` | błąd serwera |

**Wyjątek:** trasy zamówień, proform i sprzedaży przeniesione z dawnego API panelu zwracają błędy bez pola `kod` —
samo `powod` (czasem z `id`, `numer`, `status`). Zła data w `/sprzedaz` daje `400` z polem `blad` zamiast `powod`.
W programie sprawdzaj najpierw status HTTP.

## Limit wywołań

- **120 wywołań na minutę na klucz** (okno stałe 60 s). Po przekroczeniu `429 limit` z nagłówkiem `Retry-After`.
- **20 nieudanych prób klucza z jednego adresu IP w ciągu minuty** blokuje ten adres na wejściu kluczem do końca
  okna. Liczy się każdy `401`, także żądanie bez nagłówka. Logowania hasłem do panelu ta blokada nie dotyka.

Czuwacze druku (pytanie co 5–10 s) mieszczą się w limicie z dużym zapasem.

## Idempotency-Key — bezpieczne ponawianie zapisu

Gdy połączenie zerwie się w trakcie zapisu, program nie wie, czy OMS go wykonał. Nagłówek `Idempotency-Key`
rozwiązuje to: ponów żądanie **z tym samym kluczem**, a OMS zamiast drugiego zapisu odda wynik pierwszego.

- Działa na `POST /produkty`, `PATCH /produkty/{id}` i `POST /stany/ruchy` (tu jest wymagany).
- Klucz: od 1 do 200 znaków, dowolny tekst. Najlepiej coś, co wynika z samej operacji (np. numer dostawy i SKU).
  Klucze są osobne dla każdego klucza API.
- OMS pamięta wynik przez **7 dni**.
- **Zapamiętywane:** sukcesy `2xx` i błędy `400`, `422`, `428`. Powtórka oddaje ten sam status i to samo ciało.
  Poprawione żądanie wysyłaj więc **z nowym kluczem** — także po `428` (dodanie brakującego `If-Match` do
  powtórki z tym samym kluczem odda zapamiętane `428`).
- **Niezapamiętywane:** `404`, `409` i `≥ 500`. Zależą od chwilowego stanu danych, więc cały zapis jest wycofany
  i powtórka z tym samym kluczem wykonuje się od nowa.
- Ten sam klucz użyty na innym adresie → `422 idempotencja`.
- Powtórka nie zwraca nagłówków `ETag` i `Location` z pierwszej odpowiedzi. Aktualny ETag daje `GET /produkty/{id}`.
- Ruch magazynowy ma dodatkowo trwały znacznik z kluczem. Ponowienie po 7 dniach, gdy wynik już zapomniany,
  nie dopisze drugiego ruchu: dostaniesz `409 idempotencja`.

## Bezpieczeństwo

- **API tylko za HTTPS poza siecią lokalną.** Klucz idzie w nagłówku każdego żądania; przez zwykłe HTTP w internecie
  może go przechwycić każdy po drodze. Zwykłe `http://` zostaw dla programów w tej samej sieci lokalnej co OMS.
  Wystawiając OMS na zewnątrz, postaw przed nim serwer z certyfikatem albo tunel — [instalacja w Dockerze,
  sekcja 7a „Dostęp spoza biura przez HTTPS”](../instalacja-docker.md#7a-dostęp-spoza-biura-przez-https).
- Jeden klucz na jeden program, z najmniejszymi potrzebnymi zakresami. Wtedy odwołanie jednego klucza nie zatrzymuje
  innych programów, a lista kluczy pokazuje, który program z czego korzysta.
- Klucz trzymaj jak hasło: w pliku konfiguracji programu albo menedżerze sekretów, nie w kodzie ani w repozytorium.
- OMS zapisuje w dzienniku wywołań API każdy zapis i każdy błąd (bez treści zapytania), przez 90 dni.
