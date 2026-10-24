# Instalacja Twój OMS przez agenta AI

Scenariusz dla agenta (Claude Code, Codex lub innego), który ma postawić OMS dla człowieka. Człowiek
zwykle nie jest programistą: mów krótko, po ludzku, bez żargonu, a decyzje techniczne podejmuj sam.
Ważne decyzje i wszystko, co ma skutki poza komputerem, zostaw człowiekowi (lista w sekcji „Stop”).

Najpierw przeczytaj [AGENTS.md](../AGENTS.md), zwłaszcza sekcję „Granice”.

## 0. Zapytaj, zanim zaczniesz (jedna wiadomość, trzy pytania)

1. **Gdzie ma działać panel?** Własny serwer lub mały komputer z Linuksem (zalecane), VPS, czy tylko ten komputer na próbę.
2. **Czy chcesz najpierw obejrzeć panel na przykładowych danych, czy od razu podłączać sklepy?**
   Domyślnie zaczynasz od próby bez kluczy (ścieżka A) — niczego nie psuje i trwa kilka minut.
3. **Co chcesz podłączyć** (Allegro, WooCommerce, inFakt, DPD, InPost…)? To tylko do zapamiętania;
   integracje dodajesz dopiero po ścieżce A i B, pojedynczo.

Wybór ścieżki: panel ma działać na serwerze z Linuksem, do którego masz SSH (albo człowiek wkleja polecenia) →
od razu **ścieżka B**; jej sekcja 5 sama zakłada próbę z danymi DEMO, więc ścieżki A wtedy nie robisz.
Ścieżka A jest dla próby na komputerze, przy którym człowiek siedzi.

## Ścieżka A — próba lokalna (bez Dockera, bez kluczy)

Wymaga Node.js 24+ na tym komputerze.

```bash
node --version                      # musi być v24 lub nowszy; jeśli nie, zainstaluj Node 24 LTS i powiedz człowiekowi
npm ci
node scripts/instalacja-demo.mjs --katalog "$PWD/oms-demo" --port 39151
node scripts/instalacja-otworz.mjs --katalog "$PWD/oms-demo" --port 39151
```

- `--katalog` musi być ścieżką bezwzględną — przy względnej skrypt kończy się samym `INSTALACJA_DEMO_ODMOWA`.
  Pakiet `nodejs` z Debiana 13 i Ubuntu 24.04 to wersja 20 — Node 24 bierz z nodejs.org.
- Ostatnie polecenie uruchamia panel na `127.0.0.1:39151` i działa, dopóki go nie przerwiesz (Ctrl+C) —
  uruchom je w tle albo w osobnym terminalu.
- Login i hasło administratora są w `./oms-demo/administrator-proby.env`. **Nie wypisuj hasła w odpowiedzi
  na czacie**; powiedz człowiekowi, w którym pliku jest, i że ma zapisać je w menedżerze haseł.
- Zweryfikuj: `GET http://127.0.0.1:39151/health` odpowiada, `/login` się ładuje, po zalogowaniu widać zamówienia
  DEMO-001…003. Logując się curlem, dodaj nagłówek `-H "Origin: http://ADRES:PORT"` (ten sam adres co w URL) —
  bez `Origin`/`Referer` ochrona CSRF odpowiada 403 i wygląda to jak awaria. Alarmy kanałów w `/health` bez kluczy integracji są w tej próbie normalne.
- Katalog i port muszą być puste/wolne. Przy odmowie (`INSTALACJA_ODMOWA_NADPISANIA`) wybierz nowy katalog —
  nie kasuj cudzego.

Szczegóły i ograniczenia: [instalacja-klienta.md](instalacja-klienta.md).

## Ścieżka B — serwer z Linuksem i Dockerem

Przeprowadź człowieka przez [instalacja-docker.md](instalacja-docker.md) w kolejności sekcji 1–7. Co z tego robisz
sam, jeśli masz dostęp do serwera (SSH):

1. Sprawdź system i uprawnienia: Debian/Ubuntu, `sudo`, wolne miejsce (min. 16 GB dysku, 2 GB RAM). Działający OMS
   zajmuje ok. 140 MB pamięci; przy kilkudziesięciu tysiącach zamówień w bazie po starcie nawet ok. 1 GB, wtedy lepiej 4 GB.
2. Zainstaluj Dockera z oficjalnego repozytorium (sekcja 1).
3. Zbuduj paczkę z klona repo (początek instrukcji) i rozpakuj ją według sekcji 3.
4. `docker compose build`, `docker compose run --rm instalacja`, `docker compose up -d` (sekcje 4–6).
5. Zweryfikuj `docker compose ps` (stan `healthy`) i `/health`. Dostęp z innego komputera: sekcja 7.

Jeśli nie masz dostępu do serwera, nie zgaduj — wypisz człowiekowi gotowe polecenia (bash) do wklejenia
po kolei i poproś o wynik każdego bloku.

## Stop — zatrzymaj się i zapytaj człowieka

Zanim to zrobisz, wyjaśnij w jednym zdaniu, co się stanie, i poczekaj na wyraźne „tak”:

- przejście z próby na **pracę** (sekcja 8 w `instalacja-docker.md`) — od tej chwili system zakłada prawdziwe dane firmy;
- `aktualizuj.sh accept` (nieodwracalny — człowiek sam loguje się nowym kontem i potwierdza dane firmy)
  oraz `recover … --porzuc-prace`;
- wpisanie **prawdziwych danych firmy** (NIP, numer rachunku, BDO) i **kluczy integracji** — klucze podaje człowiek,
  zapisujesz je wyłącznie w pliku konfiguracji na serwerze (`/opt/oms/config/oms.env`, katalog 0700, plik 0600), nigdy w repo.
  Dla DPD, InPost, inFakta i poczty jest druga droga: człowiek sam wpisuje dane w panelu (Ustawienia → Integracje; instrukcje
  `docs/kurier-dpd.md`, `docs/kurier-inpost.md`, `docs/poczta-smtp.md`) — wtedy ty prowadzisz go po ekranie, ale nie widzisz
  ani nie przepisujesz haseł i tokenów;
- jakiekolwiek wystawienie faktury, nadanie paczki, wysyłka do KSeF, wiadomość do klienta;
- udostępnienie panelu poza siecią lokalną (router, VPN, HTTPS);
- usunięcie czegokolwiek z `/opt/oms/data`, `/opt/oms/backups`.

## Po instalacji

1. Podsumuj człowiekowi: adres panelu, gdzie leży hasło, czym zrobić kopię (`docs/instalacja-docker.md`, „Codzienna obsługa”),
   jak zatrzymać i uruchomić panel, co jeszcze nie jest podłączone.
2. Zaproponuj **następny jeden krok**: pierwsza integracja w kolejności z sekcji 9 `instalacja-docker.md`
   (inFakt → sklep WooCommerce → Allegro → kurierzy). Po każdej integracji test z prawdziwym, ale niskoryzykownym zamówieniem.
   Poczta wychodząca (zaproszenia do kont, linki do hasła) jest osobnym, niezależnym krokiem: `docs/poczta-smtp.md`.
3. Zapisz człowiekowi (w jego notatkach, nie w repo) wersję wydania i datę instalacji: na serwerze z Dockerem to wiersz
   `biezace:` z `sudo sh /opt/oms/aktualizuj.sh status`, w próbie lokalnej `git rev-parse --short HEAD`.

## Gdy coś nie działa

- Błędy `INSTALACJA_…` — komunikat mówi, co zrobić; nie ponawiaj w katalogu z częściowymi danymi.
- Kontener nie jest `healthy` — `sudo docker compose logs --tail=100 oms`, `deploy/klient/diagnostyka.sh`.
- Port zajęty — wybierz inny, zapisz który.
- Wynik, którego nie rozumiesz: nie ukrywaj go. Pokaż człowiekowi dokładny komunikat i powiedz, czego nie wiesz.
