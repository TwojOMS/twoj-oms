# Czuwacz etykiet - program na komputerze, do ktorego podlaczona jest drukarka etykiet (np. Zebra ZD421).
#
# ASCII ONLY. Polskie znaki w tym pliku psuja parsowanie, gdy Windows odczyta go
# w innym kodowaniu niz zapisany - a ten skrypt uruchamia sie bez czlowieka przy okazji
# startu komputera, wiec blad parsowania nikt by nie zobaczyl.
#
# CO ROBI: odpytuje panel OMS o etykiety czekajace w kolejce, drukuje je na drukarce etykiet
# i potwierdza wydruk. Panel stoi na serwerze, drukarka jest podlaczona do tego komputera -
# dlatego to KOMPUTER siega po robote, a nie panel po drukarke.
#
# DLACZEGO PO HTTP, A NIE Z UDZIALU SIECIOWEGO: zadanie startujace z komputerem chodzi
# bez zalogowanego uzytkownika, a takie konto nie ma jak uwierzytelnic sie do udzialu sieciowego.
# Wyszloby mapowanie dysku i zapisane haslo do udzialu, czyli druga rzecz do zepsucia.
# Po HTTP jest jeden sekret i panel od razu wie, co zostalo wydrukowane.

param(
  [string]$Config = "$PSScriptRoot\config.json"
)

$ErrorActionPreference = 'Stop'

# --- Surowy wydruk przez API Windows -----------------------------------------------
#
# Bajty ZPL musza dojsc do drukarki NIETKNIETE. Out-Printer i zwykle drukowanie przepuszcza
# tresc przez sterownik, ktory potraktowalby ZPL jak tekst do zlozenia na stronie -
# z drukarki wyjechalby listing kodu zamiast etykiety. Tryb RAW omija sterownik w calosci.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;

public class SurowyWydruk {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
                          [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
                          [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }

  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.drv", SetLastError = true)]
  static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static void Wyslij(string drukarka, byte[] dane, string nazwaDokumentu) {
    IntPtr h;
    if (!OpenPrinter(drukarka, out h, IntPtr.Zero))
      throw new Exception("Nie znaleziono drukarki \"" + drukarka + "\" (blad " + Marshal.GetLastWin32Error() + ")");
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = nazwaDokumentu;
      di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, ref di)) throw new Exception("StartDocPrinter: " + Marshal.GetLastWin32Error());
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter: " + Marshal.GetLastWin32Error());
        IntPtr bufor = Marshal.AllocCoTaskMem(dane.Length);
        try {
          Marshal.Copy(dane, 0, bufor, dane.Length);
          int zapisane;
          if (!WritePrinter(h, bufor, dane.Length, out zapisane))
            throw new Exception("WritePrinter: " + Marshal.GetLastWin32Error());
          // Czesciowy zapis to etykieta urwana w polowie - lepiej zglosic blad
          // i zostawic pozycje w kolejce, niz wypuscic polowe listu przewozowego.
          if (zapisane != dane.Length)
            throw new Exception("Do drukarki poszlo " + zapisane + " z " + dane.Length + " bajtow");
        } finally { Marshal.FreeCoTaskMem(bufor); }
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@

# --- Konfiguracja i log --------------------------------------------------------------

if (-not (Test-Path $Config)) { throw "Brak pliku konfiguracji: $Config" }
$k = Get-Content $Config -Raw | ConvertFrom-Json

foreach ($wymagane in @('url', 'user', 'pass', 'drukarka')) {
  if (-not $k.$wymagane) { throw "Konfiguracja bez pola '$wymagane' - patrz config.przyklad.json" }
}

$plikLogu = Join-Path $PSScriptRoot 'czuwacz.log'
function Zapisz($poziom, $tresc) {
  $linia = "{0} [{1}] {2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $poziom, $tresc
  Write-Output $linia
  try {
    # Log rotowany po rozmiarze: ten skrypt chodzi miesiacami bez nadzoru, a pelny dysk
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
  # Klient nie-przegladarkowy ustawia je sam, wskazujac na sam panel.
  Origin        = $k.url
}
$odstep = 5
if ($k.odstepSekund) { $odstep = [int]$k.odstepSekund }

Zapisz 'INFO' ("Start. Panel {0}, drukarka '{1}', odpytywanie co {2} s." -f $k.url, $k.drukarka, $odstep)

# --- Petla ---------------------------------------------------------------------------
#
# Petla NIGDY nie konczy sie z powodu bledu. Panel bywa wylaczony, siec potrafi mrugnac,
# a drukarka miec otwarta glowice - kazda z tych rzeczy ma dac wpis w logu i kolejna probe,
# nie ciche zniknieciu uslugi, ktore zauwazylby dopiero brak etykiet.

$ostatniBlad = ''
while ($true) {
  try {
    $kolejka = Invoke-RestMethod -Uri "$($k.url)/kolejka-druku" -Headers $naglowki -TimeoutSec 20
    $ostatniBlad = ''

    foreach ($poz in $kolejka) {
      try {
        $odp = Invoke-WebRequest -Uri "$($k.url)/kolejka-druku/$($poz.id)/zpl" -Headers $naglowki -TimeoutSec 30 -UseBasicParsing
        $dane = $odp.Content
        if ($dane -isnot [byte[]]) { $dane = [Text.Encoding]::UTF8.GetBytes([string]$dane) }
        if ($dane.Length -eq 0) { throw 'panel oddal pusta etykiete' }

        [SurowyWydruk]::Wyslij($k.drukarka, $dane, "Etykieta $($poz.numerListu)")

        # Potwierdzenie DOPIERO po udanym wyslaniu do bufora wydruku. Odwrotna kolejnosc
        # gubilaby etykiete przy kazdej awarii drukarki - pozycja znikalaby z kolejki,
        # a z drukarki nic by nie wyjechalo.
        Invoke-RestMethod -Uri "$($k.url)/kolejka-druku/$($poz.id)/wydrukowano" -Method Post -Headers $naglowki -TimeoutSec 20 | Out-Null
        Zapisz 'OK' ("Wydrukowano list {0} (zamowienie {1})" -f $poz.numerListu, $poz.zamowienie)
      } catch {
        $tresc = $_.Exception.Message
        Zapisz 'BLAD' ("Etykieta {0}: {1}" -f $poz.numerListu, $tresc)
        # Panel ma pokazac operatorowi, ze wydruk sie nie udal - inaczej etykieta
        # w nieskonczonosc wraca w kolejce, a nikt nie wie dlaczego.
        try {
          $body = @{ powod = $tresc } | ConvertTo-Json -Compress
          Invoke-RestMethod -Uri "$($k.url)/kolejka-druku/$($poz.id)/blad" -Method Post -Headers $naglowki `
            -ContentType 'application/json' -Body $body -TimeoutSec 20 | Out-Null
        } catch { }
      }
    }
  } catch {
    # Panel niedostepny to stan NORMALNY (wylaczony serwer, restart kontenera). Zeby log
    # nie puchl o ten sam wpis co 5 sekund, powtorzenia sa pomijane.
    $tresc = $_.Exception.Message
    if ($tresc -ne $ostatniBlad) {
      Zapisz 'UWAGA' ("Panel nieosiagalny: {0} (kolejne takie same pomijam)" -f $tresc)
      $ostatniBlad = $tresc
    }
  }
  Start-Sleep -Seconds $odstep
}
