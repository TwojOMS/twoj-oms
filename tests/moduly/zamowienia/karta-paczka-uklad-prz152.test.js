// PRZ-152.G8: nowy układ karty paczki w sekcji „Przesyłka” (makieta zatwierdzona przez właściciela 04.11: „Tak, układ OK”).
//   wiersz 1: „Paczka N” · plakietka przewoźnika (jak w Szczegółach) · JEDEN status etapu · akcje: Pobierz PDF,
//             Drukuj, menu „⋯” (Ukryj / Przywróć);
//   wiersz 2: numer listu jako link do śledzenia + „kopiuj numer”;
//   wiersz 3: ostatnie zdarzenie kuriera bez nawiasu z sekundami („… · dziś 17:18”);
//   wiersz 4: „Do: …” (kod paczkomatu przy paczkomacie, kraj tylko, gdy inny niż PL);
//   stopka:   „Nadana dziś 14:00 · etykieta wydrukowana 14:00 · status sprawdzony 21:14”;
//   pod kartą: „+ Nadaj kolejną paczkę (nr N)” jako zwykły przycisk.
// Dane zmyślone. Czas: 21.10.2026 (CEST, UTC+2) — daleko od zmiany czasu 25.10.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const AUTH = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const zam = (nr, metoda) => ({
  zrodlo_id: nr, numer: `Z-${nr}`, klient: { first_name: 'Beata', last_name: 'Próbna', email: 'b@example.com' },
  dostawa: { first_name: 'Beata', last_name: 'Próbna', address_1: 'Wiśniowa 5', postcode: '00-950', city: 'Warszawa', country: 'PL' },
  metoda_wysylki: metoda, kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '50.00',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: null, anulowane: 0,
  utworzone_at: '2026-10-20T10:00:00Z',
  pozycje: [{ nazwa: 'Szablon próbny', sku: 'S-1', ilosc: 1, cena_brutto: '50.00', brutto_linii: '50.00', vat: null }],
});

let db; let app; let nr = 0;

function zamowienie({ sklep = 'pro', metoda = 'dpd', nazwa = null, punkt = null } = {}) {
  nr += 1;
  const id = zapiszZamowienie(db, sklep, zam(7000 + nr, metoda), {});
  db.prepare('UPDATE zamowienia SET metoda_wysylki = ?, metoda_wysylki_nazwa = ?, punkt_odbioru = ? WHERE id = ?')
    .run(metoda, nazwa, punkt, id);
  return id;
}

function nadaj(id, {
  kurier = 'dpd', kolejnosc = 1, numer, pdf = '/tmp/e.pdf', zpl = null, surowa = '<x/>', adresUzyty = null,
  utworzona = '2026-10-21T12:00:00.000Z', opis = null, opisAt = null, pobrany = null, blad = null,
} = {}) {
  const p = rozpocznijPrzesylke(db, id, kurier, kolejnosc);
  zakonczPrzesylke(db, p.id, {
    numerListu: numer, etykietaSciezka: pdf, etykietaZplSciezka: zpl, surowa,
    adresUzyty: adresUzyty ? JSON.stringify(adresUzyty) : null,
  });
  db.prepare('UPDATE przesylki SET utworzona_at = ?, status_kuriera = ?, status_kuriera_at = ?,'
    + ' status_kuriera_pobrany_at = ?, status_kuriera_blad = ? WHERE id = ?')
    .run(utworzona, opis, opisAt, pobrany, blad, p.id);
  return p.id;
}

const pobierz = (url) => app.inject({ method: 'GET', url, headers: AUTH });
const tekst = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// Karty paczek z sekcji „Przesyłka” (do następnej sekcji).
async function karty(id) {
  const r = await pobierz(`/zamowienia/${id}`);
  expect(r.statusCode, r.body).toBe(200);
  const sekcja = r.body.slice(r.body.indexOf('id="przesylka"'), r.body.indexOf('id="platnosci"'));
  const czesci = sekcja.split(/<div class="paczka(?: paczka--ukryta)?">/).slice(1);
  return { sekcja, czesci };
}
const wiersz = (html, klasa) => {
  const m = html.match(new RegExp(`<(p|div|span) class="[^"]*\\b${klasa}\\b[^"]*">([\\s\\S]*?)</\\1>`));
  return m ? tekst(m[2]) : null;
};
const glowa = (html) => html.slice(0, html.indexOf('paczka-numer'));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T20:00:00Z'));
  db = openOmsDb(':memory:');
  nr = 0;
  app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] }, poller });
  await app.ready();
});
afterEach(() => { vi.useRealTimers(); });

describe('karta paczki: nowy układ (PRZ-152.G8)', () => {
  it('DPD na umowie: wiersze 1–4, stopka i zwykły przycisk kolejnej paczki', async () => {
    const id = zamowienie({ metoda: 'dpd', nazwa: 'Kurier DPD' });
    const pid = nadaj(id, {
      numer: '0000111222333U', zpl: '/tmp/e.zpl', opis: 'Przyjęcie przesyłki w oddziale DPD',
      opisAt: '2026-10-21T15:18:42.000Z', pobrany: '2026-10-21T19:14:09.000Z',
    });
    db.prepare("INSERT INTO kolejka_druku (przesylka_id, status, proby, utworzone_at, wydrukowane_at) VALUES (?, 'wydrukowano', 0, ?, ?)")
      .run(pid, '2026-10-21T12:00:05.000Z', '2026-10-21T12:00:31.000Z');

    const { sekcja, czesci } = await karty(id);
    expect(czesci).toHaveLength(1);
    const k = czesci[0];
    const g = glowa(k);

    // wiersz 1: tytuł, plakietka DPD (klasa jak w Szczegółach), JEDEN status, akcje w kolejności z makiety
    expect(g).toContain('Paczka 1');
    expect(g).toMatch(/<span class="plakietka plakietka--dpd paczka-przewoznik">\s*DPD\s*<\/span>/);
    expect(g.match(/paczka-status/g)).toHaveLength(1);
    expect(wiersz(g, 'paczka-status')).toBe('W drodze (dziś)');
    expect(g).not.toContain('znacznik--wyslane');
    expect(g.indexOf('Pobierz PDF')).toBeGreaterThan(-1);
    expect(g.indexOf('Pobierz PDF')).toBeLessThan(g.indexOf('>Drukuj<'));
    expect(g).not.toContain('paczka-menu'); // nic do ukrycia — bez pustego menu „⋯”

    // wiersz 2: numer jako link DPD + kopiuj (ukryty bez JS)
    expect(k).toMatch(/<a class="link-numer paczka-numer-link" href="https:\/\/tracktrace\.dpd\.com\.pl\/parcelDetails\?typ=1&amp;p1=0000111222333U" target="_blank" rel="noopener">0000111222333U<\/a>/);
    expect(k).toMatch(/<button type="button" class="btn btn--maly paczka-kopiuj" data-kopiuj-numer="0000111222333U" hidden>/);

    // wiersz 3: zdarzenie bez nawiasu i sekund
    expect(wiersz(k, 'paczka-zdarzenie')).toBe('Przyjęcie przesyłki w oddziale DPD · dziś 17:18');
    expect(k).not.toMatch(/\d\d:\d\d:\d\d/);

    // wiersz 4: adres z zamówienia, bez kraju PL
    expect(wiersz(k, 'paczka-do')).toBe('Do: Beata Próbna, Wiśniowa 5, 00-950 Warszawa');

    // stopka
    expect(wiersz(k, 'paczka-meta')).toBe('Nadana dziś 14:00 · etykieta wydrukowana 14:00 · status sprawdzony 21:14');

    // pod kartą: zwykły przycisk, obok „Paczka nadana poza panelem?”
    expect(sekcja).toMatch(/<a class="btn" href="[^"]*nadaj[^"]*">\s*\+ Nadaj kolejną paczkę \(nr 2\)\s*<\/a>/);
    expect(sekcja).not.toMatch(/btn--glowny[^>]*>\s*\+?\s*Nadaj kolejną/);
    expect(sekcja).toContain('Paczka nadana poza panelem?');
  });

  it('Allegro WzA wieziona przez DPD: plakietka „DPD · Allegro” i link DPD', async () => {
    const id = zamowienie({ sklep: 'allegro_proba', metoda: 'allegro_dpd', nazwa: 'Allegro Kurier DPD' });
    nadaj(id, {
      kurier: 'allegro_wza', numer: 'AD0001112223',
      surowa: JSON.stringify({ carrier: 'ALLEGRO', packages: [{ waybill: 'AD0001112223', transportingInfo: { carrierId: 'DPD' } }] }),
    });
    const { czesci } = await karty(id);
    const g = glowa(czesci[0]);
    expect(g).toMatch(/<span class="plakietka plakietka--dpd paczka-przewoznik">\s*DPD · Allegro\s*<\/span>/);
    expect(czesci[0]).toContain('href="https://tracktrace.dpd.com.pl/parcelDetails?typ=1&amp;p1=AD0001112223"');
    // karta sama odpytuje Allegro przy otwarciu (w teście bez zdarzeń, czas próby = teraz):
    // jeden status „Nadana”, zdarzenie „brak zdarzeń”
    expect(g.match(/paczka-status/g)).toHaveLength(1);
    expect(wiersz(g, 'paczka-status')).toBe('Nadana');
    expect(wiersz(czesci[0], 'paczka-zdarzenie')).toBe('brak zdarzeń');
    expect(wiersz(czesci[0], 'paczka-meta')).toBe('Nadana dziś 14:00 · status sprawdzony 22:00');
  });

  it('InPost paczkomat: kod paczkomatu w „Do:”, plakietka InPost', async () => {
    const id = zamowienie({ metoda: 'inpost_paczkomat', nazwa: 'Paczkomat InPost', punkt: 'WRO10B' });
    nadaj(id, {
      kurier: 'inpost', numer: '620000111222333444555666', opis: 'Gotowa do odbioru w paczkomacie',
      opisAt: '2026-10-20T07:41:00.000Z', pobrany: '2026-10-21T19:14:00.000Z',
    });
    const { czesci } = await karty(id);
    const g = glowa(czesci[0]);
    expect(g).toMatch(/<span class="plakietka plakietka--inpost paczka-przewoznik">\s*InPost\s*<\/span>/);
    expect(wiersz(g, 'paczka-status')).toBe('W doręczeniu');
    expect(wiersz(czesci[0], 'paczka-zdarzenie')).toBe('Gotowa do odbioru w paczkomacie · wczoraj 09:41');
    expect(wiersz(czesci[0], 'paczka-do')).toBe('Do: Paczkomat WRO10B, Beata Próbna');
  });

  it('paczka ukryta: znacznik „ukryta”, „Przywróć” w menu „⋯” (details), a przy zastąpionej „Ukryj” też w menu', async () => {
    const id = zamowienie({ metoda: 'dpd' });
    const p1 = nadaj(id, { numer: '0000000000001U' });
    nadaj(id, { kolejnosc: 2, numer: '0000000000002U' });

    // przed ukryciem: „Ukryj” w menu paczki 1
    let { czesci } = await karty(id);
    let g = glowa(czesci[0]);
    expect(g).toMatch(/<details class="wydruki paczka-menu">\s*<summary class="btn btn--maly" aria-label="Więcej akcji: paczka 1" title="Więcej akcji">⋯<\/summary>/);
    const menu1 = g.slice(g.indexOf('<details class="wydruki paczka-menu">'), g.indexOf('</details>'));
    expect(menu1).toContain('/ukryj');
    expect(g.slice(0, g.indexOf('<details')).includes('/ukryj')).toBe(false);

    db.prepare("UPDATE przesylki SET ukryta_at = '2026-10-21T13:00:00.000Z', ukryta_przez = 'adam' WHERE id = ?").run(p1);
    ({ czesci } = await karty(id));
    const r = await pobierz(`/zamowienia/${id}`);
    expect(r.body).toMatch(/<div class="paczka paczka--ukryta">/);
    g = glowa(czesci[0]);
    expect(g).toMatch(/<span class="znacznik"[^>]*>ukryta<\/span>/);
    const menu = g.slice(g.indexOf('<details class="wydruki paczka-menu">'), g.indexOf('</details>'));
    expect(menu).toContain('/przywroc');
    expect(menu).toContain('>Przywróć</button>');
    expect(g.slice(0, g.indexOf('<details')).includes('/przywroc')).toBe(false);
    // paczka 2 — bez menu (nic rzadkiego do zrobienia)
    expect(glowa(czesci[1])).not.toContain('paczka-menu');
  });

  it('kraj w „Do:” tylko, gdy inny niż PL; adres użyty przy nadaniu różny od zamówienia ma znacznik', async () => {
    const id = zamowienie({ metoda: 'dpd' });
    nadaj(id, {
      numer: '0000000000003U',
      adresUzyty: { nazwa: 'Beata Próbna', ulica: 'Lindenweg 2', kod: '10115', miasto: 'Berlin', kraj: 'DE' },
    });
    const { czesci } = await karty(id);
    expect(wiersz(czesci[0], 'paczka-do')).toBe('Do: Beata Próbna, Lindenweg 2, 10115 Berlin, DE inny niż adres w zamówieniu');

    const id2 = zamowienie({ metoda: 'dpd' });
    nadaj(id2, {
      numer: '0000000000004U',
      adresUzyty: { nazwa: 'Beata Próbna', ulica: 'Wiśniowa 5', kod: '00-950', miasto: 'Warszawa', kraj: 'PL' },
    });
    const k2 = (await karty(id2)).czesci[0];
    expect(wiersz(k2, 'paczka-do')).toBe('Do: Beata Próbna, Wiśniowa 5, 00-950 Warszawa');
  });

  it('status niedostępny i porzucony wydruk zostają w stopce jako stan zły', async () => {
    const id = zamowienie({ metoda: 'dpd' });
    const pid = nadaj(id, { numer: '0000000000005U', zpl: '/tmp/e.zpl', pobrany: '2026-10-21T19:14:00.000Z', blad: 'timeout' });
    db.prepare("INSERT INTO kolejka_druku (przesylka_id, status, proby, utworzone_at) VALUES (?, 'porzucone', 3, ?)")
      .run(pid, '2026-10-21T12:00:05.000Z');
    const k = (await karty(id)).czesci[0];
    expect(wiersz(k, 'paczka-meta')).toBe('Nadana dziś 14:00 · wydruk porzucony · status niedostępny (ostatnia próba 21:14)');
    expect(k).toMatch(/<span class="stan-zle">wydruk porzucony<\/span>/);
    expect(k).toMatch(/<span class="stan-zle">status niedostępny \(ostatnia próba 21:14\)<\/span>/);
  });
});
