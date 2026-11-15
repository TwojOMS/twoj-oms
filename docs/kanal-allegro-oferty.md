# Allegro — wystawianie ofert z OMS-u

Instrukcja dla właściciela sklepu korzystającego z Twój OMS. Stan: 14.11.2026, etap 3.
Przykłady są fikcyjne: „Pracownia Półcień”, konto „Allegro Pracownia Półcień”, katalog lamp
(„Lampa stołowa Opal”, marka „Półcień”).

Dokument opisuje wystawianie ofert według planu etapu 3. Zmiany „Aktywuj w Allegro”, ekran „Wystaw na…”
z prowizją i zegar pętli ofert były w chwili pisania jeszcze w toku — opisano je według planu. Co jest
niepotwierdzone na prawdziwym Allegro, zebrano na końcu.

## Co to daje

OMS tworzy oferty Allegro z kart produktów: nazwę, opis, zdjęcia, kategorię, parametry, cenę, ilość i dane
o producencie (GPSR) bierze z karty i z ustawień konta. Potem pilnuje ceny i ilości oraz treści, gdy je zmienisz na
karcie. To osobna pętla od ERLI — tych samych kart używają obie, ale konta i ustawienia są osobne.

Aby zmieniać cokolwiek na kontach Allegro, OMS musi mieć zgodę na oferty. Bez niej konto dalej pobiera zamówienia
i nadaje przesyłki jak dotąd.

## Przygotowanie

1. **Zgoda na oferty.** Ustawienia → Integracje → Moje połączenia, przy koncie Allegro: „Sprawdź uprawnienia aplikacji”, potem „Chcę
   wystawiać oferty” i nowa zgoda w Allegro. Szczegóły i trzy ścieżki (plik konfiguracji, panel, DCR) są w
   „Allegro — podłączenie konta w panelu”, rozdział „Wystawianie ofert”. Pierwszy dowód na sandboxie, potem
   konta produkcyjne ze ścieżką pliku konfiguracji.
2. **Ustawienia konta, krok 6 „Oferty”.** Najpierw „Pobierz z Allegro” (cenniki dostaw, warunki zwrotów
   i reklamacji, gwarancje, producenci, osoby odpowiedzialne — tylko odczyt), potem „Zapisz ustawienia ofert”.
3. **Mapa kategorii.** Magazyn → Kategorie → wybierz kategorię (np. „Lampy stołowe”) → Allegro.
4. **Mapa marek.** Magazyn → Marki → marka → Allegro.
5. **Karta.** Sekcja „Allegro” na karcie mówi, czego brakuje („Przed wystawieniem uzupełnij”) albo pokazuje
   „Gotowa do wystawienia”.

## Ustawienia konta (krok 6 „Oferty”)

| pole | znaczenie |
|---|---|
| Oferty: wstrzymane / czynne | przy wstrzymanych OMS nic nie wysyła do Allegro |
| Narzut % | doliczany do ceny z karty; cena jest liczona i zapisywana jako „zł.gr” |
| Próg potwierdzenia zmiany ceny % | większa zmiana ceny czeka na Twoje potwierdzenie |
| Stała liczba sztuk | ilość w ofercie (OMS nie synchronizuje jeszcze ze stanem magazynu) |
| Czas wysyłki (dni) | czas na przygotowanie przesyłki |
| Stawka VAT domyślna | używana, gdy karta nie ma własnej |
| Cennik dostaw według rozmiaru | tabela reguł, patrz niżej |
| Zwroty, reklamacje, gwarancja, osoba odpowiedzialna | wybór z list pobranych z Allegro |
| Aktywuj po sprawdzeniu | „Nie” (domyślnie): oferta zostaje nieaktywna, aż ją aktywujesz; „Tak”: aktywna po sprawdzeniu przez Allegro |
| Informacja o bezpieczeństwie produktu (domyślna) | tekst do 5000 znaków; bez niego oferty tego konta nie przejdą |
| Producent marki | wybór dla każdej marki: producent z listy konta, „Producent konta (marka własna)” albo „Nieprzypisana” |

Marka „Nieprzypisana” blokuje wystawienie kart tej marki. Karta bez marki dostaje producenta konta.
Dla lamp i oświetlenia informacja „brak informacji o bezpieczeństwie” jest niedozwolona.

### Cennik dostaw według rozmiaru

Duży produkt nie wejdzie do paczkomatu, więc konto może mieć kilka cenników dostaw. W kroku 6, w sekcji
„Cennik dostaw według rozmiaru”, wpisujesz reguły od góry. Każda ma trzy wymiary w cm („Do wymiarów (cm)”),
„Do wagi (kg)” i „Cennik” wybrany z listy pobranej z Allegro („Pobierz z Allegro”). Przecinek jest dozwolony.
Przykład dla „Pracowni Półcień”:

| # | do wymiarów (cm) | do wagi (kg) | cennik |
|---|---|---|---|
| 1 | 8 × 38 × 64 | 25 | Pracownia Półcień — paczkomat A |
| 2 | 41 × 38 × 64 | 25 | Pracownia Półcień — paczkomat C |
| — | dla większych | | Pracownia Półcień — kurier gabaryt |

OMS sprawdza wiersze od góry i bierze pierwszy, w którym produkt się mieści (wymiary w dowolnym ułożeniu; wartość
równa granicy też się mieści). Dlatego wpisuj od najmniejszej reguły do największej: lampa 30 × 30 × 6 cm
zmieści się już w regule 1 i wiersz 2 jej nie obejmie. Produkt większy od wszystkich reguł dostaje cennik
z wiersza „dla większych”. To pole jest wymagane, gdy są reguły rozmiaru. Pusty wiersz jest pomijany; kolejne
puste wiersze pojawią się po zapisie. Konto z samym wierszem „dla większych” ma jeden cennik dla wszystkich ofert
(tak działa każde konto po aktualizacji: dawny cennik staje się właśnie taką regułą). Pod tabelą jest podpowiedź
z gabarytami paczkomatu InPost (A 8×38×64, B 19×38×64, C 41×38×64 cm, do 25 kg); OMS ich nie pilnuje, limity
wpisujesz sam, tak jak ma je Twój cennik.

Wiersz z brakującym wymiarem albo wagą lub bez cennika jest odrzucany z komunikatem przy tym wierszu
(„Podaj trzy wymiary w cm i wagę w kg (liczby większe od zera).”, „Podaj cennik dla tego wiersza.”), a brak
cennika „dla większych” — „Podaj cennik dla większych — obowiązkowy, gdy są reguły rozmiaru.” Przy błędzie nic
się nie zapisuje.

## Mapa kategorii i marek

Karta ma kategorię OMS; Allegro wymaga kategorii najniższego poziomu (liścia). Kolejność, w jakiej OMS ją ustala:
nadpisanie na karcie, kategoria z importu z Allegro, mapa kategorii OMS → Allegro, w końcu błąd. Mapa jest osobna
dla środowiska („Produkcja” i „Sandbox”). „Zatwierdź kategorię” pobiera opis kategorii i sprawdza słownik marek
każdej przypisanej marki.

Dla każdego parametru wymaganego w kategorii ustawiasz regułę: stała wartość, pole karty (z przelicznikiem)
albo „wpisywana na karcie”. Parametr „Stan” ma domyślnie stałą „Nowy”. Ekran pokazuje, ile kart ma komplet
parametrów i czego brakuje. Słownik marek Allegro zależy od kategorii; jeśli w jakiejś kategorii marki nie ma,
OMS to pokaże („oferty kart tej marki w nich nie przejdą”).

## Oferta z karty

Na liście Magazynu zaznacz karty i wybierz „Wystaw na…” oraz konto Allegro. Ten sam formularz co przy ERLI: podgląd,
potem „Zatwierdź”. Podgląd pokazuje nazwę, cenę z narzutem, ilość, kategorię, zdjęcia i błędy blokujące
(„Odmowa: …”) oraz uwagi. Prowizja z kalkulatora Allegro jest tylko informacją — nie blokuje zatwierdzenia;
liczona jest dla najwyżej 20 kart naraz (przy większym wyborze: „prowizji nie policzono — zawęź wybór”, przy
awarii: „prowizja niedostępna”).

Odmowy i uwagi:

- karta ma już ofertę na tym koncie (z OMS-u albo odczytaną z Allegro) — odmowa;
- co najmniej dwie aktywne lub oczekujące oferty tej samej karty na kontach Allegro tego środowiska — ostrzeżenie
  (Allegro ma zasadę o dwóch ofertach „Nowy” w podkategorii);
- nazwa dłuższa niż 75 znaków (znak „&” liczy się jak 5) — popraw w sekcji „Allegro” na karcie, pole „Nazwa dla Allegro”;
- brak kategorii, parametru wymaganego, marki z producentem, informacji o bezpieczeństwie, EAN-u przy kategorii,
  która go wymaga, albo zdjęć.

Cennik dostaw dobiera OMS z reguł konta według wymiarów i wagi karty. Podgląd pokazuje przy karcie linię
„Cennik: <nazwa> — <powód>”, na przykład „reguła 2: do 41×38×64 cm, 25 kg”, „dla większych” albo
„jeden cennik konta”.

Wyjątek dla jednej karty ustawiasz na karcie w Magazynie, w sekcji „Cennik dostaw”: dla każdego konta jest pole
„Cennik dostaw — wyjątek” (puste = reguły konta) i przycisk „Zapisz cennik dostaw”. Wyjątek wygrywa z regułami
tego konta, np. dla produktu zwiniętego w rulon. Przy polu widać „Teraz: <cennik> — <powód>”. Gdy wybrany wyjątek
różni się od tego, co dałyby reguły, podgląd dopisuje „(reguły dałyby: …)”. Wyjątek, którego cennika nie ma już
na pobranej liście konta, jest oznaczony „(spoza listy konta)”.

Trzy odmowy dotyczą cennika:

- „Brak wymiarów/wagi — OMS nie wie, czy produkt zmieści się w paczkomacie. Uzupełnij wymiary albo ustaw cennik
  na karcie.” — przy regułach rozmiaru karta musi mieć trzy wymiary i wagę. Uzupełnij je albo ustaw wyjątek;
  „Zatwierdź” pomija taką kartę.
- „Cennik z karty nie istnieje już na koncie Allegro — wybierz inny” — wyjątek wskazuje cennik, którego nie ma na
  liście konta. Wybierz na karcie inny cennik albo wyczyść pole wyjątku (wtedy działają reguły konta). Jeśli lista
  jest przestarzała, pobierz ją ponownie w kroku 6 („Pobierz z Allegro”).
- Gdy konto nie ma żadnej reguły, odmowa brzmi „Konto nie ma ustawionego cennika dostaw.” — wpisz w kroku 6
  przynajmniej cennik „dla większych”.

Jeśli kategoria ma produkt w Katalogu Allegro, OMS szuka go po EAN. Gdy jest kilka trafień, na karcie pojawia się
„Produkt z katalogu Allegro” z wyborem i przyciskiem „Użyj tego produktu”. Gdy parametry różnią się od produktu
katalogowego, dostaniesz komunikat o niezgodności parametru i ten sam wybór.

## Dwa etapy: szkic i aktywacja

OMS najpierw zapisuje szkic w Allegro (oferta nieaktywna), dopiero potem aktywuje. Przy ustawieniu „Aktywuj po
sprawdzeniu: Nie” oferta zostaje „nieaktywna”, a na karcie jest przycisk „Aktywuj w Allegro”. **Pierwsze
aktywowanie na koncie produkcyjnym kliknij sam** — to Twoja decyzja, nie automatu. „Zdejmij” kończy ofertę
(w Allegro zostaje jako zakończona); OMS jej nie usuwa. Szkic i zdjęta oferta to nie to samo: aktywować można tylko szkic.

Każda oferta ma w Allegro znacznik zewnętrzny złożony ze znaku instalacji i numeru karty. Po awarii albo restarcie
OMS po nim odnajduje ofertę i nie tworzy jej drugi raz. Żeby nie zdublować oferty, odczekuje co najmniej 15 minut
i dwa razy sprawdza, zanim wyśle ponownie. Przy dwóch trafieniach oznacza problem „duplikat” i prosi o decyzję.

## Cena i ilość

Zmiana ceny albo ilości karty trafia do Allegro jako polecenie zbiorcze o stałym numerze, więc ponowienie tego samego
polecenia jest bezpieczne. Cena z narzutem poniżej progu potwierdzenia idzie sama; powyżej — czeka na Ciebie.
Ilość jest stała (ustawienie konta), chyba że włączysz stany magazynowe. Oferta wyprzedana (0 sztuk) jest kończona przez Allegro; OMS sam ją wznawia
(patrz „Wznowienie bez sprawdzania opłat”).

### Ilość z OMS przy włączonych stanach

Gdy włączysz stany magazynowe i zatwierdzisz stan otwarcia (patrz rozdział „Stany w kanałach” w dokumencie o magazynie), ilość oferty to
stan karty pomniejszony o bufor konta, a nie stała liczba z ustawień. Stała liczba wraca, gdy stany wyłączysz.
Oferty wystawione z OMS-u dostają ilość zawsze. Oferty przejęte (wystawione poza OMS-em) dostają **wyłącznie ilość**
i tylko po „Obejmij stany”; ich treść i cena zostają w Allegro.

- **Zmiana ilości:** polecenie zbiorcze na jedną wartość docelową. Oferty z tą samą nową ilością idą razem
  (do 1000 w poleceniu), obniżki przed podwyżkami. Allegro odpowiada po chwili, więc OMS sprawdza wynik
  przy następnym przebiegu.
- **Przy 0:** OMS **kończy ofertę** poleceniem zbiorczym „zakończ” (do 1000 ofert), a nie zostawia aktywnej oferty
  z zerem. Dotyczy wszystkich ofert z ilością z OMS, także przejętych.
- **Wznowienie:** gdy karta znów ma stan > 0, OMS sam ustawia ilość i **aktywuje** ofertę pod tym samym numerem.
  Dla przejętej oferty to dwa polecenia po kolei (najpierw ilość, potem aktywacja), bo Allegro nie pozwala
  aktywować zakończonej oferty z zerem.
- **Bez sprawdzania opłat dla żadnej oferty** (decyzja właściciela, 14.11.2026): OMS nie pyta Allegro o koszt wystawienia
  ani przed wznowieniem, ani przed zakończeniem. Wznowienie zakończonej oferty **może być w Allegro płatne**, zależnie
  od Twojego cennika, liczby wystawień w miesiącu i kategorii. Przy kartach, które często schodzą do zera
  i wracają, sprawdź cennik. Zwiększ bufor, żeby oferty nie kończyły się przy ostatniej sztuce.
- **Oferta zakończona ręcznie**, gdy karta ma stan > 0, nie jest wznawiana sama. Zobaczysz problem i przycisk „Wznów”
  w Magazyn → „Problemy ofert”.
- **Fulfillment** (Allegro Magazyn): Allegro nie pozwala zmienić ilości takiej oferty. OMS pokaże problem „Kanał nie
  pozwala zmienić ilości” i nie będzie próbował ponownie. Ofert fulfillment nie obejmuj stanami.
- **Konto z wstrzymanymi ofertami** lub w trybie tylko do odczytu niczego nie wysyła, także zakończeń.

Czego nie sprawdzono na prawdziwym Allegro: udanej zmiany ilości poleceniem zbiorczym, zakończenia przy 0
i wznowienia pod tym samym numerem (cykl sprawdzono na atrapie). Zacznij od kilku ofert i bufora 1.

### Wznowienie bez sprawdzania opłat

Od 14.11.2026 (decyzja właściciela) OMS nie pyta Allegro o koszt wystawienia przed wznowieniem.

- **Wyprzedana (zakończona przy 0 sztukach):** w następnym przebiegu OMS wysyła jedno polecenie „ilość z ustawień
  konta + aktywna” i sprawdza, czy oferta wróciła. Nie trzeba nic klikać.
- **Zakończona w Allegro ręcznie (zostały sztuki):** OMS jej sam nie wznawia. W Magazyn → „Problemy ofert” wciśnij
  „Wznów” — w najbliższym przebiegu pójdzie to samo jedno polecenie.
- **Kiedy OMS nie wznowi:** konto w trybie tylko do odczytu albo „Oferty: wstrzymane” (polecenie czeka), karta wycofana
  (oferta zostaje nieaktywna), karta bez stałej liczby sztuk albo z błędem (powód w problemie — popraw kartę i wciśnij
  „Wznów” jeszcze raz), Allegro odrzuciło wznowienie (powód w problemie).
- **Błędy Allegro po stronie serwera:** OMS ponawia z rosnącą przerwą; po 5 nieudanych próbach przestaje i pokazuje
  problem „Wznowienie nie powiodło się 5 razy … — wznów ręcznie”.
- Koszt wystawienia sprawdzasz sam w Allegro (cennik konta) — OMS go nie liczy.

## Zdjęcia i oznaczenie AI

OMS wysyła zdjęcia z karty zawsze jako plik (nie przekazuje adresów). Allegro przyjmuje najwyżej 16 zdjęć; przy
większej liczbie OMS ostrzega („Allegro przyjmie 16 z N zdjęć”). Plik do ok. 25 MiB. Oznaczenie „zdjęcie stworzone
z pomocą AI” OMS wysyła tylko dla zdjęć oznaczonych na karcie jako AI. **Karta ze zdjęciem bez ustawionej
informacji o AI jest zablokowana.** Po pierwszym wgraniu znacznika AI w Allegro nie da się go zmienić — jeśli się
pomylisz, zdjęcie trzeba wgrać od nowa (nowa oferta albo nowe zdjęcie). Zdjęcie ręczne oznaczone jako AI i pobrane
z Allegro nie przejdzie.

## Stany i problemy

| stan | znaczenie | co robisz |
|---|---|---|
| nieaktywna (szkic) | oferta jest w Allegro, nikt jej nie widzi | „Aktywuj w Allegro” |
| oczekuje | Allegro sprawdza ofertę | poczekaj, odświeży się samo |
| aktywna | oferta jest na Allegro | nic |
| zakończona (problem) | oferta w Allegro skończyła się (np. zdjęta tam ręcznie albo wznowienie się nie udało) | „Wznów” w Magazyn → „Problemy ofert” albo wystaw na nowo; wyprzedaną OMS wznawia sam |
| problem „duplikat” | pod znacznikiem karty są co najmniej 2 oferty | zakończ zbędną w Allegro |
| problem „wybór produktu” | kilka produktów w Katalogu albo niezgodny parametr | wybierz produkt na karcie |
| brak w Allegro | oferta z rejestru OMS zniknęła z Allegro | sprawdź, czy ktoś ją usunął |
| ręczna operacja | Allegro nie potwierdziło operacji; OMS nie ponawia na ślepo | sprawdź ofertę w Allegro, potem zwolnij operację |

### Zmiana cennika w żywych ofertach

Zmiana reguł konta, wyjątku na karcie albo wymiarów i wagi karty zmienia cennik także w ofertach już wystawionych.
Pętla wysyła wtedy do Allegro samą dostawę (PATCH `delivery`: czas wysyłki i cennik), bez reszty treści, jeśli
nic innego się nie zmieniło. Zmiana nazwy czy opisu razem z cennikiem idzie jednym pełnym zapisem. Zmiana czasu
wysyłki w ustawieniach konta też trafia teraz do żywych ofert. Zapisów jest najwyżej 50 na konto w jednym
przebiegu, z czego 10 zostaje w rezerwie na zmiany ilości i ceny, więc PATCH-y dostaw idą po 40 na przebieg;
przy setkach ofert zmiana rozłoży się na kilka przebiegów, a reszta czeka bez zmiany stanu. Oferta, której karta
nie ma już wymiarów albo wagi (odmowa jak wyżej), dostaje problem „karta” i zostaje ze starym cennikiem.

## Rozwiązywanie problemów

- **„To konto nie ma zgody na zapis ofert — połącz je ponownie”** — krok 6 pokazuje, że zgody nie ma; patrz „Allegro — podłączenie konta w panelu”.
- **„Cennik z karty nie istnieje już na koncie Allegro — wybierz inny”** — na karcie, w sekcji „Cennik dostaw”,
  wybierz inny cennik z listy albo wyczyść pole wyjątku.
- **„Brak wymiarów/wagi — OMS nie wie, czy produkt zmieści się w paczkomacie…”** — uzupełnij wymiary i wagę
  karty albo ustaw na niej wyjątek cennika.
- **Cennik oferty się nie zmienił** — oferty zmieniają się po 40 na przebieg; sprawdź też, czy na liście ofert nie
  ma problemu „karta”.
- **Producent marki nieprzypisany** — Ustawienia konta, krok 6, tabela „Producent marki”.
- **Brak informacji o bezpieczeństwie** — wpisz domyślny tekst w ustawieniach konta albo na karcie.
- **Kategoria bez mapy** — Magazyn → Kategorie → Allegro; kategoria musi być liściem.
- **Błąd 422 przy zapisie** — Allegro odrzuciło dane (np. brak parametru wymaganego); komunikat podaje numery
  parametrów. Uzupełnij na karcie lub w regułach kategorii.
- **Operacja skończyła się błędem po zakończeniu oferty** — nie da się zmieniać oferty nieaktywnej; aktywuj ją najpierw.
- **Allegro prosi o odczekanie** — OMS czeka tyle, ile podało Allegro (ok. dwóch minut), i próbuje ponownie.

## Czego nie potwierdzono na prawdziwym Allegro

Wszystko sprawdzono na atrapie i na sandboxie Allegro; na kontach produkcyjnych jeszcze nie.

- Limit wielkości strony odczytu ofert: na sandboxie 1000; OMS przyjmuje zachowawczo 20 na stronę, bo na produkcji
  go nie zmierzono.
- Cykl aktywna → zakończona → aktywna (wznawianie) nie jest zmierzony na sandboxie; OMS czyta odpowiedź wznowienia
  jak aktywację i po 5 nieudanych próbach zostawia problem do ręcznej decyzji.
- Kalkulator kosztów („wystawienie kosztuje 0 zł”) nie działa na sandboxie (błąd 403), więc koszt wystawienia nie
  jest tam sprawdzony.
- Ustawienia podatkowe konta oraz czas, po jakim zmienia się stan produktu w Katalogu, nie są zmierzone.
- Zakres uprawnień w ścieżce zgody przez kod (urządzenie) mógł zostać przycięty — sprawdź wynik w „Sprawdź uprawnienia
  aplikacji”.
- Pierwsze oferty na produkcji powinny być aktywowane ręcznie i obejrzane w Allegro.
