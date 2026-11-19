# Magazyn — karty produktów

Karta opisuje produkt w Twojej firmie. Może łączyć produkt ze sklepu
z ofertami z kilku kont Allegro. Dane na karcie są wspólne,
a sekcja „Produkty i oferty” pokazuje powiązania ze źródłami.

## Co zawiera karta

- Nazwę produktu, własny SKU i EAN.
- Cenę brutto regularną oraz stawkę VAT.
- Wymiary i wagę, używane także przy przygotowaniu przesyłek.
- Opis podzielony na sekcje tekstowe i zdjęciowe.
- Galerię do 20 zdjęć, we wskazanej przez Ciebie kolejności.

Nie każde źródło dostarcza komplet danych. Brak wartości można
uzupełnić ręcznie na karcie; brak wymiaru nie oznacza wymiaru zero.
Kategorię, parametry i inne dane specyficzne dla serwisu zobaczysz
w części dotyczącej danych kanału.

## Odczyt ze sklepu WooCommerce

„Odczytaj katalogi” odczytuje produkty i warianty sklepu.
Treść uzupełnia na kartach już powiązanych z tymi produktami.
Jeśli produkt nie ma jeszcze karty, utwórz ją z niepowiązanych produktów
i ponów odczyt, aby uzupełnić pełny opis i galerię.

OMS czyta pełny opis `description`. Dla wariantu może użyć opisu
rodzica, a gdy go brakuje — krótkiego opisu rodzica.
Formatowanie jest czyszczone do bezpiecznych nagłówków, akapitów,
pogrubień i list. Zdjęcia Woo pozostają odnośnikami do sklepu;
galeria wariantu może obejmować jego zdjęcie oraz zdjęcia rodzica.

EAN przychodzi wyłącznie z `global_unique_id` produktu lub wariantu.
OMS nie szuka go w dowolnych polach dodatkowych sklepu.
Cena karty pochodzi z ceny regularnej `regular_price`, nie z promocji.
Gdy sklep nie nalicza podatków, ta cena może być przyjęta bez przeliczeń.
Gdy nalicza podatki, OMS musi potwierdzić, że ceny sklepu zawierają VAT.
Przy cenach netto albo braku potwierdzenia cena regularna nie jest
importowana do pola ceny brutto karty; istniejąca cena pozostaje chroniona.

## Treść z Allegro

Sama lista ofert nie zawiera pełnej treści. Użyj osobnego przycisku
„Pobierz treść i zdjęcia ofert”. Dotyczy ofert powiązanych z kartami.
Opis jest pobierany w sekcjach, zdjęcia są kopiowane do OMS-u,
a VAT pochodzi z `taxSettings` oferty, dla Polski.

Jeśli jedna karta ma kilka ofert z tego samego konta, OMS wybiera
aktywną o najniższym id w swoim rejestrze powiązań. Gdy nie ma aktywnej,
wybiera najniższe id spośród ofert, które nie zniknęły z katalogu.
Na karcie można też wskazać „Weź treść z tej oferty”.
Ekran pobierania przypomina o zasadach Allegro dotyczących użycia treści.

## Źródła pól i ochrona własnych zmian

Etykiety przy polach pokazują pochodzenie wartości, np. sklep,
konto Allegro, wpis ręczny albo wartość zastaną.
Import nie nadpisuje wartości zastanych ani poprawionych ręcznie.
Również ręczne wyczyszczenie pola chroni je przed kolejnym importem.

Wartość wcześniej pobrana może zostać odświeżona przez to samo źródło.
Przy kilku połączeniach decyduje lista źródeł w Ustawienia → Zamówienia i magazyn → Stany magazynowe:
wyższe połączenie może zastąpić wartość z niższego. Domyślnie sklepy Woo
są przed kontami Allegro. Kolejność dotyczy konkretnych połączeń;
możesz ją zmienić dla swojej firmy.

## Nowa karta i edycja opisu

Przycisk „Nowa karta” pozwala założyć produkt ręcznie.
Po zapisaniu podstawowych danych otwórz kartę, aby dodać opis i zdjęcia.

Edytor opisu składa się z sekcji po 1–2 elementy: tekst lub zdjęcie.
Dodawaj i usuwaj sekcje, zmieniaj ich kolejność, wybieraj zdjęcia z galerii.
Tekst może mieć nagłówki, akapity, pogrubienia i listy.
Podgląd pozwala sprawdzić treść przed zapisaniem opisu.

## Galeria i braki danych

W galerii możesz zmieniać kolejność, usuwać zdjęcia i wgrywać własne pliki.
Limit to 20 zdjęć na kartę i 10 MB na pojedynczy plik.
Obsługiwane formaty to JPEG, PNG i WebP.
Przy pobieraniu zdjęć Allegro błędy chwilowe są ponawiane do 3 prób
łącznie, z odstępami 2 i 10 sekund. Błąd trwały, np. brak pliku,
nie powoduje kolejnych automatycznych prób. Komunikat na karcie
pozwala rozpoznać nieudane pobranie i ponowić pracę po usunięciu przyczyny.

Kafle braków nad listą pomagają znaleźć karty bez SKU, wymiarów,
kategorii albo decyzji o paczkomacie. Kliknięcie kafla zawęża listę
do kart wymagających uzupełnienia. Brak opisu i pustą galerię
rozpoznasz po komunikatach na karcie produktu.
Liczby na kaflach dotyczą całego katalogu, także przy zawężonej liście.

## Akcje dla kart na liście

- **Wystaw oferty** otwiera wybór konta i podgląd wystawiania.
- **Edytuj** pokazuje podgląd zmian pól na wielu kartach.
- **Nadaj SKU** proponuje nowe numery pustym kartom. Jeśli można przejąć numer z powiązanego produktu,
  generator pokazuje powód pominięcia karty. Jej numer uzupełni import ze sklepu.
- **Wyślij SKU i wymiary** pokazuje podgląd wartości do wysłania do WooCommerce. Zapis następuje po zatwierdzeniu.

## Allegro na karcie i mapy do Allegro

Stan: 14.11.2026. Pełna instrukcja wystawiania ofert: „Allegro — wystawianie ofert z OMS-u”
(w repozytorium: `docs/kanal-allegro-oferty.md`). Ekrany poniżej wymagają zgody konta na oferty.

**Mapa kategorii.** Magazyn → Kategorie → kategoria (np. „Lampy stołowe”) → Allegro. Wybierasz środowisko
(Produkcja albo Sandbox), kategorię najniższego poziomu z podpowiedzi albo wpisujesz numer, „Zatwierdź kategorię”.
Poniżej ustawiasz regułę każdego wymaganego parametru: stała, pole karty (z przelicznikiem) albo „wpisywana na
karcie”. Ekran liczy, ile kart ma komplet parametrów.

**Mapa marek.** Magazyn → Marki → marka → Allegro. Wybierasz wartość ze słownika marek Allegro i „Zatwierdź
markę”. Jeśli w którejś przypisanej kategorii słownik tej wartości nie zna, ekran to wypisuje. Producent (dane
o bezpieczeństwie produktu) wybierasz osobno, w ustawieniach konta Allegro, krok „Oferty”.

**Sekcja „Allegro” na karcie.** Pokazuje „Gotowa do wystawienia” albo listę „Przed wystawieniem uzupełnij”
z odnośnikami, uwagi niezablokowujące wystawienia, kategorię i jej źródło, produkt w katalogu Allegro i tabelę parametrów
(gwiazdka = wymagany przez Allegro). Możesz tu ustawić „Nazwę dla Allegro” (licznik z limitem 75 znaków, „&” liczy
się jak 5), „Wyjątek kategorii” oraz nadpisać wybrane parametry. „Zapisz dane Allegro” zapisuje. Gdy Allegro ma
kilka produktów dla tego EAN, pojawia się wybór „Produkt z katalogu Allegro” z przyciskiem „Użyj tego produktu”.

**Wystaw oferty (Allegro).** Na liście kart zaznacz karty i użyj „Wystaw oferty”, wybierając konto Allegro; dalej
podgląd i „Zatwierdź”, jak przy ERLI. Karta, która ma już ofertę na tym koncie, jest odrzucana. Oferta powstaje
najpierw jako nieaktywny szkic; aktywujesz ją przyciskiem „Aktywuj w Allegro” (przy ustawieniu „Aktywuj po
sprawdzeniu: Nie”).

## Ceny w kanałach

Przykłady są zmyślone: „Pracownia Półcień”, konto `polcien`.

Cenę sprzedaży ustawiasz raz, na karcie produktu, a OMS rozsyła ją do kanałów. **OMS jest źródłem ceny**:
to, co wpiszesz na karcie, trafia na oferty w ERLI, Allegro i w sklepie WooCommerce.

- **Cena docelowa.** To cena brutto z karty powiększona o narzut konta. Karta za 100 zł i narzut 10% daje
  w kanale 110 zł.
- **Narzut konta.** Każde konto kanału (np. `polcien`) ma własny narzut w procentach. Ustawisz go w ustawieniach
  ofert tego konta. Bez narzutu cena w kanale równa się cenie z karty.
- **Ręczna cena kanału.** Gdy dla jednego konta chcesz innej kwoty, wpisz ją na karcie przy tym kanale. Ręczna
  cena zastępuje narzut tylko tam. „Wróć do narzutu” usuwa ją i cena znów jest liczona z karty.
- **Podgląd.** Na liście magazynu zaznacz karty i wybierz „Wyślij ceny do kanałów”. Zanim cokolwiek pójdzie
  do kanału, widzisz tabelę: cena teraz, cena docelowa i różnica. Wiersze, których nie wolno zmienić, są
  **pominięte** i mają powód, np. „trwa promocja … zł — pominięte” (trwającej promocji w sklepie nie nadpisujemy),
  „sklep liczy ceny netto”, „klucz tylko do odczytu”, „oferty wstrzymane”. Zmiana większa niż próg konta
  (w Woo 50%) jest **odznaczona** — włączysz ją sam, jeśli to nie pomyłka.
- **Zatwierdzenie.** Wysyłają się tylko zaznaczone wiersze. OMS przed wysłaniem jeszcze raz sprawdza, czy stan
  w kanale się nie zmienił od podglądu. Każdy zapis trafia do historii zmian na karcie (kto, kiedy, stara i nowa
  wartość, wynik).
- **Ukrycie = szkic.** Na karcie możesz ukryć produkt w sklepie. Produkt nie jest kasowany, dostaje status
  „szkic” i znika z witryny. Przywrócisz go jednym przyciskiem. Powiązany szkic nadal należy do karty.
- **ERLI zarządzane.** Cenę w ERLI zmieniamy tylko na ofertach, które OMS prowadzi (tryb zarządzany). Oferta
  tylko obserwowana, zarchiwizowana albo z ręcznie zablokowaną ceną jest w podglądzie pominięta z powodem.
- **Hamulec kanału.** Gdy konto jest wstrzymane albo ma klucz tylko do odczytu, żadna cena nie pójdzie, choćbyś
  zatwierdził podgląd. Sprawdzenie następuje tuż przed samym wysłaniem.

## Stany w kanałach

Stan: 14.11.2026 (PRZ-160, etap 4). Przykłady są zmyślone: „Pracownia Półcień”, konto `polcien-allegro`,
sklep `sklep.polcien.example`.

Gdy włączysz stany magazynowe (Ustawienia → Zamówienia i magazyn → Stany magazynowe), OMS zna ilość każdej karty. Ta funkcja idzie krok dalej:
**OMS wysyła tę ilość na oferty w ERLI, Allegro i w sklepie WooCommerce**. Sprzedasz sztukę w jednym miejscu,
a po chwili w pozostałych kanałach ilość spada. Bez tej funkcji każdy kanał liczy sztuki osobno i łatwo sprzedać
ten sam egzemplarz dwa razy.

Funkcja jest **domyślnie wyłączona i nic nie wysyła, dopóki jej świadomie nie uruchomisz**. Ekrany stanów w kanałach
są tylko dla administratora. Dotąd sprawdzono je na atrapach kanałów, nie na prawdziwych kontach (szczegóły niżej
i w dokumentach poszczególnych kanałów).

### Jak liczona jest ilość na ofercie

`ilość w kanale = stan karty − bufor konta`, nie mniej niż 0.

- **Bufor** ustawiasz osobno dla każdego konta kanału (domyślnie 0). Bufor 1 oznacza, że w kanale zawsze zostaje
  jedna sztuka „zapasu”, zanim OMS pokaże 0.
- Każde konto dostaje swoją ilość. Sztuk nie dzielimy między konta: dwa konta Allegro z tą samą kartą pokażą obie
  pełny stan (minus bufor).
- Jeśli karta ma kilka ofert na jednym koncie, każda dostaje pełną ilość. Podgląd ostrzeże, że w krótkim czasie
  można sprzedać więcej, niż jest na stanie. Wyjściem jest bufor konta.
- **Stan nieznany nigdy nie oznacza zera.** Karta, której stanu otwarcia nie ustalono, nie zmienia oferty:
  oferta zostaje z ilością, jaką ma w kanale.
- Ceny i treść ofert działają jak dotąd. Ta funkcja dotyczy wyłącznie ilości.

Ilość z OMS idzie do kanału w kilka minut od zmiany. Nowe zamówienie, ręczny ruch magazynowy albo zmiana
powiązania przyspiesza przebieg (nie częściej niż co minutę).

### Dwa rodzaje ofert

- **Oferta wystawiona z OMS-u** dostaje ilość z OMS zawsze, gdy stany są włączone i zatwierdzone.
- **Oferta przejęta** to oferta, która już istnieje w kanale (wystawiona ręcznie albo gdzie indziej). Przejęcie
  powiąże ją z kartą, ale niczego w kanale nie zmienia. Dopiero „Obejmij stany” włącza dla niej wysyłanie
  **samej ilości**. Treści i ceny przejętej oferty OMS nie rusza.

### Przejęcie istniejących ofert

Magazyn → „Stany w kanałach” (administrator):

1. Wybierz konto kanału i „Pokaż podgląd przejęcia”. Podgląd pokazuje oferty z katalogu kanału, kartę, do której
   OMS je dopasował, i ostrzeżenia: oferty bez jednoznacznej karty, karty bez znanego stanu, oferty zakończone,
   fulfillment (Allegro może odmówić zmiany ilości), sklep Woo, który nie prowadzi własnych stanów, oraz
   `backorders` w Woo (sklep może przyjmować zamówienia ponad stan). Podgląd jest ważny 30 minut.
2. „Przejmij oferty z jednoznaczną kartą” zapisuje powiązania w OMS.
3. Zaznacz przejęte oferty i „Pokaż podgląd objęcia”: dla każdej widzisz ilość w kanale, cel OMS po buforze i skutek.
   „Obejmij stany” włącza wysyłanie ilości, ale **wysyłka i tak czeka na zatwierdzenie stanów** (niżej).

Jeśli konto ma wstrzymane oferty („Oferty: wstrzymane”), podgląd mówi to wprost: stany nie pójdą, dopóki nie
ustawisz „Oferty czynne”. Konto w trybie tylko do odczytu (klucz bez zapisu) też niczego nie wyśle.

### Stan otwarcia

Zanim OMS wyśle ilości, musi wiedzieć, ile masz sztuk **teraz**. Ustawienia → Zamówienia i magazyn → Stany magazynowe, po włączeniu stanów:
„Stan otwarcia z kanałów”.

- OMS czyta na świeżo ilości z kanałów, z którymi karta jest powiązana: Allegro i ERLI zawsze, Woo tylko wtedy, gdy
  sklep prowadzi stany dla tego produktu (`manage_stock`). Odczyt jest ważny 30 minut.
- Do odczytu dolicza sprzedaż **tego samego konta** od chwili włączenia stanów, bo kanał już ją zdjął. Ekran
  pokazuje rachunek, np. „odczyt 4 + 1 sprzedane od włączenia = 5”. Sprzedaży z innych kanałów nie dolicza.
- **Propozycja to najmniejsza wartość** z kanałów prowadzących stan. Powód: zawyżony stan otwarcia kończy się
  sprzedażą sztuki, której nie masz. Wartość ze sklepu Woo (jeśli prowadzi stan) jest widoczna obok ze znacznikiem
  „różnica”, gdy się różni.
- **Sklep, który nie prowadzi stanów, nie jest źródłem otwarcia.** Wtedy źródłem są marketplace'y albo import
  tekstem czy wartość wpisana ręcznie.
- **Każdą wartość zatwierdzasz Ty** i możesz ją zmienić przed zapisem. Pusty wiersz pomija kartę. Brak odczytu nie
  oznacza zera: wpisz ilość ręcznie. Zapis działa też dla 0.
- Istniejącego otwarcia ekran nie nadpisuje. Poprawiasz je korektą na karcie.
- Przy **ponownym włączeniu** stanów pojawia się „Kontynuuj od stanu z wyłączenia”: stan z chwili wyłączenia
  minus zamówienia z przerwy.

### Zatwierdzenie stanów (pierwszy bezpiecznik)

Po zapisie otwarcia ekran pokazuje podgląd skutków dla każdego konta: ile ofert dostanie **obniżkę**, **podwyżkę**,
ile zostanie bez zmian, ile **spadnie do zera**, ile będzie zablokowanych, oraz pozycje bez karty. „Zatwierdź”
dopiero uruchamia wysyłanie ilości. Do tego czasu ceny i treść działają jak zawsze, a ilość stoi.

Podgląd jest ważny 30 minut. Nowy ruch magazynowy, zmiana ofert albo zmiana bufora wymaga nowego podglądu (nowe
zamówienie nie, bo pętla policzy je sama). Zatwierdzenie dotyczy bieżącego włączenia: po wyłączeniu i ponownym
włączeniu zatwierdzasz od nowa.

### Pozostałe bezpieczniki

OMS woli niczego nie wysłać niż wysłać zły stan. Gdy coś jest niejasne, oferta zostaje **wstrzymana** i trafia na
„Problemy ofert”.

- **Skok.** Stan karty zmienił się o więcej niż próg (domyślnie 5 szt.), a zmiany nie tłumaczą zamówienia ani ruchy
  magazynowe. Oferta czeka na „Potwierdź skok”. Bufor skoku nie wywołuje.
- **Rozjazd z kanałem.** OMS po każdym zapisie sprawdza, czy ilość w kanale mieści się w zakresie, który tłumaczą
  zamówienia złożone od wysyłki. Gdy kanał pokazuje **mniej**, niż wynika z OMS, po krótkiej karencji oferta
  się wstrzymuje i wybierasz „Wyślij stan OMS” albo „Przyjmij stan kanału” (zapisuje korektę w magazynie).
  Gdy kanał pokazuje **więcej**, OMS od razu obniża do swojego celu i zostawia alarm do potwierdzenia
  („Przyjąłem”) — dopisz wtedy przyjęcie towaru, jeśli ono było.
- **Wiele ofert naraz do zera.** Jeśli w jednym przebiegu co najmniej 3 oferty konta i co najmniej połowa jego ofert
  z ilością z OMS miałyby spaść do 0, ilość tego konta stoi. Sprawdź stany i potwierdź jednym kliknięciem „Wyślij zera”
  na konto. Zwykle to znak, że stan otwarcia jest zły.
- **Podwyżka tylko na pewnych danych.** Ilość większą niż ta w kanale OMS wyśle dopiero, gdy odczyt kanału jest
  stabilny, a zamówienia konta były pobrane po tym odczycie. Zwykle opóźnia to podwyżkę o jeden przebieg
  (do ok. 5 min). Obniżki idą zawsze i **przed** podwyżkami. Brakuje pobierania zamówień dla konta — podwyżki stoją.
- **Zbyt częste wznawianie.** Ekran zna problem „Oferta wznawiana przez OMS ponad 3 razy na dobę — wznów ręcznie”.
- **Ofert bez karty** OMS nie obejmuje. „Pozycje bez karty” pokazują, co trzeba powiązać.

### Ekran „Problemy ofert”

Magazyn → „Problemy ofert”, filtr „Ilość”. Wiersz ma przycisk dopasowany do problemu: „Potwierdź skok”,
„Wyślij stan OMS”, „Przyjmij stan kanału”, „Przyjąłem”, „Uzupełnij stan otwarcia” (gdy karta nie ma znanego stanu),
a przy ofertach Allegro także „Wznów” i „Ponów”. Przyciski zapisują decyzję w OMS-ie, a do kanału wysyła ją
pętla przy najbliższym przebiegu. Problem ilości trzeba rozwiązać przed „Wznów”. „Ponów” przy ofercie, której
nie ma już na Allegro, OMS odrzuca — taką ofertę trzeba odpiąć albo wystawić od nowa. Gdy Allegro 5 razy z rzędu
odrzuci treść oferty (błąd 4xx), pętla przestaje ją wysyłać i zostawia problem z prośbą o poprawienie karty
produktu. Problemy konfiguracji sklepu Woo
(„sklep nie prowadzi stanu produktu”, „wariant korzysta ze stanu rodzica”) znikają dopiero po zmianie ustawień
sklepu; OMS sam nie przełącza `manage_stock`.

### Wyłączenie stanów

Ustawienia → Zamówienia i magazyn → Stany magazynowe → „Wyłącz stany”. Wyłączenie działa od razu i nic nie kasuje:

- oferty wystawione z OMS-u wracają do **stałej liczby sztuk** z ustawień konta,
- przejęte oferty przestają dostawać ilość i zostają tak, jak ostatnio ustawił je OMS.

Zanim wyłączysz, ekran pokazuje skutek, np. „3 ofert wróci do stałej ilości, 12 przejętych przestanie być
synchronizowanych”, i wymaga zaznaczenia „Rozumiem”. Bez zaznaczenia formularz się nie wyśle. Po ponownym włączeniu
zatwierdzasz stan otwarcia od nowa (możesz kontynuować od stanu z wyłączenia).

### Co z kanałami

| kanał | co robi OMS z ilością | dokument |
|---|---|---|
| ERLI | zapisuje ilość produktu hurtem; zamrożony przez ERLI stan to problem | [kanal-erli.md](kanal-erli.md) |
| Allegro | zmienia ilość poleceniem zbiorczym; przy 0 kończy ofertę, po uzupełnieniu wznawia | [kanal-allegro-oferty.md](kanal-allegro-oferty.md) |
| WooCommerce | zapisuje `stock_quantity` tam, gdzie sklep prowadzi stan | [kanal-woo.md](kanal-woo.md) |

### Czego jeszcze nie sprawdzono

Stany działają na atrapach kanałów. Na prawdziwym Allegro nie zmierzono udanej zmiany ilości ani cyklu
„zakończ przy 0 i wznów”, a na prawdziwym ERLI i Woo nie próbowano zapisu. Zaczynaj od jednego konta i kilku
ofert (podgląd, bufor 1) i obserwuj „Problemy ofert”, zanim obejmiesz cały katalog.
