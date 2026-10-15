# Aktualizacje i własne zmiany

Konfiguracja i dane (`/opt/oms/config`, `/opt/oms/data`, `/opt/oms/backups`) leżą poza katalogiem programu,
więc wymiana kodu ich nie dotyka. Migracje bazy są wyłącznie addytywne — nowe wydanie dokłada tabele i kolumny,
nie usuwa istniejących.

## Własne zmiany a nowe wydania

Repozytorium jest otwarte, więc to Ty decydujesz, co w nim zmieniasz. Układ pracy, który ogranicza konflikty:

1. Pracuj we **własnej kopii (fork) i własnej gałęzi**; wydanie nadrzędne dołączaj przez `git fetch` i `git merge`.
2. Zmiany trzymaj małe i w obrębie jednego modułu (`src/moduly/<nazwa>/`); nie przenoś plików „przy okazji”.
3. Przy konflikcie nie wybieraj „swojej” ani „cudzej” wersji na ślepo: przeczytaj komentarz nad kodem — zapisuje
   powód reguły — i uruchom testy modułu po scaleniu.
4. Po scaleniu: `npm run sprawdz`, a przed wdrożeniem kopia bazy i próba na kopii (patrz niżej).

## Aktualizacja instalacji w Dockerze (V0)

Dla instalacji według `docs/instalacja-docker.md` służy `deploy/klient/aktualizuj.sh`
(`status`, `deploy`, `accept`, `recover`), uruchamiany na serwerze. Jedno polecenie wykonuje:
kontrolę paczki i miejsca na dysku, trwałą blokadę jednej operacji, zatrzymanie OMS, kopię operacji (baza,
konfiguracja, etykiety, proformy), start nowego wydania z kontrolą wersji oraz decyzję operatora po odbiorze.
Instrukcja krok po kroku: [aktualizacja-klienta-v0.md](aktualizacja-klienta-v0.md).

Czego V0 **nie** robi:

- nie weryfikuje podpisu autora wydania — paczka jest zabezpieczona tylko sumą SHA-256, która wykrywa zmianę
  pliku, ale nie potwierdza, kto go zbudował; paczkę buduj sam z zaufanego klona (`scripts/paczka-klienta.mjs`);
- nie rozpoznaje Twoich zmian w kodzie względem wydania nadrzędnego (robi to `git merge`);
- nie wyłącza integracji na czas odbioru — nowe wydanie startuje z działającymi kanałami i kurierami;
- nie ma ekranu w panelu.

Sam powrót do starego programu nie musi działać z bazą zmienioną przez nowe wydanie. Odtworzenie bazy z kopii
usuwa operacje wykonane po tej kopii; dlatego okno aktualizacji obejmuje cały czas wdrożenia i odbioru. Nie ponawiaj
automatycznie nadania paczki ani wystawienia faktury po przerwanej operacji — sprawdź stan w panelu i u kuriera.

Kopia poza dyskiem (pendrive, dysk USB) i alarm starej kopii w `/health` są opisane w `docs/instalacja-docker.md`.
