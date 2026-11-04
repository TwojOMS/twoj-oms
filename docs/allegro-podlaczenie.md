# Allegro — podłączenie konta w panelu

Konto Allegro podłączasz w panelu OMS. Nie potrzebujesz do tego SSH, edycji pliku konfiguracji ani restartu.
Plik konfiguracji (`oms.env`) to druga droga, dla instalacji, które wolą trzymać ustawienia w pliku (rozdział
„Konfiguracja w pliku”). Gdy to samo jest w obu miejscach, **plik wygrywa**.

Przykłady niżej dotyczą zmyślonej firmy „Pracownia Półcień” i jej kont (`allegro_polcien`).

## Zanim zaczniesz

- Musisz być zalogowany w OMS jako administrator.
- Potrzebujesz konta firmowego na allegro.pl. Na koncie produkcyjnym Allegro wymaga włączonego logowania
  dwustopniowego.
- Do prób możesz użyć środowiska testowego Allegro Sandbox (osobne konto, osobna aplikacja). Środowisko wybierasz
  w kreatorze; produkcja i Sandbox nie mieszają się.

## Ścieżka w panelu

Ustawienia → Integracje → Allegro → „Dodaj konto”. Kreator ma kroki od 0 do 5.

### Krok 0. Aplikacja Allegro (raz na instalację i środowisko)

OMS łączy się z Allegro przez aplikację Twojej firmy. Zakładasz ją raz; potem podłączysz nią jedno albo kilka kont
Allegro. Panel pokazuje te same kroki, które są tutaj:

1. Zaloguj się na allegro.pl kontem firmy i otwórz `apps.developer.allegro.pl`. Dla Sandboxa jest to
   `apps.developer.allegro.pl.allegrosandbox.pl`.
2. Dodaj nową aplikację.
3. Nazwa — Allegro pokaże ją przy wyrażaniu zgody, np. „OMS Pracownia Półcień”. Opis jest nieobowiązkowy.
4. Typ aplikacji — zaznacz: „Aplikacja będzie działać w środowisku bez dostępu do przeglądarki albo klawiatury”.
   Typu nie da się później zmienić. Adresu przekierowania nie podajesz.
5. Zaakceptuj regulamin REST API i zatwierdź formularz.
6. Uprawnienia — w „Zarządzanie aplikacjami” otwórz aplikację i zaznacz wszystkie z listy pokazanej w panelu
   (zamówienia, oferty, przesyłki, wiadomości, dyskusje i reklamacje oraz profil konta — login i numer konta).
7. Skopiuj Client ID i Client Secret z karty aplikacji i wklej w panelu, w kroku 0. Przycisk „Zapisz i sprawdź”.

OMS sprawdza obie wartości w Allegro. Po zapisaniu sekret nie wraca już na ekran — panel pokazuje tylko końcówkę
Client ID. Zmienić aplikację można, dopóki nie ma kont połączonych tą aplikacją (najpierw je odłącz).

### Krok 1. Nazwa i zakres zamówień

Nazwa konta w OMS (np. „Allegro Pracownia Półcień”), środowisko i dzień, od którego OMS ma pobierać zamówienia.
Zamówień sprzed tego dnia OMS nie pobierze. Pobieranie obejmuje najwyżej ostatnie 12 miesięcy i 10 000 zamówień.

### Krok 2. Zgoda w Allegro

Panel pokazuje kod do przepisania i odnośnik do strony zgody Allegro. **Allegro podłączy konto, na które ta
przeglądarka jest teraz zalogowana na allegro.pl.** Jeśli to inne konto niż zamierzone — wyloguj się z Allegro albo
otwórz odnośnik w oknie prywatnym. Po zgodzie wróć do panelu i kliknij „Sprawdź, czy zgoda dotarła”.

### Krok 3. Potwierdź konto

Panel pokazuje login i ID konta, które przyszły z Allegro: „Jesteś zalogowany w przeglądarce jako … — to konto zostanie
podłączone”. Sprawdź, czy to właściwe konto. „To moje konto — dalej” zatwierdza; „To nie to konto — zacznij od nowa”
odrzuca próbę. Dopóki nie zatwierdzisz, OMS nie zapisuje aktywnych tokenów i nie importuje zamówień.

### Krok 4. Data startu i aktywacja

Datę startu możesz jeszcze zmienić, o ile nie aktywowałeś pobierania. Po aktywacji zmiana jest odrzucana — zamówień
sprzed tej daty OMS nie pobrał, więc zmiana daty wstecz nie ma jak zadziałać. Ekran pokazuje limit 10 000 zamówień.

### Krok 5. Stan pobierania

Ostatni przebieg, ostatni sukces i ostatni błąd pobierania. Na stronie konta masz też:

- „Wstrzymaj pobieranie” / „Wznów pobieranie” — pauza zatrzymuje pobieranie nowych zamówień; zamówienia już zapisane
  w OMS obsługujesz dalej. Wznowienie uzupełnia przerwę.
- „Sprawdź połączenie” — test odczytu konta i zamówień; niczego nie importuje i nie sprawdza nadania przesyłki.
- „Zmień nazwę” — klucz kanału i powiązania zamówień się nie zmieniają.
- „Odłącz” — dostęp do Allegro ustaje, tokeny znikają, historia zamówień zostaje.

### Drugie i kolejne konto

Aplikacja z kroku 0 obsługuje wszystkie konta tej firmy w danym środowisku. Kolejne konto: „Dodaj konto” i od razu
krok 1. Pomyłka sprzed lat, gdy kanał związano z cudzym kontem, jest powodem kroku 3 — zawsze sprawdź login.

## Konfiguracja w pliku (druga droga)

Konto i aplikację można zdefiniować w `oms.env`. Wtedy panel pokazuje je tylko do odczytu, z tekstem „Ustawione
w pliku konfiguracji (oms.env) — tam je zmień.” Opis linii: `docs/instalacja-docker.md`, rozdział „Integracje po
kolei”, i tabela zmiennych `docs/zmienne.md`. Dla aplikacji z kroku 0 służą zmienne
`OMS_ALLEGRO_DEVICE_CLIENT_ID` i `OMS_ALLEGRO_DEVICE_CLIENT_SECRET` (Sandbox: `OMS_ALLEGRO_SANDBOX_DEVICE_…`);
nagłówek `User-Agent` ustawia `OMS_ALLEGRO_USER_AGENT`.

## Rejestracja bez udziału klienta (DCR)

W kodzie jest też rejestracja aplikacji bez udziału klienta (DCR) jako ścieżka na przyszłość — dziś nieużywana;
pierwszą drogą jest aplikacja założona w kroku 0.

## Dane, kopie i powrót

Baza OMS zawiera poświadczenia (tokeny i sekret aplikacji) i wymaga tej samej ochrony co kopia zapasowa całego OMS.
Nie deklarujemy szyfrowania bazy. OMS nie wysyła tokenów przez żaden centralny serwer — łączy się bezpośrednio z Allegro.
Przed powrotem do starszej wersji OMS zatrzymaj pobieranie, zachowaj spójną kopię bazy i nie odtwarzaj starych tokenów:
mogły zostać zrotowane.

## Źródła

- [Dokumentacja Allegro — uwierzytelnianie i autoryzacja](https://developer.allegro.pl/tutorials/uwierzytelnianie-i-autoryzacja-zlq9e75GdIR).
- Instalacja i integracje po kolei: `docs/instalacja-docker.md`.
