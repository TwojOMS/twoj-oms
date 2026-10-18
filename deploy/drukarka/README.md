# Agent druku: etykiety i faktury z OMS-u na drukarce w biurze

Panel OMS stoi na serwerze, a drukarka etykiet (np. Zebra ZD421) jest zwykle podłączona do
zwykłego komputera z Windowsem. Panel nie sięga do drukarki sam. Zamiast tego na komputerze
przy drukarce działa mały program (skrypt PowerShell), który co kilka sekund pyta panel, czy
czeka jakaś etykieta, pobiera ją, drukuje i mówi panelowi, że gotowe. Kolejkę prowadzi panel,
więc gdy komputer jest wyłączony, etykiety czekają i wydrukują się po jego włączeniu.

Są dwa niezależne programy:

| Skrypt | Co drukuje | Jak |
|---|---|---|
| `czuwacz-etykiet.ps1` | etykiety przesyłek w ZPL (drukarka etykiet) | prosto do drukarki, bez sterownika |
| `czuwacz-faktur.ps1` | faktury w PDF (zwykła drukarka biurowa) | przez czytnik PDF i sterownik Windows |

Etykiety w ZPL panel dostaje od DPD, gdy w **Ustawienia → Integracje → Kurierzy → DPD Polska**
wybrany jest typ etykiety „Drukarka etykiet 10×15 cm” (patrz `docs/kurier-dpd.md`).
Faktury wymagają podłączonego inFaktu. Jeśli drukujesz tylko etykiety, drugi skrypt pomiń.

## Czego potrzebujesz

- komputer z Windowsem i PowerShellem 5.1 (jest w Windows 10 i 11), włączony w godzinach pracy,
  w tej samej sieci co serwer z OMS-em;
- drukarka zainstalowana w Windows, tak żeby widać ją było w **Ustawienia → Drukarki i skanery**
  (dla etykiet: sterownik producenta drukarki, np. Zebra);
- adres panelu, np. `http://192.168.1.20:3001` (ten sam, który wpisujesz w przeglądarce);
- login i hasło **konta serwisowego** (patrz niżej);
- dla faktur dodatkowo czytnik PDF z drukowaniem z linii poleceń: Adobe Acrobat albo SumatraPDF.

## Konto w panelu

Agent loguje się tym samym loginem i hasłem, które są w pliku konfiguracji serwera
(`/opt/oms/config/oms.env`, zmienne `OMS_USER` i `OMS_PASS`; w instalacji z `docs/instalacja-docker.md`
login to `serwis`). To nie jest konto imienne z listy kont w panelu — konta imienne nie logują się
agentowi. Nie musisz nadawać mu żadnych uprawnień: po założeniu pierwszego administratora konto
serwisowe traci dostęp do ekranów panelu, ale zachowuje dostęp do kolejek druku, i tylko do nich
(oraz do integracji z panelem zamówień indywidualnych).

Dane wyświetl na serwerze poleceniem `sudo cat /opt/oms/config/oms.env` i przepisz tylko login oraz
hasło. Nie wysyłaj tego pliku mailem ani komunikatorem.

## Instalacja etykiet, krok po kroku

1. Skopiuj cały katalog `deploy/drukarka` na komputer przy drukarce, np. do `C:/OMS-druk`.
2. W tym katalogu skopiuj `config.przyklad.json` jako `config.json`:

```powershell
Copy-Item C:/OMS-druk/config.przyklad.json C:/OMS-druk/config.json
```

3. Sprawdź nazwę drukarki. Musi się zgadzać co do znaku z tym, co pokazuje Windows:

```powershell
Get-Printer | Select-Object Name
```

4. Otwórz `config.json` w Notatniku i uzupełnij:

| Pole | Co wpisać |
|---|---|
| `url` | adres panelu bez ukośnika na końcu, np. `http://192.168.1.20:3001` |
| `user` | login konta serwisowego |
| `pass` | hasło konta serwisowego |
| `drukarka` | nazwa drukarki z kroku 3, np. `Zebra ZD421` |
| `odstepSekund` | co ile sekund pytać panel (domyślnie 5) |

   `config.json` zawiera hasło — nie kopiuj go na pendrive'y ani do repozytorium.

5. Uruchom skrypt ręcznie i zobacz, czy wstaje:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:/OMS-druk/czuwacz-etykiet.ps1
```

   Pierwsza linia ma być w rodzaju `[INFO] Start. Panel http://…, drukarka 'Zebra ZD421'…`.
   Skrypt działa w pętli — zatrzymasz go skrótem Ctrl+C.

## Instalacja faktur, krok po kroku

1. Katalog skopiuj tak samo (może to być ten sam komputer i ten sam katalog albo inny komputer
   ze sterownikiem drukarki biurowej).
2. Skopiuj `config-faktury.przyklad.json` jako `config-faktury.json` i uzupełnij `url`, `user`,
   `pass`, `drukarka` oraz `pdfProgram` (pełna ścieżka do Acrobata albo SumatraPDF). Dla
   SumatraPDF podmień też `pdfArgumenty` na wariant opisany w pliku przykładowym.
3. Zrób druk próbny jakimkolwiek plikiem PDF. Nie dotyka kolejki, więc nikomu nie zabierze faktury:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:/OMS-druk/czuwacz-faktur.ps1 -TestujWydruk C:/OMS-druk/probny.pdf
```

   Ma się skończyć wpisem `[OK] Druk probny`. Jeśli widzisz `nic nie trafilo do bufora`, to zła
   nazwa drukarki albo ścieżka do czytnika PDF — popraw konfigurację, zanim uruchomisz kolejkę.
4. Uruchom właściwego czuwacza:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:/OMS-druk/czuwacz-faktur.ps1
```

   Faktury możesz drukować na kilku komputerach naraz: każdą weźmie ten komputer, który zapyta
   pierwszy. Nazwą stanowiska jest nazwa komputera.

## Uruchamianie przy starcie Windows

Skrypty ręczne wystarczą do próby. Na stałe zarejestruj je w Harmonogramie zadań. Uruchom
**PowerShell jako administrator** i wklej (zmień ścieżkę, jeśli katalog jest gdzie indziej).

Etykiety, startują razem z komputerem, bez zalogowanego użytkownika:

```powershell
$akcja = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:/OMS-druk/czuwacz-etykiet.ps1"'
$wyzwalacz = New-ScheduledTaskTrigger -AtStartup
$konto = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -RunLevel Highest
$ustawienia = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -DontStopOnIdleEnd
Register-ScheduledTask -TaskName 'OMS druk etykiet' -Action $akcja -Trigger $wyzwalacz -Principal $konto -Settings $ustawienia
Start-ScheduledTask -TaskName 'OMS druk etykiet'
```

Faktury startują po zalogowaniu użytkownika, bo czytniki PDF potrzebują normalnej sesji
(w sesji systemowej Acrobat potrafi czekać na okno, którego nikt nie zobaczy). Zadanie
rejestruje się z kontem zalogowanego użytkownika, bez dodatkowych parametrów konta:

```powershell
$akcja = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:/OMS-druk/czuwacz-faktur.ps1"'
$wyzwalacz = New-ScheduledTaskTrigger -AtLogOn
$ustawienia = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -DontStopOnIdleEnd
Register-ScheduledTask -TaskName 'OMS druk faktur' -Action $akcja -Trigger $wyzwalacz -Settings $ustawienia
```

Limit czasu zadania musi być zerowy (`-ExecutionTimeLimit ([TimeSpan]::Zero)`), bo domyślnie
Harmonogram zabija zadanie po trzech dniach i druk milknie bez ostrzeżenia. Zmiana nazwy lub
przeniesienie katalogu psuje zarejestrowane zadanie, które wskazuje pełną ścieżkę do skryptu —
wyrejestruj je (`Unregister-ScheduledTask -TaskName 'OMS druk etykiet' -Confirm:$false`)
i zarejestruj od nowa.

## Jak sprawdzić, że działa

W panelu nie ma osobnego ekranu kolejki druku. Stan widać na karcie zamówienia (lista zamówień →
klik w zamówienie):

- przy każdej paczce przycisk **Drukuj** wstawia etykietę do kolejki;
- obok numeru listu pojawia się „czeka na wydruk”, a po chwili „wydrukowano” z godziną;
- gdy wydruk się nie udaje, karta pokazuje liczbę nieudanych prób i powód, a przy fakturze
  analogiczny komunikat w sekcji faktury. Sprawę zdejmiesz przyciskiem porzucenia wydruku.

Po stronie komputera patrz do dziennika (ostatnie 20 linii):

```powershell
Get-Content C:/OMS-druk/czuwacz.log -Tail 20
Get-Content C:/OMS-druk/czuwacz-faktur.log -Tail 20
```

`[OK] Wydrukowano list …` znaczy, że etykieta poszła do drukarki i panel o tym wie.

## Najczęstsze problemy

| Objaw | Przyczyna i rada |
|---|---|
| `Brak pliku konfiguracji` | w katalogu skryptu nie ma `config.json` (albo `config-faktury.json`) — skopiuj plik przykładowy |
| `Panel nieosiagalny` w dzienniku | serwer wyłączony, zły `url` albo zapora. Otwórz adres z `url` w przeglądarce na tym komputerze. Przy restarcie serwera to stan normalny, skrypt próbuje dalej |
| w dzienniku ciągle `401` lub `403` | zły login lub hasło w konfiguracji albo użyty login konta imiennego zamiast serwisowego |
| `Nie znaleziono drukarki` | nazwa w `drukarka` różni się od nazwy w Windows choćby jednym znakiem — porównaj z `Get-Printer` |
| z drukarki wychodzi tekst z `^XA…` | drukarka dostała ZPL jako zwykły tekst; sprawdź, że drukujesz skryptem etykiet, a nie wysyłasz pliku ZPL zwykłym drukowaniem |
| przy paczce nie ma przycisku **Drukuj** | panel nie ma pliku ZPL tej przesyłki — w ustawieniach DPD wybierz typ „Drukarka etykiet 10×15 cm” (etykiety nadane wcześniej, na kartce A4, zostają bez ZPL) |
| etykieta „czeka na wydruk”, a log milczy | skrypt nie działa — sprawdź zadanie w Harmonogramie zadań (`Get-ScheduledTask -TaskName 'OMS druk*'`) |
| `nic nie trafilo do bufora` (faktury) | zła nazwa drukarki, zła ścieżka do czytnika PDF albo czytnik wymaga okna — zrób druk próbny |
| ta sama faktura wychodzi dwa razy | komputer zdążył wydrukować, ale nie zdążył potwierdzić (np. uśpiony). Panel zwalnia zajęte zadanie po kilku minutach; unikaj usypiania komputera przy drukarce |

Odpytanie adresu `/kolejka-druku-faktur` w przeglądarce **zajmuje** czekające faktury dla tego
„stanowiska” na kilka minut, więc nie otwieraj go dla podglądu. Adres `/kolejka-druku` jest
bezpieczny do oglądania.
