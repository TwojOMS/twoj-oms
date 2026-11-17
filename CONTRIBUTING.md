# Jak współtworzyć

Zgłoszenia i propozycje: Issues w tym repozytorium. Zmiany: Pull Request z gałęzi roboczej.

1. Przeczytaj [AGENTS.md](AGENTS.md) — reguły repozytorium dotyczą ludzi tak samo jak agentów.
2. Test pierwszy, potem kod; zmieniając zachowanie, zmień jego test w tym samym commicie.
3. `npm run typy` i testy dotkniętego modułu przed PR; pełna bramka (`npm run sprawdz`) leci w CI.
4. Bez danych prawdziwych firm i klientów, bez kluczy i haseł — także w testach i zrzutach ekranu.
5. Migracje bazy tylko addytywne.

## Uruchamianie testów

Wymagane: Node.js 24+, `npm ci` oraz Poppler (`pdftotext` w `PATH`; Debian/Ubuntu: `apt install poppler-utils`).

- Całość: `npm test` (to samo co `vitest run`).
- Jeden plik: `npx vitest run tests/domena/vat.test.js`.
- Testy powiązane ze zmienionym plikiem: `npm run test:zwiazane -- src/ścieżka/pliku.js`. Dla plików szeroko
  importowanych (np. `src/domena/*`, `src/oms/db/*`) wybiera setki testów — wtedy szybciej jest uruchomić katalog modułu.
- Bez `pdftotext` testy odczytu PDF się pomijają (na początku przebiegu pojawia się ostrzeżenie z liczbą plików);
  suita jest wtedy zielona, ale nie sprawdziła tekstu PDF-ów. Przed zgłoszeniem zmiany w dokumentach PDF zainstaluj Popplera.
- Nowy plik `*.test.js|ts` kładź pod `tests/`; strażnik `tests/core/straznik-testy-pod-include.test.js` czerwieni testy
  leżące poza `include` z `vitest.config.ts`.

Projekt jest utrzymywany bez gwarancji czasu odpowiedzi.
