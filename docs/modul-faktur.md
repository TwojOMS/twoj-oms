# Program do faktur

Wybór programu jest w **Ustawienia → Faktury i podatki → Program do faktur**.
Dotyczy całej instalacji. Zmienia go administrator.

## Dostępne programy

| opcja | działanie |
|---|---|
| Brak | OMS nie wystawia faktur. Proformy i pobieranie kosztów z KSeF działają niezależnie. |
| inFakt | OMS wystawia faktury przez podłączone konto inFaktu. |
| Fakturownia — wkrótce | Zapowiedź, opcji nie można wybrać. |
| TwojeFaktury — wkrótce | Zapowiedź. To wydanie nie zawiera kodu tego modułu i nie można go włączyć ustawieniem. |

Bez jawnego wyboru OMS korzysta z inFaktu, jeśli jest podłączony; w przeciwnym razie nie wystawia faktur.

## Zmiana programu

1. Otwórz **Ustawienia → Faktury i podatki → Program do faktur**.
2. Wybierz **Brak** albo **inFakt** i zapisz.
3. Uruchom ponownie OMS. Użyj przycisku na ekranie, jeśli instalacja go udostępnia,
   albo na serwerze w katalogu instalacji wykonaj <code>docker compose restart oms</code>.

Do restartu działa poprzedni program. Automat wysyłki do KSeF zatrzymuje się od razu po zapisaniu „Brak”.
Ekran pokazuje program działający teraz i wybór oczekujący na restart.
Podłączanie inFaktu jest w katalogu Integracji; zasady fakturowania i VAT mają osobne zakładki w „Faktury i podatki”.

## Faktury po wybraniu „Brak”

Wcześniejsze faktury pozostają w programie, w którym je wystawiono. OMS nie pobiera wtedy ich PDF,
nie wystawia korekt i nie wysyła dokumentów do KSeF, Allegro ani mailem.
Zmiana programu nie przenosi dokumentów między programami.

## Konfiguracja w pliku

<code>OMS_PROGRAM_FAKTUROWY=brak</code> albo <code>OMS_PROGRAM_FAKTUROWY=infakt</code> ma pierwszeństwo przed wyborem w panelu.
Pozostałe programy są niedostępne. Nie ustawiaj zmiennych włączających nieobecne moduły.

Przy wycofaniu do wersji bez wyboru programu zapis „Brak” może być pomijany — jeśli klucz inFaktu pozostaje
skonfigurowany, wcześniejsza wersja znów z niego skorzysta.
