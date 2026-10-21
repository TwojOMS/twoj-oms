import { describe, it, expect } from 'vitest';
import {
  terminZamowienia, dzienTerminu, dniPoTerminie, parsujDateWysylki, poTerminie,
} from '../../src/domena/termin-wysylki.js';
import { dniRoboczeMiedzy } from '../../src/domena/etap-przesylki.js';
import { wiekZamowienia, terminNaKarcie } from '../../src/domena/wiek-zamowienia.js';
import { terminowosc } from '../../src/domena/statystyki-wysylki.js';

// PRZ-104 — ręczna data wysyłki („najpóźniej do”, decyzja właściciela 21.10.2026).
// Kalendarz: śr 21.10.2026, czw 22, pt 23, sob 24, nd 25, pn 26. Do 25.10 czas letni (UTC+2).
const zam = (d = {}) => ({
  sklep: 'sklep_lampy', pobranie: 0, b2b: 0, indywidualne: 0, anulowane: 0, anulowane_recznie: null,
  pozycje: [{ nazwa: 'Lampa wisząca Półcień' }], wyslane_at: null,
  utworzone_at: '2026-10-21T06:00:00Z', oplacone_at: '2026-10-21T06:00:00Z',
  termin_wysylki_reczny: null, ...d,
});

describe('terminZamowienia — ręczna data', () => {
  it('niesie ręczną datę i to ona jest dniem terminu', () => {
    const t = terminZamowienia(zam({ termin_wysylki_reczny: '2026-10-27' }));
    expect(t.reczny).toBe('2026-10-27');
    expect(dzienTerminu(t)).toBe('2026-10-27');
  });

  it('bez ręcznej daty `reczny` jest null, a dzień terminu liczy standard', () => {
    expect(terminZamowienia(zam()).reczny).toBeNull();
    expect(dzienTerminu(terminZamowienia(zam()))).toBe('2026-10-22');
    expect(dzienTerminu(terminZamowienia(zam({ sklep: 'allegro_polcien' })))).toBe('2026-10-21');
    expect(dzienTerminu(terminZamowienia(zam({ indywidualne: 1 })))).toBe('2026-10-30');
    expect(dzienTerminu(terminZamowienia(zam({ pozycje: [{ nazwa: 'Realizacja ekspresowa' }] })))).toBe('2026-10-23');
    // Start w sobotę, limit 1 → poniedziałek.
    const sobota = zam({ oplacone_at: '2026-10-24T08:00:00Z' });
    expect(dzienTerminu(terminZamowienia(sobota))).toBe('2026-10-26');
  });

  it('ręczna data działa także bez wpłaty (decyzja właściciela) — termin bez startu zegara', () => {
    const t = terminZamowienia(zam({ oplacone_at: null, termin_wysylki_reczny: '2026-10-23' }));
    expect(t).not.toBeNull();
    expect(t.start).toBeNull();
    expect(dzienTerminu(t)).toBe('2026-10-23');
  });

  it('bez wpłaty i bez ręcznej daty dalej null', () => {
    expect(terminZamowienia(zam({ oplacone_at: null }))).toBeNull();
  });
});

describe('dniPoTerminie — jedna miara spóźnienia', () => {
  // ⚠️ PRZYPIĘCIE RÓWNOWAŻNOŚCI ze starą formułą `dniRoboczeMiedzy(start, t) - limit`:
  // standardowy termin ma się po PRZ-104 zachowywać IDENTYCZNIE, z ulgą weekendową włącznie.
  it('dla standardu równa się max(0, dni robocze od startu − limit) na trzech tygodniach', () => {
    const starty = [];
    for (let d = 19; d <= 31; d += 1) {
      for (const godz of ['05:00', '09:59', '10:01', '21:30']) starty.push(`2026-10-${String(d).padStart(2, '0')}T${godz}:00Z`);
    }
    const warianty = [{}, { sklep: 'allegro_polcien' }, { indywidualne: 1 }, { pozycje: [{ nazwa: 'Ekspres' }] }];
    let sprawdzone = 0;
    for (const start of starty) {
      for (const w of warianty) {
        const t = terminZamowienia(zam({ ...w, oplacone_at: start, utworzone_at: start }));
        for (let k = 0; k < 24; k += 1) {
          const chwila = new Date(Date.parse(start) + k * 19 * 3600 * 1000).toISOString();
          expect(dniPoTerminie(t, chwila)).toBe(Math.max(0, dniRoboczeMiedzy(t.start, chwila) - t.limit));
          sprawdzone += 1;
        }
      }
    }
    expect(sprawdzone).toBeGreaterThan(4000);
  });

  it('ręczna data w piątek: piątek wieczór i sobota w terminie, poniedziałek po terminie o 1', () => {
    const t = terminZamowienia(zam({ termin_wysylki_reczny: '2026-10-23' }));
    expect(dniPoTerminie(t, '2026-10-23T20:30:00Z')).toBe(0); // 22:30 PL piątek
    expect(dniPoTerminie(t, '2026-10-24T10:00:00Z')).toBe(0);
    expect(dniPoTerminie(t, '2026-10-26T07:00:00Z')).toBe(1);
    expect(dniPoTerminie(t, '2026-10-27T07:00:00Z')).toBe(2);
  });

  it('ręczna data przed dniem wysyłki: wcześniej niż termin to zero, nie liczba ujemna', () => {
    const t = terminZamowienia(zam({ termin_wysylki_reczny: '2026-10-28' }));
    expect(dniPoTerminie(t, '2026-10-22T07:00:00Z')).toBe(0);
  });
});

describe('parsujDateWysylki — pole formularza', () => {
  const dzis = '2026-10-21';
  it('puste = standard (null)', () => {
    expect(parsujDateWysylki('', dzis)).toBeNull();
    expect(parsujDateWysylki('   ', dzis)).toBeNull();
    expect(parsujDateWysylki(undefined, dzis)).toBeNull();
  });
  it('poprawna data od dziś do roku naprzód przechodzi', () => {
    expect(parsujDateWysylki('2026-10-21', dzis)).toBe('2026-10-21');
    expect(parsujDateWysylki(' 2026-11-05 ', dzis)).toBe('2026-11-05');
    expect(parsujDateWysylki('2027-10-21', dzis)).toBe('2027-10-21');
  });
  it('odmawia daty wstecznej, dalszej niż rok, nieistniejącej i w złym formacie', () => {
    expect(() => parsujDateWysylki('2026-10-20', dzis)).toThrow(/wcześniejsza niż dziś/);
    expect(() => parsujDateWysylki('2027-10-22', dzis)).toThrow(/rok/);
    expect(() => parsujDateWysylki('2026-02-30', dzis)).toThrow(/data/i);
    expect(() => parsujDateWysylki('23.10.2026', dzis)).toThrow(/data/i);
  });
});

describe('poTerminie(z) — wysłane zamówienie', () => {
  it('ręczna data późniejsza niż standard: wysyłka w poniedziałek mieści się w terminie', () => {
    const z = zam({ termin_wysylki_reczny: '2026-10-26', wyslane_at: '2026-10-26T12:00:00Z' });
    expect(poTerminie(z)).toBe(false);
    expect(poTerminie({ ...z, termin_wysylki_reczny: null })).toBe(true);
  });
  it('ręczna data wcześniejsza niż standard: dziś, a wysłane jutro = po terminie', () => {
    const z = zam({ sklep: 'sklep_lampy', termin_wysylki_reczny: '2026-10-21', wyslane_at: '2026-10-22T08:00:00Z' });
    expect(poTerminie(z)).toBe(true);
    expect(poTerminie({ ...z, termin_wysylki_reczny: null })).toBe(false);
  });
});

describe('zegar listy (wiekZamowienia) — ręczna data', () => {
  it('przed terminem: „wysyłka: pt 23.10 · data ręczna”', () => {
    const w = wiekZamowienia(zam({ termin_wysylki_reczny: '2026-10-23' }), '2026-10-21T10:00:00Z');
    expect(w.poTerminie).toBe(false);
    expect(w.opis).toBe('wysyłka: pt 23.10 · data ręczna');
  });
  it('w dniu terminu „dziś”, następnego dnia roboczego po terminie', () => {
    const z = zam({ termin_wysylki_reczny: '2026-10-22' });
    expect(wiekZamowienia(z, '2026-10-22T10:00:00Z').opis).toBe('wysyłka: dziś · data ręczna');
    const po = wiekZamowienia(z, '2026-10-23T10:00:00Z');
    expect(po.poTerminie).toBe(true);
    expect(po.opis).toBe('po terminie o 1 dzień rob.');
  });
  it('ręczna data późniejsza niż standard gasi czerwień standardu', () => {
    const z = zam({ termin_wysylki_reczny: '2026-10-28' });
    expect(wiekZamowienia({ ...z, termin_wysylki_reczny: null }, '2026-10-26T10:00:00Z').poTerminie).toBe(true);
    expect(wiekZamowienia(z, '2026-10-26T10:00:00Z').poTerminie).toBe(false);
  });
  it('bez wpłaty z ręczną datą zegar idzie (nie „czeka na wpłatę”) i czerwienieje po dacie', () => {
    const z = zam({ oplacone_at: null, termin_wysylki_reczny: '2026-10-22' });
    // Dopisek o braku wpłaty — informacja zostaje na liście, choć zegar już idzie (recenzja PRZ-104).
    expect(wiekZamowienia(z, '2026-10-21T10:00:00Z').opis).toBe('wysyłka: jutro · data ręczna · czeka na wpłatę');
    expect(wiekZamowienia(z, '2026-10-23T10:00:00Z').poTerminie).toBe(true);
  });
  it('wysłane i anulowane dalej gaszą zegar', () => {
    expect(wiekZamowienia(zam({ termin_wysylki_reczny: '2026-10-22', wyslane_at: '2026-10-21T12:00:00Z' }), '2026-10-23T10:00:00Z')).toBeNull();
    expect(wiekZamowienia(zam({ termin_wysylki_reczny: '2026-10-22', anulowane: 1 }), '2026-10-23T10:00:00Z')).toBeNull();
  });
});

describe('statystyki terminowości — ręczna data rozstrzyga „w terminie”', () => {
  it('liczy w terminie według ręcznej daty, a rozkład czasu dalej od wpłaty', () => {
    // ⚠️ Każde zamówienie OSOBNO: razem sumowały się do 1 także przy regule standardowej
    // (jedno zamieniało się z drugim), więc test przechodził bez PRZ-104.
    const pozniej = terminowosc([zam({ termin_wysylki_reczny: '2026-10-26', wyslane_at: '2026-10-26T12:00:00Z' })]);
    expect(pozniej.mianownik).toBe(1);
    expect(pozniej.wTerminie).toBe(1); // standard: po terminie (czw 22.10)
    expect(pozniej.rozklad.map((p) => p.ile)).toEqual([0, 0, 0, 1]);
    const wczesniej = terminowosc([zam({ termin_wysylki_reczny: '2026-10-21', wyslane_at: '2026-10-22T08:00:00Z' })]);
    expect(wczesniej.wTerminie).toBe(0); // standard: w terminie
    expect(wczesniej.rozklad.map((p) => p.ile)).toEqual([0, 1, 0, 0]);
  });
  it('wysłane bez wpłaty z ręczną datą zostaje w wyłączeniu „bez startu”, nie w mianowniku', () => {
    const w = terminowosc([zam({ oplacone_at: null, termin_wysylki_reczny: '2026-10-23', wyslane_at: '2026-10-22T08:00:00Z' })]);
    expect(w.mianownik).toBe(0);
    expect(w.wylaczenia).toEqual({ niewyslane: 0, przedWplata: 0, bezStartu: 1 });
  });
});

describe('terminNaKarcie — wiersz „Termin wysyłki”', () => {
  const teraz = '2026-10-21T10:00:00Z';
  it('standard sklepu: data, objaśnienie i pole puste', () => {
    const k = terminNaKarcie(zam(), teraz);
    expect(k.napis).toBe('do czw 22.10.2026');
    expect(k.reczny).toBe(false);
    expect(k.objasnienie).toBe('standard: 1 dzień rob. od wpłaty');
    expect(k.wartoscPola).toBe('');
    expect(k.moznaZmienic).toBe(true);
  });
  it('objaśnienia standardu dla Allegro, ekspresu, indywidualnego i pobrania', () => {
    expect(terminNaKarcie(zam({ sklep: 'allegro_polcien' }), teraz).objasnienie).toBe('standard: Allegro przed 12:00 — wysyłka tego dnia');
    expect(terminNaKarcie(zam({ sklep: 'allegro_polcien', oplacone_at: '2026-10-21T11:00:00Z' }), teraz).objasnienie).toBe('standard: 1 dzień rob. od wpłaty');
    expect(terminNaKarcie(zam({ pozycje: [{ nazwa: 'Ekspres' }] }), teraz).objasnienie).toBe('standard: ekspres — 2 dni rob. od wpłaty');
    expect(terminNaKarcie(zam({ indywidualne: 1 }), teraz).objasnienie).toBe('standard: indywidualne — 7 dni rob. od wpłaty');
    expect(terminNaKarcie(zam({ pobranie: 1, oplacone_at: null }), teraz).objasnienie).toBe('standard: 1 dzień rob. od złożenia');
  });
  it('ręczna data: napis, znacznik i wartość pola', () => {
    const k = terminNaKarcie(zam({ termin_wysylki_reczny: '2026-10-27' }), teraz);
    expect(k.napis).toBe('do wt 27.10.2026');
    expect(k.reczny).toBe(true);
    expect(k.wartoscPola).toBe('2026-10-27');
  });
  it('granice pola: dziś…rok naprzód, a miniona ręczna data obniża `min` do siebie', () => {
    const k = terminNaKarcie(zam(), teraz);
    expect([k.poleOd, k.poleDo]).toEqual(['2026-10-21', '2027-10-21']);
    expect(terminNaKarcie(zam({ termin_wysylki_reczny: '2026-10-19' }), teraz).poleOd).toBe('2026-10-19');
    expect(terminNaKarcie(zam({ termin_wysylki_reczny: '2026-10-30' }), teraz).poleOd).toBe('2026-10-21');
  });
  it('bez wpłaty i bez ręcznej daty: zegar czeka', () => {
    const k = terminNaKarcie(zam({ oplacone_at: null }), teraz);
    expect(k.napis).toBe('zegar ruszy po wpłacie');
    expect(k.moznaZmienic).toBe(true);
  });
  it('po terminie (niewysłane) i po wysyłce — ocena, zmiana zablokowana', () => {
    expect(terminNaKarcie(zam({ termin_wysylki_reczny: '2026-10-21' }), '2026-10-22T10:00:00Z').ocena).toBe('po terminie o 1 dzień rob.');
    const wTerminie = terminNaKarcie(zam({ wyslane_at: '2026-10-22T12:00:00Z' }), '2026-10-23T10:00:00Z');
    expect(wTerminie.ocena).toBe('wysłane w terminie');
    expect(wTerminie.moznaZmienic).toBe(false);
    expect(terminNaKarcie(zam({ wyslane_at: '2026-10-26T12:00:00Z' }), teraz).ocena).toBe('wysłane po terminie o 2 dni rob.');
  });
});
