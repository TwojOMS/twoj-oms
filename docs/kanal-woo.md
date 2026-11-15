# WooCommerce — stany magazynowe

Instrukcja dla właściciela sklepu korzystającego z Twój OMS. Stan: 14.11.2026 (PRZ-160, etap 4).
Przykłady są zmyślone: „Pracownia Półcień”, sklep `sklep.polcien.example`.

Ten dokument opisuje tylko **stany**. Odczyt produktów, treści i zdjęć ze sklepu Woo opisuje
dokument o magazynie („Odczyt ze sklepu WooCommerce”). Ogólne zasady stanów w kanałach — rozdział
„Stany w kanałach” w tym samym dokumencie.

## Co robi OMS

Gdy w OMS-ie włączysz stany magazynowe i zatwierdzisz stan otwarcia, OMS może zapisywać w sklepie ilość
(`stock_quantity`) produktów i wariantów, które objąłeś stanami: stan karty minus bufor konta, nie mniej niż 0.
Zmienia tylko ilość. Cena, opis i zdjęcia produktu w sklepie pozostają bez zmian. Sklep Woo ma w OMS-ie
status „przejętej” oferty: OMS ją tylko obserwuje i, na Twoje polecenie, aktualizuje samą ilość.

## Warunek: sklep musi prowadzić stany

OMS zapisuje ilość **tylko tam, gdzie sklep sam liczy stan**, czyli gdy produkt ma włączone „Zarządzanie stanem”
(w API: `manage_stock = true`). Co z pozostałymi:

- **`manage_stock = false`** — sklep nie prowadzi stanu tego produktu. OMS go nie obejmie. Podgląd przejęcia
  napisze „sklep nie prowadzi własnych stanów dla N produktów”. Jeśli produkt zmieni się tak już po objęciu, OMS
  wstrzyma ofertę z problemem „Sklep nie prowadzi stanu produktu”.
- **Wariant z `parent`** (stan bierze z produktu nadrzędnego) — OMS go nie obejmie, bo zapis na wariancie
  nie zmieniłby tego, co liczy sklep. Problem: „Wariant korzysta ze stanu rodzica”. Ten przypadek sprawdzono tylko na
  atrapie sklepu, bo żaden prawdziwy sklep go nie dostarczył. Dokumentacja Woo opisuje go zdawkowo.
- OMS **nigdy sam nie włącza `manage_stock`** w Twoim sklepie. Jeśli chcesz, żeby produkt dostawał stan z OMS,
  włącz zarządzanie stanem w Woo i objaw go ponownie.

**Sklep bez stanów nie jest źródłem stanu otwarcia.** Jeśli w Woo żaden produkt nie prowadzi stanu, otwarcie
liczy się z Allegro i ERLI albo z importu tekstem. Kolumna Woo zostaje pusta, a OMS pokaże, że sklep „nie jest
źródłem”. Sklep, który stany prowadzi, pokazuje wartość obok propozycji ze znacznikiem „różnica”, gdy się różni.
W otwarciu liczy się tylko to, co sklep faktycznie zdjął: statusy, w których WooCommerce odejmuje sztuki
(m.in. „przetwarzane”, „wstrzymane”, „zrealizowane”). Zamówienie „oczekujące na płatność” nie zdjęło sztuki.

Jeśli produkt ma włączone `backorders` (przyjmowanie zamówień ponad stan), sklep może pokazać ilość poniżej
zera. OMS traktuje taki odczyt jako normalny i ostrzega o tym w podglądzie objęcia.

## Klucz API: wymagane uprawnienie „Zapis”

W WooCommerce → Ustawienia → Zaawansowane → REST API klucz musi mieć uprawnienia **„Odczyt/zapis”**
(w interfejsie sklepu „Read/Write”). Klucz tylko do odczytu pozwala OMS-owi czytać produkty i stany, ale **zapisu
stanów nie wykona**: konto zostaje w trybie tylko do odczytu, a OMS nic nie wyśle. Dla stanów konto Woo ma osobny
przełącznik „Stany do sklepu: wstrzymane / czynne” (domyślnie wstrzymane) — dopóki go nie ustawisz, nic
nie jest zapisywane do sklepu.

## Jak często OMS czyta i pisze

- **Przed każdym zapisem** OMS czyta na świeżo stan tych samych produktów i dopiero na tej podstawie decyduje.
  Powód: API zapisuje wartość bezwzględną („ustaw 7”), a nie „odejmij 1”. Zapis na starym odczycie cofnąłby
  sztukę, którą sklep właśnie sprzedał.
- Pętla stanów Woo działa okresowo (zwykle co kilka minut) i dodatkowo **czyta wszystkie objęte pozycje co
  15 minut**, żeby zauważyć zmianę stanu zrobioną w sklepie ręcznie. Zwykle nie zmienia to celu.
- Nowe zamówienie, ruch magazynowy albo zmiana powiązań przyspieszają przebieg (nie częściej niż co 60 sekund).
- Zapis idzie hurtem, **do 100 pozycji w jednym żądaniu** (produkty i warianty osobno), najpierw obniżki, potem
  podwyżki, z krótką przerwą między żądaniami. Limity API zależą od hostingu sklepu — po 429 lub błędzie
  serwera OMS ponawia z rosnącą przerwą.
- Gdy sklep sam zdejmuje sztuki przy zamówieniu, OMS to widzi w odczycie i nie nadpisuje. Zmiana stanu
  tłumaczona zamówieniami nie jest alarmem. Zmiana nietłumaczona (np. ktoś poprawił ilość w panelu Woo) zatrzyma
  ofertę z alarmem „rozjazd” do Twojej decyzji.

## Czego nie sprawdzono

Sklepu testowego Woo nie ma: zapis stanów sprawdzono na atrapie. Prawdziwy sklep sprzedawcy, na którym
zmierzono odczyt, nie prowadził stanów w Woo, więc zapisu tam nie próbowano. Pierwszy zapis zrób na jednym
produkcie testowym i sprawdź w panelu Woo.
