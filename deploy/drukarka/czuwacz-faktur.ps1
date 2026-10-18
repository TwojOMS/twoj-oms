# Czuwacz FAKTUR - drukuje faktury z panelu OMS na zwyklej drukarce podpietej do tego komputera.
#
# ASCII ONLY. Polskie znaki w tym pliku psuja parsowanie, gdy Windows odczyta go w innym
# kodowaniu niz zapisany - a skrypt startuje bez czlowieka, wiec bledu parsowania nikt by
# nie zobaczyl. (Ta sama zasada, co w czuwacz-etykiet.ps1.)
#
# DLACZEGO OSOBNY SKRYPT, A NIE ROZBUDOWA CZUWACZA ETYKIET.
# Czuwacz etykiet drukuje na drukarce etykiet w trybie RAW (bajty ZPL prosto do drukarki,
# z pominieciem sterownika). Faktura wymaga DOKLADNIE ODWROTNEJ drogi: PDF przez STEROWNIK
# Windows. Wmieszanie obu w jedna petle znaczyloby, ze blad w nowej czesci moze zatrzymac
# druk etykiet - czyli zatrzymac pakowanie. Osobny skrypt i osobny adres API
# (/kolejka-druku-faktur) sprawiaja, ze czuwacz etykiet nie ma jak zobaczyc faktury,
# a ten - etykiety.
#
# DLACZEGO W OGOLE KOMPUTER, A NIE PANEL WPROST DO DRUKARKI. Czesc drukarek (typu
# "host-based") nie przyjmuje PDF-a na porcie sieciowym: cala prace renderowania robi
# sterownik na komputerze. Panel stoi na serwerze z Linuksem i takiego sterownika nie ma.
#
# CO ROBI: odpytuje panel o faktury czekajace w kolejce, pobiera PDF, drukuje przez program
# ustawiony w konfiguracji i potwierdza wydruk.

param(
  [string]$Config = "$PSScriptRoot\config-faktury.json",
  # Druk PROBNY: wydrukuj wskazany PDF i skoncz, bez dotykania kolejki. Do sprawdzenia
  # ustawien na nowym stanowisku - zwlaszcza tego, czy czytnik PDF-ow w ogole oddaje
  # zadanie do bufora. NIE odpytuje panelu, wiec nie zajmuje niczyjej faktury.
  [string]$TestujWydruk
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Config)) { throw "Brak pliku konfiguracji: $Config" }
$k = Get-Content $Config -Raw | ConvertFrom-Json

foreach ($wymagane in @('url', 'user', 'pass', 'drukarka', 'pdfProgram')) {
  if (-not $k.$wymagane) { throw "Konfiguracja bez pola '$wymagane' - patrz config-faktury.przyklad.json" }
}

$plikLogu = Join-Path $PSScriptRoot 'czuwacz-faktur.log'
function Zapisz($poziom, $tresc) {
  $linia = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $poziom, $tresc
  Write-Output $linia
  try {
    # Log rotowany po rozmiarze: skrypt chodzi miesiacami bez nadzoru, a pelny dysk
    # na komputerze przy drukarce zatrzymalby go po cichu.
    if ((Test-Path $plikLogu) -and ((Get-Item $plikLogu).Length -gt 2MB)) {
      Move-Item $plikLogu "$plikLogu.1" -Force
    }
    Add-Content -Path $plikLogu -Value $linia -Encoding utf8
  } catch { }
}

$naglowki = @{
  Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($k.user + ':' + $k.pass))
  # Panel ma ochrone przed CSRF: zadania zmieniajace stan musza podac zrodlo.
  Origin        = $k.url
}
$odstep = 10
if ($k.odstepSekund) { $odstep = [int]$k.odstepSekund }

# STANOWISKO = NAZWA TEGO KOMPUTERA. Czuwacz WOLNO uruchomic na kilku komputerach naraz
# (np. stacjonarny i laptop, oba ze sterownikiem tej samej drukarki WiFi). Panel zajmuje
# wtedy zadanie dla stanowiska, ktore pierwsze o nie poprosilo, a pozostale go NIE WIDZA -
# bez tego kazda faktura wyjechalaby tyle razy, ile czuwaczy akurat dziala.
#
# Domyslnie nazwa komputera, wiec dwa stanowiska NIGDY nie maja tej samej nazwy przez
# przeoczenie w konfiguracji.
$stanowisko = $env:COMPUTERNAME
if ($k.stanowisko) { $stanowisko = [string]$k.stanowisko }

# SPRAWDZENIE PRZY STARCIE, NIE PRZY PIERWSZEJ FAKTURZE. Zla nazwa drukarki albo brak
# programu do PDF-ow to blad KONFIGURACJI - ma wyjsc od razu w logu, a nie dopiero wtedy,
# gdy ktos czeka na wydruk.
if (-not (Test-Path $k.pdfProgram)) { throw "Nie znaleziono programu do druku PDF: $($k.pdfProgram)" }
$drukarki = (Get-Printer | Select-Object -ExpandProperty Name)
if ($drukarki -notcontains $k.drukarka) {
  Zapisz 'UWAGA' ("Drukarka '{0}' nie jest widoczna na tym komputerze. Dostepne: {1}" -f $k.drukarka, ($drukarki -join ', '))
}

Zapisz 'INFO' ("Start. Panel {0}, stanowisko '{1}', drukarka '{2}', program '{3}', odpytywanie co {4} s." -f $k.url, $stanowisko, $k.drukarka, $k.pdfProgram, $odstep)

# --- Druk jednego PDF-u --------------------------------------------------------------
#
# ARGUMENTY IDA Z KONFIGURACJI, bo kazdy czytnik PDF ma inne. Przyklad dla Acrobata:
#   /t <plik> <drukarka>   - drukuje i zamyka sie sam.
# SumatraPDF (lzejsza alternatywa, jesli Acrobat zostawia okno):
#   -print-to <drukarka> -silent -exit-when-done <plik>
# Wzorce {plik} i {drukarka} podmieniamy tutaj - dzieki temu zmiana czytnika to zmiana
# JEDNEJ linii w konfiguracji, bez ruszania skryptu.
#
# SUKCES POZNAJEMY PO BUFORZE WYDRUKU, A NIE PO TYM, ZE CZYTNIK SIE ZAMKNAL.
# Acrobat potrafi wydrukowac kartke, ale nie zamknac sie w limicie - wersja, ktora uznawala
# to za awarie, wydrukowala te sama fakture kilka razy. Do tego kod wyjscia czytnika NIE
# mowi nic o tym, czy cokolwiek sie wydrukowalo: `/t` wszedzie oddaje robote instancji,
# ktora akurat dziala.
#
# Prawda o wydruku jest w BUFORZE SYSTEMU: zadanie ma sie w nim POJAWIC, a potem ZNIKNAC
# (= spooler oddal je drukarce). Tego zawieszone okno czytnika nie umie udawac. To zarazem
# dokladnie to, co obiecuje kontrakt kolejki: potwierdzamy po ODDANIU DO BUFORA.
#
# Powtorzony wydruk jest w tej kolejce DOZWOLONY z zalozenia (zaciety papier, blady druk),
# wiec panel NIE MA JAK odroznic "ponowienia po awarii" od "drugiego egzemplarza na zyczenie".
# Cala obrona przed dublem siedzi wiec TUTAJ - w tym, ze udany wydruk musi byc rozpoznany
# jako udany.
function ZadaniaWBuforze {
  try { return @(Get-PrintJob -PrinterName $k.drukarka -ErrorAction Stop) } catch { return @() }
}

function DrukujPdf($sciezkaPliku) {
  $limit = 120
  if ($k.limitSekund) { $limit = [int]$k.limitSekund }

  # Zadania obce (albo nasze z poprzedniej proby), ktore juz sa w buforze - te nas nie licza.
  $przed = @(ZadaniaWBuforze | ForEach-Object { $_.Id })

  $argumenty = @()
  foreach ($a in $k.pdfArgumenty) {
    $argumenty += ($a -replace '\{plik\}', $sciezkaPliku -replace '\{drukarka\}', $k.drukarka)
  }
  $proc = Start-Process -FilePath $k.pdfProgram -ArgumentList $argumenty -PassThru -WindowStyle Hidden

  $zegar = [Diagnostics.Stopwatch]::StartNew()
  $zauwazone = $false
  $zniknelo = $false
  $ostatnieStatusy = ''
  $czytnikSkonczylO = $null

  while ($zegar.Elapsed.TotalSeconds -lt $limit) {
    $teraz = ZadaniaWBuforze
    $nasze = @($teraz | Where-Object { $przed -notcontains $_.Id })
    if ($nasze.Count -gt 0) {
      $zauwazone = $true
      $ostatnieStatusy = ($nasze | ForEach-Object { [string]$_.JobStatus }) -join ', '
    } elseif ($zauwazone) {
      $zniknelo = $true
      break
    }

    if ($proc.HasExited -and -not $zauwazone) {
      # Czytnik zdazyl sie zamknac, a w buforze nic nie przybylo. Dajemy jeszcze chwile
      # (spooler bywa leniwy), ale nie caly limit - inaczej kazda realna awaria czytnika
      # kosztowalaby 2 minuty ciszy.
      if ($null -eq $czytnikSkonczylO) { $czytnikSkonczylO = $zegar.Elapsed.TotalSeconds }
      elseif (($zegar.Elapsed.TotalSeconds - $czytnikSkonczylO) -gt 15) { break }
    }
    Start-Sleep -Milliseconds 500
  }

  # Czytnik ubijamy ZAWSZE, niezaleznie od wyniku: Acrobat po `/t` potrafi zostac otwarty,
  # a kazde kolejne zadanie zostawialoby nastepne okno.
  if (-not $proc.HasExited) { try { $proc.Kill() } catch { } }

  if (-not $zauwazone) {
    throw "nic nie trafilo do bufora drukarki '$($k.drukarka)' w $([int]$zegar.Elapsed.TotalSeconds) s (czytnik: kod $(if ($proc.HasExited) { $proc.ExitCode } else { 'ubity' }))"
  }
  if (-not $zniknelo) {
    # Zadanie utknelo w buforze. Papier/offline to prawdziwa awaria; zwykla kolejka to nie.
    if ($ostatnieStatusy -match 'Error|Offline|Paused|Blocked') {
      throw "zadanie utknelo w buforze ze statusem: $ostatnieStatusy"
    }
    Zapisz 'INFO' ("Zadanie ciagle w buforze po {0} s (status: {1}) - uznaje za oddane drukarce." -f $limit, $ostatnieStatusy)
  }
}

if ($TestujWydruk) {
  if (-not (Test-Path $TestujWydruk)) { throw "Brak pliku do druku probnego: $TestujWydruk" }
  Zapisz 'INFO' ("DRUK PROBNY: {0}" -f $TestujWydruk)
  try {
    DrukujPdf (Resolve-Path $TestujWydruk).Path
    Zapisz 'OK' 'Druk probny: zadanie trafilo do bufora i zostalo oddane drukarce.'
    exit 0
  } catch {
    Zapisz 'BLAD' ("Druk probny: {0}" -f $_.Exception.Message)
    exit 1
  }
}

# --- Petla ---------------------------------------------------------------------------
#
# Petla NIGDY nie konczy sie z powodu bledu. Panel bywa wylaczony, siec potrafi mrugnac,
# a drukarce moze skonczyc sie papier - kazda z tych rzeczy ma dac wpis w logu i kolejna
# probe, a nie ciche zniknieciu uslugi.

$ostatniBlad = ''
while ($true) {
  try {
    # Odpytanie ZAJMUJE zadania dla tego stanowiska - patrz komentarz przy $stanowisko wyzej.
    $adres = "$($k.url)/kolejka-druku-faktur?stanowisko=" + [uri]::EscapeDataString($stanowisko)
    $kolejka = Invoke-RestMethod -Uri $adres -Headers $naglowki -TimeoutSec 20
    $ostatniBlad = ''

    foreach ($poz in $kolejka) {
      $plik = $null
      try {
        # PDF pobierany z panelu (a przez panel - z systemu fakturowania, na swiezo). Panel
        # NIE TRZYMA kopii dokumentu, wiec i my nie trzymamy: plik ladzie w TEMP i ginie
        # w `finally`.
        $plik = Join-Path $env:TEMP ("oms-faktura-{0}.pdf" -f $poz.id)
        Invoke-WebRequest -Uri "$($k.url)/kolejka-druku-faktur/$($poz.id)/pdf" -Headers $naglowki `
          -TimeoutSec 60 -UseBasicParsing -OutFile $plik

        if (-not (Test-Path $plik) -or (Get-Item $plik).Length -eq 0) { throw 'panel oddal pusty plik PDF' }

        DrukujPdf $plik

        # Potwierdzenie DOPIERO po udanym oddaniu zadania do bufora wydruku. Odwrotna
        # kolejnosc gubilaby fakture przy kazdej awarii drukarki - pozycja znikalaby
        # z kolejki, a z drukarki nic by nie wyjechalo.
        Invoke-RestMethod -Uri "$($k.url)/kolejka-druku-faktur/$($poz.id)/wydrukowano" -Method Post `
          -Headers $naglowki -TimeoutSec 20 | Out-Null
        Zapisz 'OK' ("Wydrukowano fakture {0} (zamowienie {1})" -f $poz.numer, $poz.zamowienie)
      } catch {
        $tresc = $_.Exception.Message
        Zapisz 'BLAD' ("Faktura {0}: {1}" -f $poz.numer, $tresc)
        # Panel ma pokazac operatorowi, ze wydruk sie nie udal - inaczej faktura w kolko
        # wraca w kolejce, a nikt nie wie dlaczego.
        try {
          $body = @{ powod = $tresc } | ConvertTo-Json -Compress
          Invoke-RestMethod -Uri "$($k.url)/kolejka-druku-faktur/$($poz.id)/blad" -Method Post `
            -Headers $naglowki -ContentType 'application/json' -Body $body -TimeoutSec 20 | Out-Null
        } catch { }
      } finally {
        if ($plik -and (Test-Path $plik)) { try { Remove-Item $plik -Force } catch { } }
      }
    }
  } catch {
    # Panel niedostepny to stan NORMALNY (restart kontenera, wylaczony komputer). Zeby log
    # nie puchl o ten sam wpis co kilka sekund, powtorzenia sa pomijane.
    $tresc = $_.Exception.Message
    if ($tresc -ne $ostatniBlad) {
      Zapisz 'UWAGA' ("Panel nieosiagalny: {0} (kolejne takie same pomijam)" -f $tresc)
      $ostatniBlad = $tresc
    }
  }
  Start-Sleep -Seconds $odstep
}
