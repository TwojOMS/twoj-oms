# Moduł faktur — jak wybrać

Moduł faktur określa, czy OMS wystawia faktury i z jakiego programu korzysta.
Wybierasz go w **Ustawienia → Integracje → Moduł faktur**.

## Dostępne opcje

| opcja | co oznacza |
|---|---|
| **Brak** | OMS nie wystawia faktur. |
| **inFakt** | OMS korzysta z inFaktu. Potrzebny jest skonfigurowany klucz inFaktu. |
| **Fakturownia — wkrótce** | Opcja jest nieaktywna. Nie można jej jeszcze wybrać. |
| **TwojeFaktury (program wbudowany) — wkrótce** | Opcja jest nieaktywna. Docelowo OMS sam wystawi faktury i wyśle je do KSeF, bez zewnętrznego programu. |

Jeśli niczego nie wybierzesz, OMS używa inFaktu, gdy jest skonfigurowany.
W przeciwnym razie faktury są wyłączone.

## 1. Wybierz moduł

1. Otwórz **Ustawienia → Integracje → Moduł faktur**.
2. Wybierz **Brak** albo **inFakt**.
3. Kliknij **Zapisz**.
4. Uruchom ponownie OMS, aby zapisany wybór zaczął działać. Chodzi o program OMS, nie o cały serwer ani komputer.
   Kliknij **Uruchom OMS ponownie** na tym samym ekranie (panel będzie niedostępny przez kilka sekund) albo,
   gdy przycisku nie ma, wpisz na serwerze w katalogu instalacji `docker compose restart oms`.
   Przycisk jest tylko tam, gdzie OMS wstaje sam po zatrzymaniu (instalacja z Dockerem, `OMS_RESTART_Z_PANELU=tak`).

Ekran mogą oglądać osoby z uprawnieniem do Ustawień. Zapis jest dostępny tylko dla administratora.
Wybór dotyczy całej firmy.

Ekran pokazuje **Teraz działa** oraz zapisany wybór, który czeka na ponowne uruchomienie.
Gdy działa inFakt, po zapisaniu **Brak** zobaczysz:
„Zapisany moduł faktur „Brak” zadziała po ponownym uruchomieniu OMS-u — do tego czasu działa „inFakt”. Automatyczna wysyłka do KSeF już stoi.”
Ręczne wystawianie nadal działa do restartu. **Automat KSeF zatrzymuje się od razu.**
Gdy działa **Brak**, po zapisaniu **inFakt** z kluczem zobaczysz:
„Zapisany moduł faktur „inFakt” zadziała po ponownym uruchomieniu OMS-u — do tego czasu faktury są wyłączone.”
Jeśli inFakt nie ma klucza, komunikat brzmi:
„Zapisany moduł faktur „inFakt” nie ma klucza API — wpisz go w Ustawienia → Integracje → inFakt (/ustawienia/integracje/infakt); faktury ruszą po ponownym uruchomieniu OMS-u.”

## 2. Co zmienia „Brak”

Gdy zacznie działać **Brak**, OMS nie wystawia faktur. Zapisany klucz inFaktu zostaje w bazie,
ale OMS go nie używa.

Wcześniejsze faktury zostają w programie, w którym je wystawiono. Numer zapisanej faktury nadal
widać na karcie zamówienia. Po wybraniu **Brak** w Ustawieniach ekran **FAKTURY** pokazuje zamiast listy:
„Faktury w OMS-ie są wyłączone — w Ustawienia → Integracje → Moduł faktur wybrano „Brak”. Wcześniejsze faktury obejrzysz w programie, w którym je wystawiono.”
Przy wyborze w pliku pierwsze zdanie brzmi:
„Faktury w OMS-ie są wyłączone — w pliku konfiguracji jest OMS_PROGRAM_FAKTUROWY=brak.”
Lista jest pobierana z programu fakturowego i nie ma lokalnej kopii.

Przy **Brak** OMS nie pobierze PDF-u wcześniejszej faktury, nie wyśle jej mailem, do Allegro ani do KSeF.
Nie wystawi też korekty. Zamiast tych czynności pokaże komunikat o wyłączonych fakturach.
Przy pobieraniu PDF-u dopisze: „PDF wcześniejszej faktury pobierzesz w programie, w którym ją wystawiono.”
Zdanie o wyłączonych fakturach dotyczy jawnego wyboru **Brak** w Ustawieniach albo w pliku.
Gdy niczego nie wybrano i inFakt nie jest skonfigurowany, OMS pokazuje komunikaty o braku konfiguracji inFaktu.

**Brak** nie wyłącza proform ani KSeF kosztów. Moduł kosztów korzysta z osobnego tokenu tylko do odczytu.

## Gdy moduł jest ustawiony w pliku konfiguracji

Zmienna `OMS_PROGRAM_FAKTUROWY` ma pierwszeństwo przed wyborem zapisanym w panelu.
Przy ustawieniu w pliku pola na ekranie są nieaktywne. Zmianę wykonujesz w pliku konfiguracji.

Możesz ustawić `OMS_PROGRAM_FAKTUROWY=brak` albo `OMS_PROGRAM_FAKTUROWY=infakt`.
Wielkość liter i spacje na początku i końcu nie mają znaczenia. Zła wartość zatrzymuje start OMS-u.
Na przykład przy `OMS_PROGRAM_FAKTUROWY=infkat` komunikat brzmi:
„OMS_PROGRAM_FAKTUROWY: nieznany moduł faktur „infkat” — wpisz brak albo infakt (fakturownia, twojefaktury — wkrótce) lub usuń zmienną.”
Wartości `fakturownia` i `twojefaktury` też zatrzymują start: te opcje są jeszcze niedostępne.
Przy `OMS_PROGRAM_FAKTUROWY=fakturownia` zobaczysz:
„OMS_PROGRAM_FAKTUROWY: moduł faktur „fakturownia” będzie dostępny wkrótce, ta wersja OMS-u go nie ma — wpisz brak albo infakt (fakturownia, twojefaktury — wkrótce) lub usuń zmienną.”

## Wycofanie do wcześniejszej wersji

Wersja OMS-u bez ekranu Moduł faktur nie zna zapisanego wyboru modułu faktur. Po wycofaniu do takiej wersji
wybór **Brak** nie chroni przed wystawianiem faktur. Jeśli klucz inFaktu jest zapisany,
OMS znów wystawia faktury w inFakcie.
