import { describe, it, expect } from 'vitest';
import { utworzHamulec, LIMIT_PROB, KARA_MS } from '../../../src/core/bezpieczenstwo/hamulec.js';

const T = 1_770_000_000_000;
const KLUCZ = '192.168.0.31';

describe('hamulec logowania', () => {
  it('przepuszcza, dopoki nie ma prob', () => {
    expect(utworzHamulec().sprawdz(KLUCZ, T)).toEqual({ wolno: true, zostaloMs: 0 });
  });

  it('przepuszcza az do przedostatniej proby wlacznie', () => {
    const h = utworzHamulec();
    for (let i = 0; i < LIMIT_PROB - 1; i++) h.odnotujBlad(KLUCZ, T);
    expect(h.sprawdz(KLUCZ, T).wolno).toBe(true);
  });

  it('zapala kare dokladnie przy limicie, nie wczesniej i nie pozniej', () => {
    const h = utworzHamulec();
    for (let i = 0; i < LIMIT_PROB; i++) h.odnotujBlad(KLUCZ, T);
    expect(h.sprawdz(KLUCZ, T).wolno).toBe(false);
  });

  it('oddaje czas pozostaly do konca kary', () => {
    const h = utworzHamulec();
    for (let i = 0; i < LIMIT_PROB; i++) h.odnotujBlad(KLUCZ, T);
    expect(h.sprawdz(KLUCZ, T).zostaloMs).toBe(KARA_MS);
    expect(h.sprawdz(KLUCZ, T + 20_000).zostaloMs).toBe(KARA_MS - 20_000);
  });

  it('kara mija po swoim czasie', () => {
    const h = utworzHamulec();
    for (let i = 0; i < LIMIT_PROB; i++) h.odnotujBlad(KLUCZ, T);
    expect(h.sprawdz(KLUCZ, T + KARA_MS - 1).wolno).toBe(false);
    expect(h.sprawdz(KLUCZ, T + KARA_MS).wolno).toBe(true);
  });

  // ⚠️ Ten przypadek jest cala roznica miedzy hamulcem, ktory spowalnia zgadujacego STALE,
  // a takim, ktory zatrzymuje go raz i potem oddaje darmowe proby.
  it('kolejna proba w trakcie kary PRZEDLUZA ja od nowa', () => {
    const h = utworzHamulec();
    for (let i = 0; i < LIMIT_PROB; i++) h.odnotujBlad(KLUCZ, T);
    h.odnotujBlad(KLUCZ, T + 30_000);
    expect(h.sprawdz(KLUCZ, T + KARA_MS).wolno).toBe(false);
    expect(h.sprawdz(KLUCZ, T + 30_000 + KARA_MS).wolno).toBe(true);
  });

  it('udane logowanie kasuje licznik', () => {
    const h = utworzHamulec();
    for (let i = 0; i < LIMIT_PROB - 1; i++) h.odnotujBlad(KLUCZ, T);
    h.wyczysc(KLUCZ);
    expect(h.proby(KLUCZ)).toBe(0);
    // Po wyczyszczeniu znowu trzeba pelnego limitu, zeby zapalic kare.
    for (let i = 0; i < LIMIT_PROB - 1; i++) h.odnotujBlad(KLUCZ, T);
    expect(h.sprawdz(KLUCZ, T).wolno).toBe(true);
  });

  it('kara jednego klucza nie dotyka drugiego', () => {
    const h = utworzHamulec();
    for (let i = 0; i < LIMIT_PROB; i++) h.odnotujBlad(KLUCZ, T);
    expect(h.sprawdz(KLUCZ, T).wolno).toBe(false);
    expect(h.sprawdz('10.0.0.9', T).wolno).toBe(true);
  });

  it('dwa hamulce nie dziela stanu', () => {
    const a = utworzHamulec();
    const b = utworzHamulec();
    for (let i = 0; i < LIMIT_PROB; i++) a.odnotujBlad(KLUCZ, T);
    expect(b.sprawdz(KLUCZ, T).wolno).toBe(true);
  });
});

// ⚠️⚠️ N1 (druga fala, recenzja 2026-09-12): `zapiszBlokadeRaz` istnieje, zeby logowanie.js
// napisalo do dziennika WYLACZNIE JEDEN wpis „zablokowane" na kare, a nie jeden na kazde
// zadanie w jej trakcie. Bez tej funkcji pukanie w zapalona kare przez 2 s dawalo (zmierzone
// na zywym serwerze) 291 wierszy zamiast jednego.
describe('zapiszBlokadeRaz — jeden wpis w dzienniku na jedna kare', () => {
  it('zanim kara sie zapali, nie ma czego zapisywac', () => {
    const h = utworzHamulec();
    expect(h.zapiszBlokadeRaz(KLUCZ, T)).toBe(false);
  });

  it('pierwsze pytanie PO zapaleniu kary mowi TAK, kazde kolejne — NIE', () => {
    const h = utworzHamulec();
    for (let i = 0; i < LIMIT_PROB; i++) h.odnotujBlad(KLUCZ, T);
    expect(h.zapiszBlokadeRaz(KLUCZ, T)).toBe(true);
    // ⚠️ TO JEST CALY SENS TEJ FUNKCJI: druga, trzecia, setna proba w trakcie TEJ SAMEJ
    // kary nie majaz prawa zapisac kolejnego wiersza.
    expect(h.zapiszBlokadeRaz(KLUCZ, T + 1)).toBe(false);
    expect(h.zapiszBlokadeRaz(KLUCZ, T + 2_000)).toBe(false);
    expect(h.zapiszBlokadeRaz(KLUCZ, T + KARA_MS - 1)).toBe(false);
  });

  it('po wygasnieciu kary i jej PONOWNYM zapaleniu mozna zapisac znowu', () => {
    const h = utworzHamulec();
    for (let i = 0; i < LIMIT_PROB; i++) h.odnotujBlad(KLUCZ, T);
    expect(h.zapiszBlokadeRaz(KLUCZ, T)).toBe(true);
    // Kara minela, licznik startuje od zera.
    for (let i = 0; i < LIMIT_PROB; i++) h.odnotujBlad(KLUCZ, T + KARA_MS + 1);
    // Druga kara jest NOWYM epizodem — ma prawo do wlasnego, jednego wpisu.
    expect(h.zapiszBlokadeRaz(KLUCZ, T + KARA_MS + 1)).toBe(true);
    expect(h.zapiszBlokadeRaz(KLUCZ, T + KARA_MS + 2)).toBe(false);
  });

  it('kara jednego klucza nie zwalnia flagi drugiego', () => {
    const h = utworzHamulec();
    for (let i = 0; i < LIMIT_PROB; i++) h.odnotujBlad(KLUCZ, T);
    expect(h.zapiszBlokadeRaz(KLUCZ, T)).toBe(true);
    expect(h.zapiszBlokadeRaz('10.0.0.9', T)).toBe(false);
  });
});
