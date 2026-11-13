# Fakturownia — jak podłączyć

Po podłączeniu Fakturowni wystawiasz faktury z zamówień w OMS-ie. Dokumenty i ich numery powstają
w Fakturowni, a OMS pozwala pobrać PDF, oznaczyć zapłatę i obsługiwać wysyłkę do KSeF.

## Zanim zaczniesz

- Potrzebujesz konta Fakturowni z dostępem do API. Podłączenie w OMS-ie nie zakłada konta.
- Przygotuj użytkownika technicznego do połączenia z OMS-em i jego token API. Token daje dostęp
  do danych konta — nie przesyłaj go w wiadomościach ani nie umieszczaj w repozytorium.
- Uzupełnij dane swojej firmy w Fakturowni. Puste konto może pozwolić sprawdzić połączenie,
  ale odrzucić wystawienie faktury z powodu braku danych sprzedawcy.
- Do zapisania ustawień OMS-u potrzebujesz konta z prawem do Ustawień (domyślnie administrator).

## 1. Wyłącz Automatyczną wysyłkę KSeF w Fakturowni

**Zrób to przed wystawieniem pierwszej faktury z OMS-u.** W Fakturowni otwórz
**Ustawienia → KSeF** i ustaw **Automatyczna wysyłka = Wyłączona**.
Inaczej Fakturownia może sama wysłać fakturę do KSeF, zanim obejrzysz ją w OMS-ie.
Dokumentu wysłanego do KSeF nie da się skasować.

Ustawienie **Zablokuj tworzenie faktur niezgodnych z KSeF** zostaw włączone.
Nie wyłączaj kontroli poprawności dokumentów.

Po sprawdzeniu ustawienia w Fakturowni otwórz w OMS-ie **Ustawienia → Integracje → Fakturownia**
i kliknij **Sprawdziłem — automatyczna wysyłka wyłączona**.
Gdy Fakturownia sama wyśle dokumenty do KSeF, OMS pokazuje na tym ekranie alarm z numerami tych dokumentów.
Przycisk gasi alarm — kliknij go dopiero po wyłączeniu wysyłki w Fakturowni. Nie zmienia ustawień w Fakturowni.

## 2. Przygotuj token i domenę

W Fakturowni przejdź do **Ustawienia konta → Integracja → Kod autoryzacyjny API**
i skopiuj token użytkownika technicznego.

Domena to część adresu Twojego konta przed `.fakturownia.pl`.
Dla zmyślonego adresu `https://pracownia-polcien.fakturownia.pl` wpisujesz tylko
`pracownia-polcien`: bez `https://`, końcówki `.fakturownia.pl` i ukośników.

## 3. Wpisz dane w OMS-ie

1. Otwórz **Ustawienia → Integracje → Fakturownia**.
2. Wpisz **Domena konta** i **Token API**.
3. Kliknij **Zapisz**. Sam zapis niczego nie wystawia.
4. Kliknij **Sprawdź połączenie**.

Sprawdzenie czyta pierwszą stronę listy faktur. Niczego nie wystawia ani nie wysyła do KSeF.
**Działa.** oznacza, że OMS ma dostęp do listy. Przy **Nie działa.** przeczytaj komunikat,
sprawdź domenę i token, popraw je i ponów sprawdzenie.
Poprawny wynik nie sprawdza danych firmy ani ustawienia automatycznej wysyłki w Fakturowni.

Zapisany token nie wraca na ekran. Przy zmianie samej domeny pozostaw **Token API** puste,
aby zachować zapisany token.

### Gdy dane są w pliku konfiguracji

Administrator serwera może zamiast formularza wpisać parę zmiennych w pliku konfiguracji
`.env` (w instalacji klienta `oms.env`):

```dotenv
FAKTUROWNIA_API_TOKEN=wklej-tu-token
FAKTUROWNIA_DOMENA=pracownia-polcien
```

To przykład — w miejsce `wklej-tu-token` wpisz swój token. Po zmianie pliku uruchom ponownie OMS.
Wpisz obie zmienne albo żadnej — sama jedna albo domena z `https://` czy `.fakturownia.pl` zatrzymuje start OMS-u.
**Token i domena z pliku mają pierwszeństwo przed danymi z panelu.** Ekran wtedy tylko informuje,
że połączenie jest ustawione na serwerze; dane zmienia administrator w pliku.
Przycisk **Sprawdź połączenie** nadal pozwala sprawdzić dostęp.

## 4. Wybierz Fakturownię jako moduł faktur

1. Otwórz **Ustawienia → Integracje → Moduł faktur**.
2. Wybierz **Fakturownia** i kliknij **Zapisz**.
3. Uruchom ponownie OMS, aby wybór zaczął działać. Jeśli ekran udostępnia przycisk
   **Uruchom OMS ponownie**, możesz go użyć; w innym przypadku poproś administratora serwera.

Samo podłączenie tokenu nie przełącza programu faktur. Jeśli moduł jest wybrany w pliku konfiguracji,
administrator ustawia `OMS_PROGRAM_FAKTUROWY=fakturownia` i uruchamia ponownie OMS.
Zasady wyboru opisuje [Moduł faktur](modul-faktur.md).

## Co działa

- Faktury krajowe, także do zamówień za pobraniem, oraz WDT.
- Korekty zwrotów, pobieranie PDF i oznaczanie zapłaty.
- Wysyłka do KSeF po podglądzie w OMS-ie oraz automat KSeF w OMS-ie, po jego skonfigurowaniu.
  Wymaga to również połączenia konta Fakturowni z KSeF.
- Ochrona przed ponownym wystawieniem faktury dla tego samego zamówienia: Fakturownia odrzuca duplikat,
  a OMS informuje, że faktura już istnieje. Sprawdź istniejący dokument zamiast wystawiać kolejny ręcznie.

Ustawienia **Sposoby wyliczania** w Fakturowni nie wpływają na dokumenty wystawiane przez OMS.
OMS wysyła metodę wyliczania w każdym dokumencie i liczy VAT wierszami.
Nie musisz zmieniać tych ustawień konta na potrzeby OMS-u.

## Czego jeszcze nie ma

OMS nie pobiera UPO z Fakturowni i nie eksportuje z niej EPP. Nie wystawia też proform w Fakturowni
ani faktur w walutach obcych.

Przełączenie programu faktur nie przenosi dokumentów ani nie zachowuje dostępu do starych dokumentów
w OMS-ie. Wcześniejsze faktury pozostają w programie, w którym je wystawiono — tam je przeglądaj
i pobieraj ich PDF-y.
