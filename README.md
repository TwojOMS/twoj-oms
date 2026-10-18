<p>
  <a href="https://twojoms.pl">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-ciemne.svg">
      <img src="docs/assets/logo.svg" alt="Twój OMS" height="56">
    </picture>
  </a>
</p>

**[Strona projektu](https://twojoms.pl)** · **[Demo](https://demo.twojoms.pl)** (login `demo`, hasło `demo`, dane zmyślone,
reset co godzinę) · **[Instalacja](docs/instalacja-docker.md)** · **[Dla agenta AI](AGENTS.md)**

Panel do obsługi zamówień dla małej sprzedaży internetowej w Polsce: zamówienia z Allegro i WooCommerce
w jednym miejscu, faktury, wysyłka, zwroty, koszty i raporty. Działa na jednym małym serwerze
(Node.js + SQLite), bez abonamentu i bez zewnętrznej bazy danych. Kod jest otwarty — możesz go
uruchomić, zmienić pod swoją firmę i rozwijać dalej samodzielnie lub z agentem AI.

> **English in short.** Twój OMS is a self-hosted order management panel for small Polish online
> sellers (Allegro, WooCommerce, inFakt/KSeF invoicing, DPD/InPost shipping). Node.js 24, SQLite,
> Fastify, server-rendered EJS. The UI, code comments and documentation are in Polish. MIT licence,
> no warranty, no support. Start with [AGENTS.md](AGENTS.md) if you drive the repo with an AI agent.

## Co potrafi

Moduły (`src/moduly/`), każdy z własnymi trasami, widokami, migracjami bazy i uprawnieniami:

| Moduł | Zakres |
|---|---|
| `zamowienia` | lista i karta zamówienia, wyszukiwanie, filtry, wydruki, ręczne zamówienia |
| `kanaly` | kanały sprzedaży (Allegro, WooCommerce), pobieranie zamówień, mapowanie |
| `faktury` | faktury i proformy (PDF), inFakt, KSeF, sprzedaż do UE (WDT), paczka dla biura |
| `wysylka` | nadawanie paczek (DPD, InPost, Allegro), etykiety, śledzenie, nadanie hurtem |
| `magazyn` | produkty, wzory, powiązania ze sklepami |
| `zwroty` | zwroty i korekty |
| `koszty` | koszty z KSeF i ręczne, zestawienia |
| `raporty`, `marketing` | raporty sprzedaży i finansów, cele, kampanie (Meta, GA4) |
| `wiadomosci` | wiadomości do klientów, poczta |
| `ustawienia` | konta z rolami i uprawnieniami per zakładka, integracje |
| `zdrowie` | `/health`, kopie zapasowe, alarmy |

Integracje w kodzie: Allegro, WooCommerce, inFakt, KSeF, DPD, InPost, GUS (REGON), Meta, GA4,
import z Apilo. Każda jest opcjonalna i wymaga własnych kluczy — bez nich panel działa w **trybie
próby** (`OMS_TRYB=proba`), który odmawia startu, gdy wykryje jakikolwiek klucz integracji.

## Szybki start (próba bez kluczy)

Wymagane są Git i Node.js 24 lub nowszy (`node --version`). Node 24 LTS pobierzesz z
[nodejs.org](https://nodejs.org/) — pakiet `nodejs` z Debiana 13 i Ubuntu 24.04 jest za stary (20.x).
Polecenia działają tak samo w bashu i w PowerShellu:

```bash
git clone https://github.com/TwojOMS/twoj-oms.git twoj-oms
cd twoj-oms
npm ci
node scripts/instalacja-demo.mjs --katalog "$PWD/oms-demo" --port 39151
node scripts/instalacja-otworz.mjs --katalog "$PWD/oms-demo" --port 39151
```

Katalog musi być podany ścieżką bezwzględną (stąd `$PWD`). Ostatnia komenda uruchamia panel pod
`http://127.0.0.1:39151/login` i działa, dopóki jej nie przerwiesz (Ctrl+C); login i hasło administratora
leżą w `oms-demo/administrator-proby.env`. Zobaczysz trzy zmyślone zamówienia. Szczegóły
i ograniczenia: [docs/instalacja-klienta.md](docs/instalacja-klienta.md).

## Instalacja na serwerze

Linux + Docker, od czystego Debiana do panelu dostępnego w sieci lokalnej:
[docs/instalacja-docker.md](docs/instalacja-docker.md). Konfiguracja (wszystkie zmienne środowiska):
[docs/konfiguracja.md](docs/konfiguracja.md). Kurierów i pocztę można wpisać w panelu (Ustawienia →
Integracje), bez edycji pliku — krok po kroku: [DPD](docs/kurier-dpd.md), [InPost](docs/kurier-inpost.md),
[poczta wychodząca](docs/poczta-smtp.md).

**Jeśli instaluje agent AI:** [docs/instalacja-przez-agenta.md](docs/instalacja-przez-agenta.md) —
scenariusz krok po kroku z miejscami, w których agent musi się zatrzymać i zapytać człowieka.

## Rozwój i testy

```bash
npm run sprawdz     # typy + strażnik migracji + strażnik konfiguracji + wszystkie testy
npm run typy        # tylko kontrola typów
npx vitest run tests/moduly/zwroty   # testy jednego modułu
```

Testy PDF wymagają programu `pdftotext` (pakiet Poppler) w `PATH`. Pełna bramka trwa kilkadziesiąt
minut; w trakcie pracy uruchamiaj testy dotkniętego modułu. Zasady zmian i mapa kodu dla agenta:
[AGENTS.md](AGENTS.md), [docs/dla-agenta/](docs/dla-agenta/).

## Czego się spodziewać

- Powstał dla jednej polskiej firmy handlowej i tam pracuje. Reguły (VAT, KSeF, WDT, polskie kurierzy
  i bank) są polskie; interfejs i komentarze w kodzie są po polsku.
- Kod ma ponad 80 tys. linii i kilka tysięcy testów. Część komentarzy odwołuje się do numerów zadań
  (`PRZ-nnn`) z wewnętrznej tablicy — nie ma jej w tym repozytorium, a sam komentarz opisuje powód.
- **Brak gwarancji i brak wsparcia** (licencja MIT). Wystawianie faktur, nadawanie paczek i wysyłka do
  KSeF to operacje z konsekwencjami — pierwsze uruchomienie z prawdziwymi kluczami zrób na koncie
  testowym i sprawdź każdą integrację osobno.
- Aktualizacje: trzymaj własne zmiany w osobnej gałęzi i dołączaj nowe wydania przez `git merge`
  albo `git rebase`; migracje bazy są wyłącznie addytywne. Opis: [docs/aktualizacje-klienta.md](docs/aktualizacje-klienta.md).

## Licencja

[MIT](LICENSE). Nazwy Allegro, WooCommerce, inFakt, KSeF, DPD, InPost, Meta i inne należą do ich
właścicieli; repozytorium nie jest z nimi powiązane.
