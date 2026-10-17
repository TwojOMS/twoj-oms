# Demo z danymi przykładowymi

`start.mjs` stawia panel z danymi z generatora (`scripts/demo-dane.mjs`) i integracjami na atrapach
(`deploy/proba/atrapy`) — bez kluczy i bez połączeń z zewnętrznymi usługami. Co `DEMO_RESET_CO_MIN` minut
(domyślnie 60) dane wracają do stanu początkowego.

Pierwsze uruchomienie z instrukcji (`docs/instalacja-klienta.md`) idzie przez `scripts/instalacja-demo.mjs` —
tego katalogu do niego nie potrzebujesz. `start.mjs` służy do demo pokazywanego innym, z resetem.

## Uruchomienie na własnym komputerze

```bash
OMS_TRYB=proba \
OMS_DB_PATH=/sciezka/do/demo/oms.sqlite \
OMS_PROFORMY_KATALOG=/sciezka/do/demo/proformy \
OMS_ETYKIETY_KATALOG=/sciezka/do/demo/etykiety \
OMS_DEMO_LOGIN=demo OMS_DEMO_HASLO=demo \
OMS_USER=serwis OMS_PASS=<losowe-haslo> \
OMS_PORT=3001 \
DEMO_KONTO_ADMINA=/sciezka/do/konto.json \
node deploy/demo/start.mjs
```

`konto.json` to konto administratora demo: `{"login": "...", "imie": "...", "haslo": "..."}`
(zamiast `haslo` może być `hash` z `src/domena/hasla.js`). Gość loguje się danymi z `OMS_DEMO_LOGIN`
i `OMS_DEMO_HASLO` — ekran logowania je pokazuje, więc nie są sekretem.

## Demo publiczne

Izolację sieci zapewniasz sam: kontener demo w osobnej sieci, bez wyjścia do sieci lokalnej i internetu
(sama opcja `internal` Dockera bywa za mało — sprawdź regułami zapory). W `DEMO_SONDA_CELE` wpisz po przecinku
adresy, które z demo mają być nieosiągalne (panel produkcyjny, router, panel serwera). `sonda.mjs` sprawdza je
przed startem i przed każdym resetem; jeśli którykolwiek odpowie, demo nie wstaje. Bez `DEMO_SONDA_CELE`
sprawdzenie jest pomijane z ostrzeżeniem.
