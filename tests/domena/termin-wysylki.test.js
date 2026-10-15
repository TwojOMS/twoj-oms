import { describe, it, expect } from 'vitest';
import {
  typZamowienia, startZegara, terminZamowienia,
  dniRoboczeDoWysylki, poTerminie, tegoSamegoDnia,
} from '../../src/domena/termin-wysylki.js';

// Czwartek 2026-08-13 to dzień roboczy; 2026-08-15 to sobota.
const sklepowe = (d = {}) => ({
  sklep: 'szkicownia', pobranie: 0, b2b: 0, indywidualne: 0, pozycje: [],
  utworzone_at: '2026-08-13T06:00:00Z', oplacone_at: '2026-08-13T06:00:00Z', ...d,
});
const allegrowe = (d = {}) => sklepowe({ sklep: 'allegro_szkicownia', ...d });

// Te dwa eksporty istnieją, żeby `wiekZamowienia` nie powtarzało reguły u siebie —
// więc mają własne asercje, a nie tylko pokrycie przez `terminZamowienia`.
describe('typZamowienia / startZegara', () => {
  it('typ rozstrzyga się drabinką, w której ekspres jest pierwszy', () => {
    expect(typZamowienia(sklepowe())).toBe('krotki');
    expect(typZamowienia(allegrowe())).toBe('allegro');
    expect(typZamowienia(sklepowe({ indywidualne: 1 }))).toBe('indywidualne');
    expect(typZamowienia(sklepowe({
      indywidualne: 1, sklep: 'allegro_szkicownia', pozycje: [{ nazwa: 'Ekspres 24h' }],
    }))).toBe('ekspres');
  });

  it('start przedpłaty to wpłata, start pobrania i B2B to złożenie', () => {
    expect(startZegara(sklepowe({ oplacone_at: 'A', utworzone_at: 'B' }))).toBe('A');
    expect(startZegara(sklepowe({ pobranie: 1, oplacone_at: 'A', utworzone_at: 'B' }))).toBe('B');
    expect(startZegara(sklepowe({ b2b: 1, oplacone_at: 'A', utworzone_at: 'B' }))).toBe('B');
  });

  it('brak wpłaty to null, nie undefined ani pusty napis', () => {
    expect(startZegara(sklepowe({ oplacone_at: null }))).toBeNull();
    expect(startZegara(sklepowe({ oplacone_at: '' }))).toBeNull();
  });
});

describe('terminZamowienia — cztery limity', () => {
  it('sklepowe ma 1 dzień roboczy', () => {
    expect(terminZamowienia(sklepowe()).limit).toBe(1);
  });

  it('indywidualne ma 7 dni roboczych', () => {
    expect(terminZamowienia(sklepowe({ indywidualne: 1 })).limit).toBe(7);
  });

  it('ekspres ma 2 dni i BIJE indywidualne', () => {
    const z = sklepowe({ indywidualne: 1, pozycje: [{ nazwa: 'Realizacja ekspresowa' }] });
    expect(terminZamowienia(z).limit).toBe(2);
    expect(terminZamowienia(z).typ).toBe('ekspres');
  });

  it('Allegro opłacone przed 12:00 w dzień roboczy ma limit 0', () => {
    // 06:00Z = 08:00 czasu polskiego latem
    expect(terminZamowienia(allegrowe()).limit).toBe(0);
    expect(terminZamowienia(allegrowe()).cutoffAllegro).toBe(true);
  });

  it('Allegro opłacone po 12:00 ma limit 1', () => {
    // 11:00Z = 13:00 czasu polskiego latem
    const z = allegrowe({ oplacone_at: '2026-08-13T11:00:00Z' });
    expect(terminZamowienia(z).limit).toBe(1);
    expect(terminZamowienia(z).cutoffAllegro).toBe(false);
  });
});

describe('terminZamowienia — cutoff 12:00 jest strefowy, nie stałym przesunięciem', () => {
  // ⚠️ Latem 12:00 PL = 10:00Z, zimą 12:00 PL = 11:00Z. Błąd, na który te cztery asercje
  // celują, to STAŁE przesunięcie zaszyte w kodzie.
  it('lato: 09:59Z jeszcze przed odcięciem, 10:00Z już po', () => {
    expect(terminZamowienia(allegrowe({ oplacone_at: '2026-08-13T09:59:00Z' })).limit).toBe(0);
    expect(terminZamowienia(allegrowe({ oplacone_at: '2026-08-13T10:00:00Z' })).limit).toBe(1);
  });

  it('zima: 10:59Z jeszcze przed odcięciem, 11:00Z już po', () => {
    const zima = (g) => allegrowe({
      utworzone_at: `2026-01-15T${g}Z`, oplacone_at: `2026-01-15T${g}Z`,
    });
    expect(terminZamowienia(zima('10:59:00')).limit).toBe(0);
    expect(terminZamowienia(zima('11:00:00')).limit).toBe(1);
  });
});

describe('terminZamowienia — start zegara', () => {
  it('przedpłata liczy od opłacenia', () => {
    const z = sklepowe({ utworzone_at: '2026-08-10T06:00:00Z' });
    expect(terminZamowienia(z).start).toBe('2026-08-13T06:00:00Z');
  });

  it('pobranie liczy od złożenia, nie od opłacenia', () => {
    const z = sklepowe({ pobranie: 1, utworzone_at: '2026-08-10T06:00:00Z', oplacone_at: null });
    expect(terminZamowienia(z).start).toBe('2026-08-10T06:00:00Z');
  });

  it('B2B liczy od złożenia', () => {
    const z = sklepowe({ b2b: 1, utworzone_at: '2026-08-10T06:00:00Z', oplacone_at: null });
    expect(terminZamowienia(z).start).toBe('2026-08-10T06:00:00Z');
  });

  it('nieopłacona przedpłata nie ma startu — null, nie zero', () => {
    expect(terminZamowienia(sklepowe({ oplacone_at: null }))).toBeNull();
  });

  it('śmieciowa data startu oddaje null, nie wyjątek', () => {
    expect(terminZamowienia(sklepowe({ oplacone_at: 'nie-data' }))).toBeNull();
  });
});

describe('poTerminie / dniRoboczeDoWysylki / tegoSamegoDnia', () => {
  it('sklepowe wysłane nazajutrz jest w terminie', () => {
    const z = sklepowe({ wyslane_at: '2026-08-14T07:00:00Z' });
    expect(dniRoboczeDoWysylki(z)).toBe(1);
    expect(poTerminie(z)).toBe(false);
  });

  it('sklepowe wysłane dwa dni robocze później jest po terminie', () => {
    const z = sklepowe({ wyslane_at: '2026-08-17T07:00:00Z' });
    expect(dniRoboczeDoWysylki(z)).toBe(2);
    expect(poTerminie(z)).toBe(true);
  });

  // ⚠️ Granica: DOKŁADNIE limit to jeszcze termin. Mutacja `>` → `>=` musi tu paść.
  it('dokładnie na limicie jest JESZCZE w terminie', () => {
    expect(poTerminie(allegrowe({ wyslane_at: '2026-08-13T14:00:00Z' }))).toBe(false);
    expect(poTerminie(allegrowe({ wyslane_at: '2026-08-14T07:00:00Z' }))).toBe(true);
  });

  it('weekend nie jest winą kuriera — piątek→poniedziałek to 1 dzień roboczy', () => {
    const z = sklepowe({
      utworzone_at: '2026-08-14T06:00:00Z', oplacone_at: '2026-08-14T06:00:00Z',
      wyslane_at: '2026-08-17T07:00:00Z',
    });
    expect(dniRoboczeDoWysylki(z)).toBe(1);
    expect(poTerminie(z)).toBe(false);
  });

  it('tego samego dnia liczy się DNIAMI WARSZAWSKIMI, nie różnicą chwil', () => {
    expect(tegoSamegoDnia(sklepowe({ wyslane_at: '2026-08-13T14:00:00Z' }))).toBe(true);
    // opłacone 21:40Z = 23:40 PL, wysłane 06:10Z = 08:10 PL NASTĘPNEGO dnia: 8,5 h,
    // ale dwa różne dni — i to ta druga odpowiedź jest prawdziwa dla klienta.
    const przezDobe = sklepowe({
      oplacone_at: '2026-08-13T21:40:00Z', wyslane_at: '2026-08-14T06:10:00Z',
    });
    expect(tegoSamegoDnia(przezDobe)).toBe(false);
  });

  it('bez daty wysłania wszystkie trzy oddają null', () => {
    const z = sklepowe({ wyslane_at: null });
    expect(dniRoboczeDoWysylki(z)).toBeNull();
    expect(poTerminie(z)).toBeNull();
    expect(tegoSamegoDnia(z)).toBeNull();
  });

  // ⚠️ Zmierzone na produkcji: 15 zamówień ma `wyslane_at` PRZED `oplacone_at`, jedno
  // o 217 godzin (28171). `Number(null)`-owa arytmetyka dałaby tu 0, czyli „tego samego
  // dnia" — najlepszy możliwy wynik dla najgorszego przypadku.
  it('wysłane PRZED opłaceniem oddaje null, nie zero', () => {
    const z = sklepowe({
      oplacone_at: '2026-08-13T06:00:00Z', wyslane_at: '2026-08-04T10:07:34.648Z',
    });
    expect(dniRoboczeDoWysylki(z)).toBeNull();
    expect(poTerminie(z)).toBeNull();
    expect(tegoSamegoDnia(z)).toBeNull();
  });

  // ⚠️⚠️ WADA WAŻNA Z RECENZJI 13.09.2026: warunek „wysłane przed wpłatą" porównywał DNI
  // warszawskie, a komentarz nad `dniRoboczeDoWysylki` obiecywał CHWILE. Odstęp UJEMNY
  // mieszczący się w jednym dniu przechodził jak normalna, wzorowa wysyłka: `dniRobocze = 0`,
  // `tegoSamegoDnia = true`, `poTerminie = false` — czyli NAJLEPSZY możliwy wynik dla
  // przypadku, który w ogóle nie powinien wchodzić do statystyki, a wiersz „wysłane przed
  // wpłatą" pokazywał przy tym 0.
  //
  // Żaden dotychczasowy test tego nie łapał: odstępy w nich to 9 dni (28171) i przez dobę.
  // Na produkcji 13 z 15 takich zamówień różni się „o sekundy", czyli mieści się w tym samym
  // dniu — ekran obiecywał 15, a pokazywał 1–2.
  it('wysłane przed wpłatą TEGO SAMEGO DNIA też oddaje null — liczą się chwile, nie dni', () => {
    // opłacone 18:00Z = 20:00 PL, wysłane 06:00Z = 08:00 PL — 12 h UJEMNEGO czasu
    // realizacji w obrębie jednej daty warszawskiej.
    const z = sklepowe({
      oplacone_at: '2026-08-13T18:00:00Z', wyslane_at: '2026-08-13T06:00:00Z',
    });
    expect(dniRoboczeDoWysylki(z)).toBeNull();
    expect(poTerminie(z)).toBeNull();
    expect(tegoSamegoDnia(z)).toBeNull();
  });

  // ⚠️ Produkcyjny tryb „o sekundy": wpłata i nadanie w tej samej minucie, wysłanie
  // wcześniejsze o sekundę. Bez porównania z sekundami ten wiersz dalej by przechodził.
  it('sekunda ujemnego czasu wystarcza, żeby wypaść ze statystyki', () => {
    const z = sklepowe({
      oplacone_at: '2026-08-13T10:07:35Z', wyslane_at: '2026-08-13T10:07:34Z',
    });
    expect(dniRoboczeDoWysylki(z)).toBeNull();
  });

  // ⚠️ GRANICA W DRUGĄ STRONĘ: wysłane DOKŁADNIE w chwili wpłaty to jeszcze normalna,
  // zerodniowa wysyłka. Bez tej asercji poprawka mogłaby przestrzelić na `<=` i wyrzucać
  // ze statystyki zamówienia za pobraniem nadane w sekundzie złożenia.
  it('wysłane DOKŁADNIE w chwili startu zegara zostaje w statystyce', () => {
    const z = sklepowe({
      oplacone_at: '2026-08-13T06:00:00Z', wyslane_at: '2026-08-13T06:00:00Z',
    });
    expect(dniRoboczeDoWysylki(z)).toBe(0);
    expect(tegoSamegoDnia(z)).toBe(true);
    expect(poTerminie(z)).toBe(false);
  });

  // ⚠️⚠️ DWIE SKALE CZASU W JEDNYM PORÓWNANIU. `oplacone_at` ze sklepu przychodzi BEZ
  // oznaczenia strefy (czas warszawski), a nasz `wyslane_at` jest znacznikiem UTC z „Z".
  // Gołe `Date.parse` czytałoby oba jako UTC (kontener chodzi z TZ=UTC), więc wpłata
  // sklepowa „08:30" wyglądałaby na 10:30 PL i zamówienie nadane o 09:00 PL fałszywie
  // wypadałoby ze statystyki jako „wysłane przed wpłatą". Różnica to dwie godziny latem —
  // dlatego chwile porównuje `fmtDataCzas`, ten sam przelicznik, co kolumna z datą.
  it('wpłata ze sklepu bez strefy i nasze „Z" porównują się na jednej skali', () => {
    const z = sklepowe({
      oplacone_at: '2026-08-13 08:30:00', wyslane_at: '2026-08-13T07:00:00Z', // 09:00 PL
    });
    expect(dniRoboczeDoWysylki(z)).toBe(0);
    expect(tegoSamegoDnia(z)).toBe(true);
  });
});
