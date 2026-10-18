# Kurier DPD Polska — jak podłączyć

Po podłączeniu DPD nadajesz paczki prosto z OMS-u: OMS bierze numer listu od DPD, drukuje etykietę
i pokazuje status paczki na karcie zamówienia.

## Zanim zaczniesz

- **Musisz mieć umowę z DPD Polska.** Podłączenie w OMS-ie nie zakłada konta w DPD. Bez umowy DPD nie
  da Ci danych do API.
- **Adres nadawcy** to adres firmy: wpisujesz go w **Ustawienia → Firma** albo w pliku
  konfiguracji (`DPD_NADAWCA_…` w `oms.env` — plik ma pierwszeństwo, ekran jest wtedy tylko do odczytu).
  Ten sam adres trafia na etykiety, proformy i specyfikacje. Ekran DPD pokazuje, jaki adres OMS ma
  wpisany, z linkiem do ekranu adresu.
- **Kuriera podłączasz w trybie pracy, nie próby.** W trybie próby (`OMS_TRYB=proba`, pierwsze uruchomienie
  z zamówieniami DEMO) OMS nie łączy się z prawdziwym DPD: „Sprawdź połączenie” i nadanie odmawiają
  komunikatem „Piaskownica: prawdziwe DPD jest tu wyłączone” i nic nie idzie do DPD. Kolejność kroków:
  `docs/instalacja-docker.md`, sekcje 8–9.

## 1. Poproś DPD o dane do API

Napisz do DPD Polska: do Biura Obsługi Klienta albo do swojego opiekuna handlowego (adres masz w umowie
albo w mailach od DPD). Poproś o dostęp do API DPD, czyli DPD Web Services. W odpowiedzi dostaniesz:

| od DPD | gdzie wpisać w OMS-ie |
|---|---|
| login | **Login** |
| główny numer klienta, czyli „master FID” | **Główny numer klienta DPD (Master FID)** |
| hasło | **Hasło** |
| kanał DPD Info (osobna usługa, pozwala śledzić paczki) | **Kanał śledzenia DPD Info** — pole opcjonalne |

Bez kanału DPD Info OMS też nadaje paczki, ale nie pokaże ich statusów z DPD. Dlatego o kanał warto
poprosić w tym samym mailu.

### Szkic maila do DPD

Uzupełnij pola w nawiasach i wyślij ze swojej skrzynki firmowej.

> **Temat:** Prośba o dostęp do API DPD (Web Services) — [nazwa firmy], numer klienta [numer z umowy]
>
> Dzień dobry,
>
> mamy z Państwem umowę na usługi kurierskie: [nazwa firmy], NIP [NIP], numer klienta [numer z umowy].
>
> Chcemy nadawać przesyłki z własnego systemu do obsługi zamówień. Prosimy o dostęp do DPD Web Services:
>
> 1. login, hasło i główny numer klienta (master FID) do usługi nadawania przesyłek (DPDServices:
>    numery listów, etykiety, protokoły odbioru);
> 2. dostęp do usługi DPD Info Services (kanał, login i hasło), żeby pobierać statusy naszych przesyłek;
> 3. potwierdzenie, które numery FID są przypisane do naszego konta i z którego mamy nadawać.
>
> Nadajemy [liczba] paczek miesięcznie, [także / bez] przesyłek za pobraniem.
>
> Z poważaniem
> [imię i nazwisko]
> [telefon]

## 2. Wpisz dane w OMS-ie

1. Zaloguj się kontem z dostępem do **Ustawień**.
2. Wejdź w **Ustawienia → Integracje → Kurierzy → DPD Polska**.
3. Wypełnij formularz:
   - **Nazwa** — dowolna, np. „DPD”;
   - **Login**, **Główny numer klienta DPD (Master FID)**, **Hasło** — dane od DPD;
   - **Typ etykiety** — „Drukarka etykiet 10×15 cm (PDF i ZPL dla Zebry)”, jeśli masz drukarkę etykiet,
     albo „Zwykła drukarka — etykieta na kartce A4”;
   - **Kanał śledzenia DPD Info** — jeśli go dostałeś.
4. Kliknij **Zapisz**.
5. Kliknij **Sprawdź połączenie**. OMS pyta DPD o kod pocztowy Twojego adresu nadawcy, logując się
   Twoimi danymi. Niczego nie nadaje i nic za to nie płacisz.
   - „Działa” — DPD przyjęło dane.
   - „Nie działa” plus komunikat od DPD — najczęściej literówka w loginie, haśle albo numerze klienta.
     Popraw dane i sprawdź jeszcze raz.

Hasło nie wraca na ekran. Gdy zmieniasz inne pole, zostaw hasło puste: OMS zachowa zapisane.

**Wagi i wymiary paczek** ustawiasz w jednym miejscu dla wszystkich kurierów: **Ustawienia → Zamówienia
i wysyłka → szablony paczek**.

## 3. Jeśli to Twój pierwszy kurier

Jeśli przed podłączeniem DPD OMS nie miał żadnego kuriera (ani InPostu, ani wysyłki z Allegro), ekran
DPD po zapisie napisze, że nadawanie włączy się po ponownym uruchomieniu. Wtedy na serwerze:

```bash
sudo sh /opt/oms/aktualizuj.sh compose restart oms
sudo sh /opt/oms/aktualizuj.sh status
```

Każdą kolejną zmianę na ekranie DPD OMS widzi od razu, bez ponownego uruchamiania.

## 4. Pierwsza paczka

**Pierwsze nadanie to prawdziwa paczka i prawdziwy koszt.** Zrób je świadomie, na jednym zamówieniu.
Sprawdź, czy etykieta się wydrukowała, a adres nadawcy i odbiorcy się zgadzają.

## Gdy DPD jest już w pliku konfiguracji

Jeśli w `oms.env` są zmienne `DPD_URL`, `DPD_LOGIN` itd., OMS używa ich, a ekran tylko pokazuje
„Podłączony w pliku konfiguracji”. Żeby przejść na ekran, usuń linie `DPD_URL`, `DPD_LOGIN`,
`DPD_PASSWORD`, `DPD_FID`, `DPD_INFO_URL` i `DPD_INFO_CHANNEL` z pliku, uruchom
`sudo sh /opt/oms/aktualizuj.sh compose up -d` i wpisz dane w formularzu.

## Odłączenie

**Ustawienia → Integracje → DPD Polska → Odłącz DPD** usuwa z OMS-u dane logowania. Paczki już nadane
i ich etykiety zostają.

## Czego ten ekran jeszcze nie ma

Automatycznego ubezpieczenia (deklarowana wartość paczki) i kilku paczek w jednym nadaniu jako jednej
przesyłki. Kolejną paczkę do tego samego zamówienia OMS nadaje osobno, z numerem `/2`, `/3`.
