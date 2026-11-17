# Aktualizacja OMS u klienta — V0 (operator)

Dla osoby, która aktualizuje instalację z `docs/instalacja-docker.md`: operatora serwera (SSH)
albo agenta AI. Jedno polecenie na serwerze robi całą zmianę i zatrzymuje się
przed decyzją; decyzję (`accept` albo `recover`) podejmuje człowiek po odbiorze.

Narzędzie: `deploy/klient/aktualizuj.sh` (w każdej paczce), na serwerze jako `/opt/oms/aktualizuj.sh`.

## Co robi `deploy` — i kiedy panel stoi

| etap | co się dzieje | panel |
|---|---|---|
| preflight | odcisk paczki = podany, treść paczki (jeden katalog, bez `..`, ścieżek absolutnych i dowiązań), `wydanie.json`, aktualizator z tej paczki, bieżące wydanie zgodne z działającym kontenerem, wersja inna niż bieżąca, miejsce na dysku, `$` w konfiguracji (ostrzeżenie) | działa |
| `zablokowane` | trwała blokada jednej operacji (`/opt/oms/update-state/blokada`) | działa |
| `rozpakowane` | paczka w nowym `/opt/oms/releases/oms-<12>` z odciskami plików | działa |
| `zbudowane` | obraz `oms:<commit>`, etykieta revision = commit z `wydanie.json`; gdy nowe wydanie szyfruje poświadczenia w bazie — obraz nowego wydania zapewnia plik klucza `/opt/oms/config/klucz.env` i sprawdza go z bazą (odmowa `KLUCZ_POSWIADCZEN_ODMOWA` = stare wydanie pracuje dalej) | działa |
| `zatrzymane` | `oms` i `oms-kopia` zatrzymane — żadnych zapisów | **stoi** |
| `kopia` | kopia operacji w `/opt/oms/backups/operacje/<operacja>/`: baza (VACUUM INTO, `integrity_check`), lista migracji, `config/nazwy-zmiennych.txt` (same nazwy zmiennych z `oms.env` i `kopia.env`, bez wartości), etykiety, proformy, `kopia.sha256`. `klucz.env` nie trafia tam nigdy | **stoi** |
| `uruchomione` | nowe wydanie wstaje na swoim obrazie; `/health` 200, wersja w `/health` i `/app/wydanie.json` = commit | **stoi** do zdrowego startu |
| `czeka_na_akceptacje` | `NEEDS_ACCEPT` — nowe wydanie pracuje, blokada trzyma | działa (nowe) |

Błąd przed zatrzymaniem: blokada zdjęta, nic się nie zmieniło. Błąd w kopii: stare wydanie wraca
samo, blokada zdjęta, baza nietknięta. Błąd od startu nowego wydania: blokada zostaje — `recover`.

Konfiguracji kopia operacji nie przechowuje — `recover` jej nie przywraca. Kopie operacji zrobione
starszym aktualizatorem (sprzed `nazwy-zmiennych.txt`) mają jeszcze w katalogu `config/` pełne pliki
`oms.env` i `kopia.env`. Nic ich nie przepisuje: znikają z retencją, po dwóch kolejnych
zaakceptowanych aktualizacjach (kopia z odłożoną bazą `po-kandydacie-*` zostaje do ręcznego usunięcia).
Do tego czasu katalog `/opt/oms/backups/operacje` traktuj jak katalog z hasłami.

⚠️ **Ograniczenie V0:** nowe wydanie startuje z działającymi integracjami (pollery Allegro/sklepów,
czuwacze). Podczas odbioru może pobrać zamówienia i zapisać je w bazie.
Każdy taki zapis zostaje po `recover` bez przywracania bazy, a znika przy `--przywroc-baze`.
Odbiór robić wyłącznie odczytem: **bez nadań, faktur, maili i zmian w sklepach** aż do `accept`.

## 1. Paczka (laptop, PowerShell)

Paczka powstaje z zatwierdzonego commita (własne zmiany najpierw zatwierdź w Git, a bramkę
`npm run sprawdz` miej zieloną). W katalogu sklonowanego repo:

```powershell
node scripts/paczka-klienta.mjs --commit <pełny SHA> --wyjscie C:/OMS-paczki/paczka-<SHA>
```

Wynik: `oms-<12>.tar.gz`, `oms-<12>.tar.gz.sha256` (suma) i `oms-<12>.manifest.json` (odciski plików).
Sumę SHA-256 zapisz — `deploy` jej wymaga i porównuje z plikiem na serwerze.

## 2. Przesłanie (PowerShell, pełne nazwy plików)

```powershell
scp C:/OMS-paczki/paczka-<SHA>/oms-<12>.tar.gz C:/OMS-paczki/paczka-<SHA>/oms-<12>.tar.gz.sha256 uzytkownik@adres-serwera:
```

Adres serwera: nazwa albo adres Tailscale (`100.x.y.z`), w LAN — adres lokalny.

## 3. Na serwerze: aktualizator z paczki, stan, deploy

Przed każdym blokiem `sudo -v` (pytanie o hasło nie może zjeść linii bloku).

```bash
cd ~
sha256sum -c oms-<12>.tar.gz.sha256
tar -xzOf oms-<12>.tar.gz oms-<12>/deploy/klient/aktualizuj.sh | sudo tee /opt/oms/aktualizuj.sh > /dev/null
sudo sh /opt/oms/aktualizuj.sh status
nohup sudo sh /opt/oms/aktualizuj.sh deploy ~/oms-<12>.tar.gz <sha256> > ~/deploy-<12>.log 2>&1 &
tail -f ~/deploy-<12>.log
```

`nohup … &`: zerwane połączenie SSH (Tailscale, Wi-Fi) nie przerywa deploy w połowie. `tail -f` kończy
się Ctrl+C — deploy pracuje dalej; wynik zawsze w `~/deploy-<12>.log` i w `status`.

`status` przed deploy: `blokada: brak`, oba kontenery `running`, `zdrowie: HTTP=200`. Pierwsza
aktualizacja instalacji sprzed aktualizatora pokazuje „brak wskaźnika” — `deploy` ustali bieżące
wydanie z działającego kontenera (wpis `ADOPCJA` w historii).

Wynik `deploy` kończy się wierszem:

```
NEEDS_ACCEPT operacja=<RRRRMMDD-GGMMSS-xxxx> cel=<commit> obraz=sha256:<…> przerwa_s=<sekundy przerwy>
```

Zapisz `operacja` — `accept` i `recover` przyjmują wyłącznie ją.

⚠️ Po `KANDYDAT_…` albo `WERSJA_…` nowe wydanie zostaje uruchomione (z integracjami) do czasu
`recover` — nie zostawiaj tego stanu na noc.

## 4. Odbiór (blokada trzyma, przed decyzją)

1. `sudo sh /opt/oms/aktualizuj.sh status` — `etap=czeka_na_akceptacje`, oba kontenery na nowym
   obrazie, `revision` = nowy commit, `zdrowie: HTTP=200 wersja=<nowy commit>`.
2. `/health` w przeglądarce (`http://adres:3001/health`): `alarmy` — te same co przed aktualizacją
   (alarm kopii lub kanału, który był wcześniej, nie jest winą wydania); nowy alarm = STOP.
3. Logowanie własnym kontem (po pierwszej aktualizacji do wydania szyfrującego poświadczenia każdy loguje
   się od nowa — to oczekiwane); lista zamówień — ta sama liczba co przed (plus nowe z pollerów);
   karta jednego zamówienia; podgląd istniejącej proformy i etykiety; Ustawienia → Zespół i dostęp → Użytkownicy.
4. `sudo sh /opt/oms/aktualizuj.sh compose logs --since 15m oms` — brak nowych błędów.
5. Gdy coś budzi wątpliwość: `cd ~ && sudo sh /opt/oms/releases/oms-<12>/deploy/klient/diagnostyka.sh`
   i zachowaj plik (hasła i klucze są w nim zamaskowane).

## 5. Decyzja

| decyzja | polecenie | skutek |
|---|---|---|
| zostaje nowe | `sudo sh /opt/oms/aktualizuj.sh accept <operacja>` | wskaźnik bieżącego wydania przesunięty (zmiana nazwy pliku — atomowa), blokada zdjęta; zostają 2 poprzednie wydania i 2 ostatnie kopie operacji, starsze obrazy i cache budowania starszy niż 7 dni usunięte |
| powrót | `sudo sh /opt/oms/aktualizuj.sh recover <operacja>` | poprzednie wydanie na swoim obrazie, ta sama baza; jeśli nowe wydanie wykonało migracje, aktualizator to wypisuje (`MIGRACJE kandydat zmienił listę migracji`); gdy poprzednie wydanie nie zna szyfrowania poświadczeń, najpierw je odszyfrowuje (sekcja „Poświadczenia szyfrowane w bazie”) |
| powrót z bazą sprzed aktualizacji | `sudo sh /opt/oms/aktualizuj.sh recover <operacja> --przywroc-baze` | jak wyżej + baza z kopii operacji (konfiguracja zostaje — aktualizacja jej nie zmienia); **gubi wszystko zapisane po zatrzymaniu** (zamówienia pobrane w czasie odbioru, nadania, faktury). Obecna baza zostaje w `…/operacje/<operacja>/po-kandydacie-<czas>/`; powtórzony `--przywroc-baze` jej nie rusza |

Dlaczego domyślnie bez przywracania bazy: migracje od 0002 są wyłącznie addytywne (kontrola
przy starcie), a stary kod pomija migracje, których nie zna — stare wydanie pracuje na bazie
po migracjach. Rozpoznanie: lista `migracje` w bazie porównana z
`migracje.json` kopii operacji. `--przywroc-baze` dopiero, gdy stare wydanie na tej bazie nie wstaje.

Po `accept` powrotu tą drogą nie ma — następne wydanie albo osobna procedura.

## 6. Stan → co dalej

Najpierw zawsze `sudo sh /opt/oms/aktualizuj.sh status` (pokazuje etap, operację, stan kontenerów,
czy proces aktualizatora żyje i podpowiedź „dalej”). Po restarcie maszyny nic nie wznawia się samo:
zatrzymany przez aktualizację OMS stoi, dopóki operator nie zdecyduje.

| stan (`status`) | co się stało | dalej |
|---|---|---|
| odmowa z kodem `PACZKA_…`, `BRAK_MIEJSCA_…`, `WERSJA_…`, `WYDANIE_ISTNIEJE_…`, `BAZA_…` | preflight — nic nie zmieniono | usunąć przyczynę (inna paczka, miejsce: `docker system df`, stare pliki w `~`), powtórzyć |
| `AKTUALIZATOR_INNY_NIZ_W_PACZCE` | `/opt/oms/aktualizuj.sh` z innej paczki | polecenie `tar -xzOf … | sudo tee …` z kroku 3, powtórzyć |
| `ODMOWA_TRWA_OPERACJA <op>` | blokada innej operacji | `status`; dokończyć tamtą (`accept`/`recover`) |
| `PRZERWANE na etapie …` | błąd przed zatrzymaniem (np. build bez internetu) | blokady nie ma, działa stare wydanie; przyczyna z wyjścia, powtórzyć |
| `WYCOFANE na etapie zatrzymane/kopia` | błąd kopii operacji; stare wydanie wróciło | blokady nie ma; sprawdzić miejsce i `wynik.json` w katalogu operacji |
| `etap=zablokowane/rozpakowane/zbudowane`, proces nie działa | przerwanie (kill, utrata SSH, restart) przed zatrzymaniem | `recover <op>` — stare wydanie pracowało cały czas |
| `etap=zatrzymane` albo `kopia`, proces nie działa | przerwanie w oknie przerwy; **panel stoi**, baza nietknięta | `recover <op>` |
| `etap=uruchomione` | nowe wydanie nie wstało (`KANDYDAT_W_PETLI_RESTARTOW` — pada przy starcie, koniec czekania po 3. restarcie; `OMS_NIE_WSTAL` — brak odpowiedzi w 180 s) albo kontrola wersji nie przeszła (`WERSJA_…`) | `recover <op>`; jeśli stare nie wstaje na bazie po migracjach — `recover <op> --przywroc-baze` |
| `etap=czeka_na_akceptacje` | `NEEDS_ACCEPT` | odbiór, `accept <op>` albo `recover <op>` |
| `etap=akceptowanie`, `biezace` = nowe | `accept` przerwany po przesunięciu wskaźnika | `accept <op>` jeszcze raz (recover odmówi: `AKCEPTACJA_JUZ_ZAPISANA`) |
| `etap=przywracanie` | `recover` przerwany albo stare wydanie nie wstało (`POWROT_NIEUDANY`) | `recover <op>` jeszcze raz; dalej `--przywroc-baze`; dalej diagnostyka (`diagnostyka.sh`) |
| `typ=produkcja` w stanie blokady | przejście z próby na pracę (`aktualizuj.sh produkcja`, docs/instalacja-docker.md, sekcja 8) | `czeka_na_akceptacje`: odbiór, `accept <op>` albo `recover <op>` (powrót do próby); każdy inny etap: `recover <op>` — próba wraca z archiwum `/opt/oms/proba-archiwum/<op>/` |
| `blokada: BEZ STANU` | przerwanie w chwili zakładania blokady | `recover nieznana` |
| `proces … aktualizatora DZIAŁA` | deploy jeszcze pracuje (np. build) | czekać; `recover` w tym czasie odmawia |
| `UWAGA: działa inny obraz niż bieżące wydanie` | ktoś uruchomił `docker compose` w katalogu starego wydania | `sudo sh /opt/oms/aktualizuj.sh compose up -d` |
| `KLUCZ_POSWIADCZEN_ODMOWA` | przed zatrzymaniem: brak pliku klucza przy zaszyfrowanej bazie, plik pusty albo ucięty, klucz niezgodny z bazą | blokady nie ma, działa stare wydanie; przyczyna w wierszu nad odmową; klucz z menedżera haseł — `docs/instalacja-docker.md`, rozdział „Klucz poświadczeń” |
| `ODSZYFROWANIE_NIEUDANE` | `recover` na wydanie sprzed szyfrowania nie odszyfrował bazy | blokada zostaje, stare wydanie nie startuje; popraw klucz w `/opt/oms/config/klucz.env` i `recover <op>` jeszcze raz, albo `recover <op> --przywroc-baze` (gubi zapisy z okna odbioru) |
| `BRAK_KONWERTERA`, `FORMAT_BEZ_KONWERTERA` | obraz nowego wydania zniknął albo baza ma format, którego poprzednie wydanie nie zna i nie ma do niego konwertera | nic nie zatrzymano; `recover <op> --przywroc-baze` (gubi zapisy z okna odbioru) |
| `typ=sekrety` w stanie blokady | przerwane polecenie `aktualizuj.sh sekrety …` zmieniające bazę; OMS stoi | ponów to polecenie albo `recover <op>` (zdejmuje tylko blokadę), potem `compose up -d` |

⛔ Nie usuwać ręcznie `/opt/oms/update-state/blokada`, nie zmieniać `biezace`, nie wybierać obrazu po
nazwie. Ręczna zmiana stanu to ostateczność po `status` i `diagnostyka.sh`, nie decyzja na ślepo.

## Poświadczenia szyfrowane w bazie

Od wydania z polem `formatSekretow` w `wydanie.json` poświadczenia integracji są szyfrowane w bazie
kluczem z `/opt/oms/config/klucz.env`. Opis klucza, kopii i odtwarzania: `docs/instalacja-docker.md`,
rozdział „Klucz poświadczeń”.

**Pierwsza aktualizacja do wydania szyfrującego.** Na etapie `zbudowane`, gdy stare wydanie jeszcze
pracuje, `deploy` zakłada klucz (`KLUCZ_UTWORZONY id …`). Przy istniejącym pliku sprawdza go z bazą
(`KLUCZ_ZGODNY id …`); odmowa = stare wydanie pracuje dalej. Nowe wydanie przy pierwszym starcie:

- szyfruje poświadczenia zapisane w bazie jawnie, jedną transakcją;
- wymienia sekret sesji — wszyscy logują się od nowa;
- przepakowuje plik bazy, żeby nie zostały w nim stare wartości (baza 1 GB: 12,6 s, pomiar 17.11.2026;
  potrzeba wolnego miejsca do dwóch rozmiarów bazy — bez niego start trwa dalej, a `/health` ma uwagę).

Po udanym starcie wynik ma wiersz `KLUCZ_POSWIADCZEN /opt/oms/config/klucz.env id …`. Zapisz zawartość
tego pliku w menedżerze haseł, z id i datą, jeszcze przed `accept`. Kopie zrobione przed tą
aktualizacją (dzienne, na nośniku, kopia operacji) mają poświadczenia jawne i znikają z retencją:
dzienne po 14 dniach, na nośniku po 30 kopiach, kopie operacji po dwóch kolejnych aktualizacjach.

**Powrót a format danych.** `recover` decyduje po stanie bazy, nie po numerach wydań:

- poprzednie wydanie nie zna szyfrowania, baza zostaje (bez `--przywroc-baze`) — po zatrzymaniu OMS-u
  obraz nowego wydania odszyfrowuje poświadczenia (`ODSZYFROWANE wartości: N`), potem startuje stare
  wydanie. Odszyfrowanie można powtarzać: powtórny `recover` po przerwaniu jest bezpieczny;
- `ODSZYFROWANIE_NIEUDANE` — blokada zostaje, stare wydanie nie startuje (nie odczytałoby bazy).
  Popraw przyczynę (zwykle klucz w `klucz.env`) i `recover <op>` jeszcze raz; albo
  `recover <op> --przywroc-baze`, który gubi zapisy z okna odbioru;
- `--przywroc-baze` — baza wraca z kopii operacji, w formacie poprzedniego wydania; odszyfrowanie
  nie jest potrzebne;
- baza w formacie, którego poprzednie wydanie nie zna, a konwertera nie ma (`FORMAT_BEZ_KONWERTERA`)
  — odmowa, zanim cokolwiek się zatrzyma.

`klucz.env` po powrocie zostaje na miejscu. Następna aktualizacja do wydania szyfrującego go użyje
i znów zaszyfruje bazę — znów z wymianą sekretu sesji.

**Polecenia `aktualizuj.sh sekrety …`** (pełna tabela: `docs/instalacja-docker.md`, rozdział
„Klucz poświadczeń”):

- odczyt — `stan`, `sprawdz`, `porzuc` bez potwierdzenia: bez blokady i bez zatrzymywania OMS-u;
- zapis bazy — `odszyfruj`, `sprzataj`, `porzuc --potwierdz …`, `porzuc --potwierdz-wszystkie`,
  `porzuc --nowy-klucz …`: tylko przy zatrzymanym OMS-ie. Przy pracującym — odmowa `SEKRETY_OMS_DZIALA`
  z podpowiedzią: `sudo sh /opt/oms/aktualizuj.sh compose stop oms kopia`, polecenie,
  `sudo sh /opt/oms/aktualizuj.sh compose up -d`;
- ścieżkę pliku klucza ustala aktualizator (`--plik` jest odrzucane); `--baza` tylko przy odczycie —
  plik spoza `/opt/oms/data` jest montowany tylko do odczytu;
- przy niezamkniętej operacji polecenie używa obrazu nowego wydania zapisanego w stanie operacji:
  po nieudanej aktualizacji wskaźnik pokazuje stare wydanie, które narzędzia może nie mieć.
  `NARZEDZIE_SEKRETOW_NIEDOSTEPNE` — obraz nie ma narzędzia (wydanie sprzed szyfrowania).

`diagnostyka.sh` ma wiersz o `klucz.env`: czy jest, czy należy do użytkownika 10001 i ma tryb 600 —
bez wartości klucza.

## Czego V0 nie ma

- podpisu wydawcy (dziś: suma SHA-256 podana przez operatora — wykrywa uszkodzenie, nie autora);
- wykrywania przeróbek klienta w katalogu wydania i obrazie (dziś: odciski plików wydania sprawdzane
  tylko przy ponownym użyciu katalogu);
- trwałej blokady skutków ubocznych na czas odbioru (pollery, czuwacze);
- ekranu „Aktualizacje” w panelu;
- pracy bez internetu (build pobiera obraz Node i pakiety npm).
