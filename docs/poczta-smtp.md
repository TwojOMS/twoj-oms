# Poczta wychodząca (SMTP) — jak ustawić

Po ustawieniu poczty OMS sam wysyła zaproszenia do kont, linki do ustawienia nowego hasła i wiadomości
do klientów z karty zamówienia. Bez poczty zostaje „Pokaż link”: link do hasła kopiujesz i przekazujesz
pracownikowi sam.

## Zanim zaczniesz

- **Potrzebujesz skrzynki firmowej, z której mają wychodzić maile**, np. `sklep@twoja-firma.pl`.
  OMS nie zakłada skrzynki — loguje się do istniejącej, tak jak program pocztowy.
- **Dane serwera poczty wychodzącej** znajdziesz u dostawcy poczty (hosting, Google Workspace,
  Microsoft 365), zwykle w pomocy pod hasłem „SMTP” albo „konfiguracja programu pocztowego”.
- Część dostawców nie przyjmuje zwykłego hasła do skrzynki od programów zewnętrznych i wymaga
  osobnego **hasła aplikacji**. Wtedy w OMS-ie wpisujesz hasło aplikacji.

## 1. Zbierz dane od dostawcy poczty

| od dostawcy poczty | gdzie wpisać w OMS-ie | przykład (zmyślony) |
|---|---|---|
| serwer poczty wychodzącej (SMTP) | **Serwer SMTP** | `smtp.twoja-firma.pl` |
| port | **Port** | `465` (SSL) albo `587` (STARTTLS) |
| login | **Login** | `sklep@twoja-firma.pl` |
| hasło albo hasło aplikacji | **Hasło** | — |

Jeśli dostawca podaje oba porty, wybierz 465.

## 2. Wpisz dane w OMS-ie

1. Zaloguj się kontem z dostępem do **Ustawień** (administrator).
2. Wejdź w **Ustawienia → Integracje → Poczta → Poczta wychodząca (SMTP)**.
3. Wypełnij **Serwer poczty**: serwer, port, login i hasło. Pole **Nadawca** jest opcjonalne — wpisz je,
   jeśli maile mają mieć nazwę firmy, np. `Twoja Firma <sklep@twoja-firma.pl>`. Puste = maile idą
   z adresu z loginu.
4. Kliknij **Zapisz**. Ustawienia działają od następnego maila, bez ponownego uruchamiania OMS-u.
5. Część **Adres panelu w mailach** możesz zostawić pustą: linki w zaproszeniach i mailach z hasłem
   poprowadzą wtedy pod adres, z którego administrator właśnie korzysta (ekran go podpowiada, a po
   wysyłce komunikat mówi, dokąd prowadzi link). Wpisz własny adres, np. `https://panel.twoja-firma.pl`
   albo `http://192.168.1.20:3001`, i kliknij **Zapisz adres**, gdy pracownicy otwierają panel pod innym
   adresem albo czytają pocztę poza biurem — link musi działać tam, gdzie ktoś otworzy maila. Sam adres:
   `http://` albo `https://`, nazwa hosta i ewentualnie port — bez ścieżki i bez `?`. Wyczyszczone pole
   i **Zapisz adres** wraca do adresu domyślnego.

Hasło nie wraca na ekran. Gdy poprawiasz inne pole, zostaw hasło puste: OMS zachowa zapisane.

## 3. Wyślij wiadomość próbną

W części **Wiadomość próbna** OMS podpowiada Twój adres e-mail z konta (możesz wpisać inny). Kliknij
**Wyślij wiadomość próbną** i sprawdź skrzynkę, także folder ze spamem.

- „Wysłano” — poczta działa; zaproszenia i linki do hasła dojdą tą samą drogą.
- „Nie wysłano” z komunikatem:
  - *odrzucił login albo hasło* — literówka w loginie albo haśle, albo dostawca wymaga hasła aplikacji;
  - *nie udało się połączyć* — sprawdź nazwę serwera i port (465 albo 587);
  - *odrzucił adres nadawcy albo odbiorcy* — skrzynka nie może wysyłać jako adres z pola **Nadawca**
    (wpisz tam adres z loginu) albo adres odbiorcy jest błędny.

## 4. Jeśli to pierwsza poczta w tym panelu

Zaproszenia, linki do hasła i wiadomość próbna działają od razu po zapisie. **Wiadomości do klientów
na karcie zamówienia** włączą się po ponownym uruchomieniu OMS-u — ekran poczty to napisze. Na serwerze:

```bash
sudo sh /opt/oms/aktualizuj.sh compose restart oms
sudo sh /opt/oms/aktualizuj.sh status
```

Każdą kolejną zmianę na ekranie poczty OMS widzi od razu.

## Gdy poczta jest już w pliku konfiguracji

Jeśli w `oms.env` są zmienne `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (i ewentualnie
`MAIL_FROM`), OMS używa ich, a ekran pokazuje „Ustawiona w pliku konfiguracji” bez formularza. To samo
z adresem panelu: `OMS_ADRES_PANELU` w pliku wygrywa nad adresem z ekranu. Wiadomość próbną możesz
wysłać także wtedy — pójdzie pocztą z pliku.

Żeby przejść na ekran, usuń te linie z pliku, uruchom `sudo sh /opt/oms/aktualizuj.sh compose up -d`
i wpisz dane w formularzu.

## Usunięcie

**Ustawienia → Integracje → Poczta wychodząca → Usuń ustawienia poczty** usuwa z OMS-u serwer, login
i hasło. Wysłane maile i historia wiadomości na zamówieniach zostają.

## W środowisku demo

W środowisku demo (`start.mjs` w katalogu `deploy/demo`; tak działa też publiczne demo na twojoms.pl)
każdy mail, także próbny, przejmuje atrapa poczty: OMS zapisuje go tylko w swoim logu i nic nie wychodzi
z serwera — nawet jeśli wpiszesz na ekranie prawdziwą skrzynkę.
