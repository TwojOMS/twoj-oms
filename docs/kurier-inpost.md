# Kurier InPost (paczkomaty) — jak podłączyć

Po podłączeniu InPostu nadajesz paczki do paczkomatów prosto z OMS-u: OMS zakłada przesyłkę w InPoście (API
ShipX), bierze numer listu, drukuje etykietę i pokazuje status paczki na karcie zamówienia.

## Zanim zaczniesz

- **Potrzebujesz konta InPost z dostępem do API ShipX.** Podłączenie w OMS-ie nie zakłada konta w InPoście.
- **Adres nadawcy** to adres firmy: wpisujesz go w **Ustawienia → Firma** albo w pliku konfiguracji
  (`DPD_NADAWCA_…` w `oms.env` — plik ma pierwszeństwo). Ten sam adres trafia na etykiety DPD i InPost,
  proformy i specyfikacje.
- **InPost wymaga telefonu i e-maila nadawcy** (DPD nie). Bez nich OMS odmówi nadania, zanim cokolwiek
  pójdzie do InPostu. Telefon: polski numer, 9 cyfr (może być z `+48`).
- **Kuriera podłączasz w trybie pracy, nie próby.** W trybie próby (`OMS_TRYB=proba`, pierwsze uruchomienie
  z zamówieniami DEMO) OMS nie łączy się z prawdziwym InPostem: „Sprawdź połączenie” i nadanie odmawiają
  komunikatem „Piaskownica: prawdziwy InPost jest tu wyłączony” i nic nie idzie do InPostu. Kolejność
  kroków: `docs/instalacja-docker.md`, sekcje 8–9.

## 1. Dane z InPostu

Token API i numer organizacji bierzesz z panelu ShipX (API):

| z InPostu | gdzie wpisać w OMS-ie |
|---|---|
| token API ShipX | **Token API** |
| ID organizacji | **Numer organizacji** |

## 2. Wpisz dane w OMS-ie

1. Zaloguj się kontem z dostępem do **Ustawień**.
2. Wejdź w **Ustawienia → Integracje → Kurierzy → InPost (paczkomaty)**.
3. Wypełnij formularz:
   - **Nazwa** — dowolna, np. „InPost”;
   - **Numer organizacji** i **Token API** — dane z InPostu;
   - **Paczkomat nadawczy** — opcjonalny kod paczkomatu, w którym zostawiasz paczki. Puste pole: OMS go
     InPostowi nie podaje.
4. Kliknij **Zapisz**.
5. Kliknij **Sprawdź połączenie**. OMS pyta InPost o Twoją organizację, posługując się zapisanym tokenem.
   Niczego nie nadaje i nic za to nie płacisz.
   - „Działa” — InPost przyjął token i pokazał organizację.
   - „Nie działa” plus komunikat — najczęściej niepełny token albo inny numer organizacji. Popraw i sprawdź
     jeszcze raz.

Token nie wraca na ekran. Gdy zmieniasz inne pole, zostaw token puste: OMS zachowa zapisany.

Adres API jest stały: produkcyjne API ShipX. Innego adresu ekran nie przyjmuje — token nie może trafić pod
adres wpisany w formularzu. Inny adres da się ustawić tylko w pliku (`INPOST_URL`, razem z resztą `INPOST_…`).

Wagę i gabaryt skrytki (A, B, C) wybierasz przy nadaniu paczki.

## 3. Jeśli to Twój pierwszy kurier

Jeśli przed podłączeniem InPostu OMS nie miał żadnego kuriera (ani DPD, ani wysyłki z Allegro), ekran InPost
po zapisie napisze, że nadawanie włączy się po ponownym uruchomieniu. Wtedy na serwerze:

```bash
sudo sh /opt/oms/aktualizuj.sh compose restart oms
sudo sh /opt/oms/aktualizuj.sh status
```

Każdą kolejną zmianę na ekranie InPost OMS widzi od razu, bez ponownego uruchamiania.

## 4. Pierwsza paczka

**Pierwsze nadanie to prawdziwa paczka i prawdziwy koszt.** Zrób je świadomie, na jednym zamówieniu.
Sprawdź, czy etykieta się wydrukowała, a adres nadawcy i paczkomat odbiorcy się zgadzają.

## Gdy InPost jest już w pliku konfiguracji

Jeśli w `oms.env` jest `INPOST_TOKEN` (z `INPOST_ORGANIZACJA` i ewentualnie `INPOST_URL`,
`INPOST_PACZKOMAT_NADAWCZY`), OMS używa pliku, a ekran tylko pokazuje „Podłączony w pliku konfiguracji”.
Żeby przejść na ekran, usuń te linie z pliku, uruchom `sudo sh /opt/oms/aktualizuj.sh compose up -d`
i wpisz dane w formularzu.

## Odłączenie

**Ustawienia → Integracje → InPost → Odłącz InPost** usuwa token z OMS-u. Paczki już nadane i ich etykiety
zostają.
