# Kanał ERLI — podłączenie i codzienna praca

Instrukcja dla właściciela sklepu korzystającego z Twój OMS. Stan: 13.11.2026, etap 2.
Przykłady są fikcyjne: „Pracownia Półcień”, sklep `sklep.polcien.example`,
sklep ERLI o id `1000001`, zamówienie `PC-ERLI-0001`.

## Co daje połączenie

OMS pobiera zamówienia ERLI od wybranej daty startu. Na zamówieniu masz pozycje,
adres dostawy, punkt odbioru, pobranie i dane do faktury przekazane przez ERLI.
Widzisz też termin wysyłki wyliczony przez OMS z czasu realizacji pozycji.
Gdy brakuje czasu w pozycji i produkcie, używany jest czas domyślny z konfiguratora;
bez tych danych termin pozostaje nieustalony.

Po uruchomieniu zapisu OMS przekazuje do ERLI status realizacji i numer własnego kuriera
(niepotwierdzone na prawdziwym ERLI — zobacz akapit poniżej).
Rozpoznaje dwie drogi nadania: Przesyłki Erli na umowie ERLI oraz kuriera na umowie firmy.
Przesyłki Erli obsługują utworzenie paczki, etykietę PDF, protokół odbioru,
sprawdzanie stanu oraz anulowanie paczki, jeśli jej stan na to pozwala.
Zgłoszenia zwrotów od kupujących są widoczne na karcie zamówienia.

### Niepotwierdzone na prawdziwym ERLI (sprawdzone na atrapie)

Na atrapie sprawdzono rozpoznanie drogi nadania po słownikach, zapis statusów i numeru
listu do ERLI oraz Przesyłki Erli (etykietę i protokół). Nie potwierdzono tych działań
na prawdziwym ERLI ani opóźnienia widoczności zmian do około 20 minut.
Dlatego zacznij od trybu „Tylko odczyt” i porównania z panelem ERLI.

W ofertach nadal wymagają potwierdzenia: rozpoznanie kategorii (P2: sandbox nie
przypisał jej dla żadnego źródła), uprawnienia prawdziwego klucza (P7), pobieranie
zdjęć przez osobny tunel oraz pierwsza prawdziwa oferta. Pierwszą ofertę zatwierdza
właściciel po sprawdzeniu podglądu. Czas wysyłki tego samego dnia (`period: 0`)
oraz nazwa i obsługa pola `aiGenerated` w API ERLI także są niepotwierdzone.

## Przygotuj sklep i klucz API

1. Zaloguj się do panelu sprzedawcy ERLI na koncie właściwego sklepu.
2. Poszukaj ustawień integracji API i możliwości utworzenia lub skopiowania klucza.
   Dokładna ścieżka i nazwy opcji w panelu ERLI są **niepotwierdzone, sprawdź w panelu ERLI**.
   Jeśli nie widzisz takiej opcji, zapytaj obsługę ERLI o dostęp do własnej integracji API.
3. Klucz wklej bezpośrednio do pola „Klucz API” w OMS.
   Nie przesyłaj go w wiadomości, instrukcji ani na zrzucie ekranu.
4. Do prób załóż samodzielnie konto przez rejestrację na stronie sandboxa ERLI (`https://sandbox.erli.dev`).
   Klucz API pobierz z panelu sandboxa; klucz produkcyjny nie służy do tego środowiska.

Przed aktywacją ustal datę, od której zamówienia mają trafić do OMS.
Sprawdź też, czy ten sam sklep obsługuje już inny program oraz czy kurierzy
z umowy Twojej firmy są skonfigurowani w OMS.

## Dodaj sklep ERLI

W OMS otwórz **Ustawienia → Integracje → ERLI → Dodaj konto**
(otworzy się „Dodaj sklep ERLI”).
Obecny konfigurator ma cztery kroki opisane poniżej.

### 1. Nazwa, środowisko, klucz

1. Wpisz nazwę rozpoznawalną dla zespołu, np. „Pracownia Półcień — ERLI”.
2. Wybierz jedno z dwóch środowisk. Adres wybierasz z listy, nie wpisujesz własnego:
   - **ERLI — sklep**: `https://erli.pl/svc/shop-api`;
   - **ERLI — sandbox**: `https://sandbox.erli.dev/svc/shop-api` (samodzielna rejestracja, klucz z panelu sandboxa).
3. Wklej klucz API właściwy dla wybranego środowiska.
4. Opcjonalnie podaj domyślny czas wysyłki: od 0 do 365 dni roboczych.
   Puste pole pozostawia termin nieustalony, jeśli ERLI również nie poda czasu.
5. Kliknij **Zapisz dane sklepu**.

Po zapisaniu widzisz informację „klucz zapisany”; wartość klucza nie jest wyświetlana.
Przy późniejszej edycji puste pole zachowuje dotychczasowy klucz.
Zmiana klucza wymaga ponownego sprawdzenia połączenia i aktywacji.
Po pierwszej aktywacji środowiska sklepu nie można zmienić.

### 2. Sprawdź połączenie

Kliknij **Sprawdź połączenie**. Po powodzeniu zobaczysz nazwę oraz id sklepu,
np. „Sklep ERLI: Pracownia Półcień (id 1000001)” i informację, że połączenie działa.
Porównaj je z panelem ERLI, zanim przejdziesz dalej.

Ten sam sklep w tym samym środowisku nie powinien mieć dwóch połączeń w OMS.
Po wykryciu duplikatu OMS wstrzymuje oba kanały. Odłącz duplikat i sprawdź ponownie
połączenie, które ma pozostać używane.

### 3. Data startu

W polu **Zamówienia od dnia (wymagane)** wybierz datę z ostatniego roku,
nie późniejszą niż dzisiaj. Kliknij **Zapisz datę startu**.
Data oznacza początek pobierania zamówień, z uwzględnieniem dnia w Polsce.
**Po pierwszej aktywacji nie można jej zmienić**, również po wstrzymaniu połączenia.
Sprawdź datę przed kliknięciem „Aktywuj”.

### 4. Stan

Na początek zostaw zaznaczone **Tylko odczyt — import bez statusów i numerów**
i kliknij **Aktywuj**. Dla środowiska „ERLI — sklep” ten wybór jest domyślnie włączony.
OMS zacznie pobierać zamówienia bez przekazywania statusów i numerów do ERLI.

Po aktywacji możesz użyć następujących opcji:

- **Zapisz tryb odczytu** — zapisuje wybór przełącznika „Tylko odczyt”.
  „Tylko odczyt” blokuje też nadanie Przesyłką Erli: „ERLI: włączono tryb tylko odczyt.”
- **Wstrzymaj** — zatrzymuje pobieranie zamówień; **Wznów** je ponownie włącza.
  Blokuje też nadanie: „Kanał ERLI wyłączony — włącz pobieranie”.
  Wstrzymanie pobierania nie zastępuje trybu „tylko odczyt”.
- **Odłącz** — wymaga zaznaczenia „Potwierdzam odłączenie sklepu”.
  Wyłącza pobieranie i usuwa zapisany klucz z tego połączenia.

Jeżeli połączenie zostało ustawione w pliku konfiguracji przez administratora,
formularz nie pozwala go zmieniać. Poproś administratora o zmianę w konfiguracji.

## Pierwsze trzy dni: tylko odczyt

Przez trzy dni porównuj OMS z panelem ERLI dla tego samego przedziału dat:
liczbę zamówień, pozycje, kwoty, pobrania, adresy, punkty odbioru i metody dostawy.
Uwzględnij, że zamówienia nieopłacone (`pending`) są pomijane.
Sprawdź też zgłoszenia zwrotów i rozpoznaną drogę nadania na kilku kartach.

Jeśli sklep obsługuje inny program, oba korzystają z tej samej skrzynki zmian ERLI.
OMS uzupełnia zaległości z listy zamówień raz na dobę, więc brakujące zmiany
mogą pojawić się z opóźnieniem do doby.

Dopiero po zgodnym porównaniu wyłącz „Tylko odczyt” i zapisz wybór.
Pierwszą rzeczywistą paczkę nadaj świadomie z karty zamówienia, po sprawdzeniu danych.
Sam import w trybie odczytu nie jest próbą nadania ani potwierdzeniem gotowej etykiety.

## Dwie drogi nadania

Otwórz kartę zamówienia i sprawdź metodę wysyłki oraz wiersz „Nadanie”.
OMS rozpoznaje drogę według słowników metod dostawy ERLI (niepotwierdzone na prawdziwym
ERLI — zobacz akapit „Niepotwierdzone na prawdziwym ERLI (sprawdzone na atrapie)”).
Sama nazwa przewoźnika nie rozstrzyga,
czy korzystasz z umowy ERLI, czy z własnej umowy.

### Przesyłki Erli — umowa ERLI

Na karcie widać **Nadanie: Przesyłki Erli — …** z nazwą metody.
Sprawdź adres lub punkt odbioru, parametry paczki i pobranie przed nadaniem.
Przy pobraniu ERLI pobiera kwotę wynikającą z zamówienia; nie można ustawić innej kwoty.

Po zleceniu paczka może już istnieć w ERLI, zanim pojawi się numer i etykieta.
Jeśli karta pokazuje tworzenie przesyłki, poczekaj i użyj **Sprawdź ponownie**.
Nie twórz drugiej paczki w zastępstwie oczekującej.
Gdy ERLI przygotuje dokument, możesz pobrać lub wydrukować etykietę PDF.
Na liście przesyłek dostępny jest **Protokół odbioru** dla obsługiwanej paczki.
Anulowanie jest możliwe tylko przy potwierdzonym stanie sprzed odbioru przez kuriera;
w razie odmowy sprawdź paczkę w panelu ERLI.

### Twoja umowa z kurierem

Na karcie widać **Nadanie: Twoja umowa — …**, np. DPD lub Paczkomat InPost.
Nadajesz przez skonfigurowanego kuriera OMS na warunkach swojej firmy.
Po nadaniu OMS przekazuje numer przesyłki do ERLI (niepotwierdzone na prawdziwym ERLI).
Etykieta pochodzi od wybranego kuriera. Dla odbioru osobistego nie nadajesz paczki.

OMS nie ma modułu Kuriera InPost, więc paczkę z taką umową nadajesz na razie
w panelu ERLI albo u przewoźnika. Karta zamówienia od razu pokazuje blokadę nadania;
numer listu zarejestruj potem na karcie zamówienia.

Gdy metoda jest nieznana lub nie ma obsługiwanego kuriera, OMS blokuje nadanie
i pokazuje sprawę na karcie. Sprawdź cennik dostaw w panelu ERLI i konfigurację OMS.
Obecny czterokrokowy konfigurator nie zawiera osobnej tabeli mapowania metod
ani osobnego kroku punktu nadania; brak potrzebnych ustawień zgłoś administratorowi.

## Statusy, zwroty i ograniczenia

- Rozpoczęcie realizacji w OMS przekazuje do ERLI status realizacji,
  a wysłanie — status wysłania; przy odbiorze osobistym jest to gotowość do odbioru.
  Zapis statusów jest niepotwierdzony na prawdziwym ERLI — zobacz akapit powyżej.
  Status „nowe” niczego nie wysyła. OMS nie cofa wysłanych statusów.
- Anulowanie w OMS nie anuluje automatycznie zakupu w ERLI.
  Wykonaj anulowanie w panelu ERLI i sprawdź skutki dla płatności.
- Zamówienia `pending` są pomijane. Zamówienia spoza rynku PL lub w walucie innej
  niż PLN wymagają ręcznej obsługi. OMS nie oznacza obcej waluty ani na karcie, ani w sumach:
  kwota trafia do sum bez przeliczenia, więc sprawdzaj walutę w panelu ERLI i uwzględnij ją ręcznie.
  Przesyłki Erli odmówią nadania zamówienia w walucie innej niż PLN.
- Jeśli ERLI ma już inny numer listu, OMS pokazuje sprawę na karcie.
  Porównaj paczki w obu panelach, zanim podejmiesz dalsze działanie.
- Limit zapytań **429** powoduje przerwę i powrót w kolejnym przebiegu importu,
  bez oznaczania tego przebiegu jako błędu. Poczekaj, zamiast ponawiać wiele razy.
- Zapisane zmiany mogą być widoczne w ERLI z opóźnieniem do około **20 minut**.
  Ten czas jest niepotwierdzony na prawdziwym ERLI — zobacz akapit powyżej.
  Nie powtarzaj nadania tylko dlatego, że panel ERLI jeszcze się nie odświeżył.
- Na karcie sekcja **Zgłoszenie zwrotu z ERLI** pokazuje datę, powód, komentarz,
  pozycje i ilości. Link **Przejdź do ZWROTÓW** prowadzi do obsługi zwrotu.
  OMS nie zapisuje ani nie pokazuje numeru rachunku ze zgłoszenia i nie zwraca pieniędzy.
- OMS nie wysyła faktur do kupujących przez ERLI i nie obsługuje wiadomości
  ani rozliczeń platformy. Obsługę ofert opisano poniżej.

## Klient produktów (PRZ-160 E2.03)

Warstwa klienta używana przez wystawianie w panelu i pętlę synchronizacji.
Nowe metody i ich jedyne dozwolone żądania:

| Metoda klienta | HTTP | Ścieżka | Argumenty |
|---|---|---|---|
| `utworzProdukt` | POST | `/products/{externalId}` | `externalId, dane` |
| `zmienProdukt` | PATCH | `/products/{externalId}` | `externalId, dane` |
| `zmienProdukty` | PATCH | `/products/batch-update` | tablica produktów z `externalId` |
| `szukajProduktow` | POST | `/products/_search` | ciało wyszukiwania (domyślnie `{}`) |

Klient koduje identyfikator w ścieżce. Puste identyfikatory, `.` i `..`, `batch-update`
oraz prefiks `_` są zastrzeżone. Odrzuca klucz `archived` na każdym poziomie każdego
ciała żądania, także z wartością `false` (archiwizacja jest nieodwracalna).
Wyłączenie produktu przekazuje się przez `status: inactive`.

Te cztery metody ponawiają 429 najwyżej dwa razy (łącznie trzy próby), przez
wstrzykiwane `czekaj(ms)`. Uwzględniają `Retry-After` w sekundach lub jako datę HTTP;
bez poprawnego nagłówka przerwy wynoszą 1 i 2 s. Odstęp większy niż zakres timera
Node oddaje 429 wywołującemu. Pozostałe błędy nie są automatycznie ponawiane.
Dotychczasowe metody zamówień i przesyłek nadal oddają 429 wywołującemu.

Błąd HTTP ma `status`, `kod` (`ERLI_409` rozpoznaje konflikt), `chwilowy`
(`true` dla 429 i 5xx) oraz `odpowiedz` z treścią błędu HTTP (z ukryciem odbitych
wartości ciała i klucza API). 400/404/409 są trwałe. Konflikt nigdy sam nie uruchamia
PATCH — decyzję podejmuje wywołujący według D10. Odpowiedź 202 z ciałem wraca
do wywołującego; `updatedFields: []` pozostaje widoczne, np. przy zamrożonym polu.

`zmienProdukty` zwraca tablicę w kolejności żądania, dopasowując wyniki po `externalId`.
Pozycja ze statusem >=400 zachowuje odpowiedź ERLI i dostaje pole `blad`
(`Error` z `status`, `kod`, `chwilowy`, `odpowiedz`); pozostałe pozycje zachowują wynik.
Niekompletny wynik, powtórzone identyfikatory i wynik o innym kształcie są błędem.
Fixture testów jest syntetyczny, na podstawie opisów pomiarów P1/P3/P6/P-stan/P-arch;
nie zawiera surowych danych sklepu ani dowodu działania na prawdziwym ERLI.

## Oferty z OMS-u

Na karcie w **MAGAZYNIE** wybierz wystawienie na ERLI i konto sklepu.
Najpierw otwórz **podgląd**: sprawdź treść, zdjęcia, kategorię, cenę, ilość
i komunikaty. Uzupełnij braki blokujące, ponów podgląd i dopiero **zatwierdź**.
Zatwierdzenie dodaje ofertę do kolejki; nie oznacza jeszcze, że można ją kupić.

W ustawieniach konta osobny przełącznik **Oferty: wstrzymane / czynne** steruje
zapisem ofert. Domyślnie jest wstrzymany, także w demo: możesz oglądać stany,
podgląd i odczyty, ale OMS niczego nie zapisuje w ERLI. Do wysyłania potrzebne są
czynne oferty oraz wyłączony tryb „Tylko odczyt”. Sprawdź też domyślne dane konta:
czas wysyłki, cennik dostaw i VAT.

Cena ERLI to cena brutto karty powiększona o **narzut konta**, zaokrąglona do grosza.
Narzut domyślnie wynosi 0%. Brak ceny blokuje wystawienie. Z Woo importujemy cenę
regularną; przy cenach netto trzeba uzupełnić cenę brutto na karcie.
Zmiany ceny lub narzutu są synchronizowane. Zmiana **większa niż 20%** względem
ceny odczytanej z ERLI czeka na potwierdzenie na liście ofert; próg można zmienić
w ustawieniach konta. Do potwierdzenia pozostaje dotychczasowa cena w ERLI.

**Ilość** jest stałą liczbą ustawianą na koncie przed wystawieniem, bez wartości
domyślnej. OMS przywraca ją po zakupie. Obecnie dotyczy to także instalacji
z włączonymi stanami magazynu; synchronizacja z rzeczywistym stanem jest planowana
w etapie 4. W demo stała ilość wynosi 5 sztuk.

Oferty utworzone ręcznie w ERLI znajdziesz na ekranie **Powiązania**:
**pobierz → przejmij obserwowaną → obejmij zarządzaniem**. Sprawdź dopasowanie
po EAN lub SKU, ewentualnie wskaż kartę ręcznie. Oferta zachowuje identyfikator.
Obserwowana jest tylko odczytywana; OMS nie zmienia jej ceny, ilości ani treści.
Objęcie zarządzaniem wymaga podglądu zmian, w tym obecnej i docelowej ceny i ilości.

### Cennik dostaw według rozmiaru

W kroku „Oferty” ustawień konta ERLI jest sekcja „Cennik dostaw według rozmiaru”. Pierwszy wiersz to
„Cennik domyślny”. Poniżej możesz dodać wiersze dla mniejszych produktów: „Do wymiarów (cm)”,
„Do wagi (kg)” i „Cennik”. Nazwę cennika wybierasz z listy, którą OMS pobiera razem z
metodami dostawy w kroku 3. Bez pobrania metod w kroku 3 pozostaje pole tekstowe do wpisania nazwy.
Przykład dla „Pracowni Półcień”:

| # | do wymiarów (cm) | do wagi (kg) | cennik |
|---|---|---|---|
| — | Cennik domyślny | | kurier-gabaryt |
| 1 | 8 × 38 × 64 | 25 | paczkomat-a |
| 2 | 41 × 38 × 64 | 25 | paczkomat-c |

OMS sprawdza wiersze rozmiaru od góry i bierze pierwszy, w którym produkt się mieści (wymiary w dowolnym ułożeniu,
wartość równa granicy też się mieści), więc wpisuj od najmniejszej reguły. Produkt większy od wszystkich dostaje
cennik domyślny; to pole jest wymagane, gdy są reguły rozmiaru. Sam „Cennik domyślny” oznacza jeden cennik
dla wszystkich ofert. Nad tabelą jest podpowiedź z gabarytami paczkomatu InPost; OMS ich nie pilnuje.

Wyjątek dla jednej karty ustawiasz na karcie w Magazynie, w sekcji „Cennik dostaw”: pole „Cennik dostaw —
wyjątek” przy koncie ERLI (puste = reguły konta), potem „Zapisz cennik dostaw”. Podgląd pokazuje linię
„Cennik: <identyfikator> — <powód>” i dopisek „(reguły dałyby: …)”, gdy wyjątek różni się od reguł. Przy regułach
rozmiaru karta bez wymiarów lub wagi dostaje odmowę „Brak wymiarów/wagi — OMS nie wie, czy produkt zmieści się
w paczkomacie. Uzupełnij wymiary albo ustaw cennik na karcie.” — uzupełnij je albo ustaw wyjątek. Konto bez
reguł: „Konto nie ma ustawionego cennika dostaw.”

Zmiana reguł, wyjątku albo wymiarów karty zmienia cennik także w żywych ofertach. Gdy reszta treści oferty się nie
zmieniła, pętla wysyła samą dostawę (PATCH `deliveryPriceList`). Oferta wystawiona przed tą zmianą dostaje przy
pierwszej zmianie pełny zapis. Pole zamrożone w ERLI nie jest zmieniane. W kodzie pętli ERLI nie ma osobnego
limitu zapisów na przebieg, jak w Allegro (tam 50 na konto, 40 dla PATCH-y treści); zapis idzie przez zwykłą
bramkę (wstrzymane oferty, tryb „Tylko odczyt”).

### Ilość z OMS

Gdy w OMS-ie włączysz stany magazynowe i zatwierdzisz stan otwarcia (patrz rozdział „Stany w kanałach” w dokumencie o magazynie),
OMS wysyła do ERLI ilość karty pomniejszoną o bufor konta. Wystawione z OMS-u oferty dostają ją zawsze, przejęte —
dopiero po „Obejmij stany”.

- **Jak:** pole `stock` produktu, hurtem po 100 pozycji w jednym żądaniu. Przebieg ofert ERLI chodzi co 5 minut,
  a nowe zamówienie albo ruch magazynowy przyspiesza go (nie częściej niż co minutę). Obniżki idą przed podwyżkami.
- **Zero:** przy 0 OMS wysyła `stock: 0`. ERLI zwykle pokaże taką ofertę jako niekupowalną; nie trzeba jej wznawiać.
  Gdy stan wzrośnie, następny przebieg ustawia nową ilość.
- **Zamrożona ilość:** jeśli ilość produktu została w ERLI zablokowana ręczną zmianą (pole `frozen`), ERLI pomija
  zapis po cichu. OMS tego nie obchodzi: pokazuje problem „Ilość oferty jest zamrożona” i nie ponawia. Odblokuj
  pole w panelu ERLI. Takiej oferty nie da się też objąć stanami.
- **Ujemny odczyt** (ERLI dopuszcza wartości poniżej zera) OMS traktuje jak odczyt i nie zakłada, że to błąd.
- **Przejęte oferty** zmieniają tylko ilość. Treść, cena i status zostają takie, jak ustawiłeś w ERLI.
- **Nieznany stan karty** nie daje zera: oferta zostaje z ilością z ERLI.
- ERLI nie oddaje sztuk po anulowaniu zamówienia. OMS oddaje je na stan karty i podniesie ilość w ERLI, gdy odczyt
  jest stabilny (zwykle następny przebieg).

Sprawdzone na atrapie ERLI. Na prawdziwym ERLI nie sprawdzono limitu pozycji w jednym żądaniu zbiorczym
ani zachowania przy zamrożonym `stock`, poza opisanym w dokumentacji ERLI. Zaczynaj od kilku ofert.

### Zdjęcia i adres publiczny

ERLI musi samodzielnie pobrać zdjęcia z publicznych adresów. Zdjęcia sklepu mogą
korzystać z adresów źródłowych. Dla kopii w OMS administrator ustawia
`OMS_PUBLICZNY_ADRES_ZDJEC`, wskazujący serwer zdjęć z samą ścieżką `/z/*`.
Bez takiego adresu zdjęcia dostępne wyłącznie w OMS blokują podgląd.
W sieci domowej potrzebny jest osobny serwer zdjęć i tunel **wyłącznie do zdjęć**;
nie wystawiaj panelu OMS ani tunelu z panelu. Tunel zdjęć nie został jeszcze sprawdzony.
Problem pobrania konkretnego zdjęcia wymaga sprawdzenia jego publicznego adresu.

### Zdjęcia wygenerowane przez AI

Znacznik ERLI dotyczy wyłącznie **zdjęć**, nie tekstu opisu. Przy imporcie z Allegro
OMS bierze go tylko z deklaracji zdjęć oferty, nie z deklaracji produktu katalogowego
ani na podstawie treści opisu. OMS jeszcze nie wysyła tego znacznika do ERLI;
pole `aiGenerated` w API pozostaje niepotwierdzone. Nie traktuj importu jako
potwierdzenia oznaczenia zdjęć w ERLI.

### Stany i problemy

| Stan | Co oznacza dla sprzedawcy |
|---|---|
| szkic | Oferta jeszcze nie trafiła do kolejki. |
| do wysłania | Zatwierdzona, oczekuje na zapis; sprawdź przełączniki konta. |
| wysłana | OMS podjął wysyłkę, czeka na potwierdzenie zapisu. |
| sprawdzana | Zapis przyjęty; OMS czeka na wynik odczytu z ERLI. |
| aktywna | ERLI zwraca aktywny status; sprawdź też problemy przy ofercie. |
| nieaktywna | Oferta jest wyłączona w ERLI. |
| problem | Sprawdź opis przy ofercie; np. przypisz kategorię w panelu ERLI. |
| błąd | Zapis nie powiódł się; popraw wskazaną przyczynę przed ponowieniem. |

**Cena czeka na potwierdzenie** to sytuacja przy ofercie aktywnej z problemem ceny:
nowa cena przekracza próg, więc sprawdź ją przed zgodą.
**Przejęta obserwowana** oznacza pochodzenie i tryb oferty: OMS czyta jej stan
(np. „aktywna”), ale nią nie zarządza. To nie są dodatkowe stany.

Scenariusz braku kategorii pokazuje: „ERLI nie rozpoznało kategorii — przypisz ją w panelu ERLI”.
Kod problemu `category` jest sprawdzony na atrapie, ale niepotwierdzony na prawdziwym ERLI (P2).
Samo wysłanie nie gwarantuje aktywnej sprzedaży. Problemy zdjęć, warunków sklepu
czy zamrożonych pól wymagają usunięcia przyczyny. Błędy połączenia, 5xx i limit 429
są ponawiane z przerwą; błędy danych zatrzymują zapis.

**Zdejmij ofertę** wyłącza ją (`inactive`), bez nieodwracalnej archiwizacji.
Wycofanie karty wyłącza jej oferty zarządzane. Gdy produkt znika z odczytu ERLI,
OMS zgłasza problem — sprawdź go w panelu ERLI zamiast zakładać ponownie.
Demo „Pracownia Półcień” pokazuje sześć powyższych przypadków na kartach lamp,
przy wstrzymanym zapisie ofert.

## Rozwiązywanie problemów

Poniższe komunikaty są przytoczone dosłownie z OMS.

- **„Nieprawidłowy klucz API. Sprawdź klucz w panelu ERLI.”**
  Sprawdź środowisko i klucz właściwego sklepu, zapisz dane i ponów test połączenia.
- **„Formularz jest nieaktualny. Odśwież ekran.”**
  Odśwież stronę i ponów swoją zmianę na aktualnych danych.
- **„Daty startu nie można zmienić po pierwszej aktywacji.”**
  Data jest już zablokowana. Nie odłączaj sklepu w celu obejścia blokady;
  potrzebę pobrania starszych zamówień uzgodnij z administratorem.
- **„ERLI ma już inny numer przesyłki — sprawdź w panelu ERLI”**
  Porównaj numer w ERLI z paczką w OMS i ustal, która paczka ma zostać wysłana.
- **„ERLI oddało etykietę, która nie jest plikiem PDF.”**
  Nie drukuj dokumentu. Sprawdź istniejącą paczkę w ERLI przed ponowieniem pobierania.
- **„Nie udało się pobrać protokołu odbioru. Spróbuj ponownie.”**
  Spróbuj pobrać protokół później; jeśli problem wraca, sprawdź paczkę w panelu ERLI.
