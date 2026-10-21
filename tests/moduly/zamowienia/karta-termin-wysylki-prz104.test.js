// PRZ-104: termin wysyłki na karcie zamówienia — wiersz w „Szczegółach”, ręczna data z formularza
// („najpóźniej do”), powrót do standardu, blokada po wysyłce i wpis w dzienniku (decyzje właściciela 21.10.2026).
// Asercje na fragmentach wyrenderowanego HTML-a i na bazie, nie na całej stronie.
import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, zapiszTerminWysylkiRecznego } from '../../../src/oms/db/zamowienia.js';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'), origin: 'http://localhost' };
const formularz = { ...naglowek, 'content-type': 'application/x-www-form-urlencoded' };
const poller = { stan: () => ({ ostatni_przebieg_at: null, ostatni_blad: null }) };

const dzis = dzienWarszawa(new Date().toISOString());
const zaDni = (n) => new Date(Date.parse(`${dzis}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const naKarcie = (dzien) => { const [r, m, d] = dzien.split('-'); return `${d}.${m}.${r}`; };

const zam = (id, nad = {}) => ({
  zrodlo_id: id, numer: `L-${id}`, klient: { first_name: 'Ala', last_name: 'Lampowa', email: 'ala@lampy.test' },
  dostawa: { first_name: 'Ala', last_name: 'Lampowa', address_1: 'Świetlna 2', postcode: '00-001', city: 'Lampowo', country: 'PL' },
  metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '240.00',
  koszt_dostawy_brutto: '0.00', status_woo: 'processing', oplacone_at: new Date().toISOString(), anulowane: 0,
  utworzone_at: new Date().toISOString(),
  pozycje: [{ nazwa: 'Lampa wisząca Półcień', sku: 'LMP-1', ilosc: 1, cena_brutto: '240.00', brutto_linii: '240.00', vat: null }],
  ...nad,
});

let db, app;
beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' } }, poller });
  await app.ready();
});

const karta = async (id, zapytanie = '') => {
  const r = await app.inject({ method: 'GET', url: `/zamowienia/${id}${zapytanie}`, headers: naglowek });
  expect(r.statusCode, r.body).toBe(200);
  return r.body;
};
// Wiersz „Termin wysyłki” z metryczki: od etykiety do końca jego <div>.
const wiersz = (html) => {
  const od = html.indexOf('<span>Termin wysyłki</span>');
  expect(od, 'brak wiersza „Termin wysyłki”').toBeGreaterThan(-1);
  return html.slice(od, html.indexOf('</div>', od));
};
const formularzTerminu = (html) => {
  const tu = html.indexOf('/termin-wysylki"');
  if (tu === -1) return '';
  return html.slice(html.lastIndexOf('<form', tu), html.indexOf('</form>', tu));
};
const zapisz = (id, data) => app.inject({
  method: 'POST', url: `/zamowienia/${id}/termin-wysylki`, headers: formularz, payload: `data_wysylki=${encodeURIComponent(data)}`,
});
const kolumna = (id) => db.prepare('SELECT termin_wysylki_reczny AS d FROM zamowienia WHERE id = ?').get(id).d;
const wpisy = (id) => db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'termin.wysylki' ORDER BY id").all(id).map((w) => w.wynik);

describe('karta — wiersz „Termin wysyłki”', () => {
  it('standard: data z objaśnieniem, bez znacznika ręcznego', async () => {
    const id = zapiszZamowienie(db, 'lampy', zam(9101), {});
    const w = wiersz(await karta(id));
    expect(w).toMatch(/do (pn|wt|śr|czw|pt|sob|nd) \d\d\.\d\d\.\d{4}/);
    expect(w).toContain('standard: 1 dzień rob. od wpłaty');
    expect(w).not.toContain('ustawiony ręcznie');
  });

  it('nieopłacona przedpłata bez ręcznej daty: „zegar ruszy po wpłacie”', async () => {
    const id = zapiszZamowienie(db, 'lampy', zam(9102, { oplacone_at: null }), {});
    expect(wiersz(await karta(id))).toContain('zegar ruszy po wpłacie');
  });

  it('edycja Szczegółów ma pole daty z obecną wartością; bez edycji formularza nie ma', async () => {
    const id = zapiszZamowienie(db, 'lampy', zam(9103), {});
    expect(formularzTerminu(await karta(id))).toBe('');
    const f = formularzTerminu(await karta(id, '?edytuj=szczegoly'));
    expect(f).toMatch(/<input[^>]*type="date"[^>]*name="data_wysylki"[^>]*value=""/);
    expect(f).toContain('Zapisz datę wysyłki');
    expect(f).not.toContain('Przywróć standardowy termin');
  });
});

describe('POST /zamowienia/:id/termin-wysylki', () => {
  it('zapisuje ręczną datę, karta i lista ją pokazują, dziennik mówi kto i co', async () => {
    const id = zapiszZamowienie(db, 'lampy', zam(9111), {});
    const data = zaDni(10);
    const r = await zapisz(id, data);
    expect(r.statusCode, r.body).toBe(302);
    expect(kolumna(id)).toBe(data);
    const w = wiersz(await karta(id));
    expect(w).toContain(naKarcie(data));
    expect(w).toContain('ustawiony ręcznie');
    expect(w).not.toContain('standard:');
    const f = formularzTerminu(await karta(id, '?edytuj=szczegoly'));
    expect(f).toContain(`value="${data}"`);
    expect(f).toContain('Przywróć standardowy termin');
    expect(wpisy(id)).toEqual([`Ręcznie (adam): data wysyłki ${naKarcie(data)} (było: standardowy termin).`]);
    const lista = await app.inject({ method: 'GET', url: '/', headers: naglowek });
    expect(lista.body).toContain('· data ręczna');
  });

  it('puste pole przywraca standard i zapisuje to w dzienniku', async () => {
    const id = zapiszZamowienie(db, 'lampy', zam(9112), {});
    const data = zaDni(5);
    await zapisz(id, data);
    const r = await zapisz(id, '');
    expect(r.statusCode).toBe(302);
    expect(kolumna(id)).toBeNull();
    expect(wpisy(id)[1]).toBe(`Ręcznie (adam): przywrócono standardowy termin wysyłki (było: ${naKarcie(data)}).`);
  });

  it('przycisk „Przywróć standardowy termin” (przywroc=1) wygrywa z wypełnionym polem', async () => {
    const id = zapiszZamowienie(db, 'lampy', zam(9115), {});
    await zapisz(id, zaDni(4));
    const r = await app.inject({
      method: 'POST', url: `/zamowienia/${id}/termin-wysylki`, headers: formularz,
      payload: `data_wysylki=${zaDni(4)}&przywroc=1`,
    });
    expect(r.statusCode).toBe(302);
    expect(kolumna(id)).toBeNull();
  });

  it('zła data: 400 z czytelnym powodem, kolumna bez zmian, bez wpisu w dzienniku', async () => {
    const id = zapiszZamowienie(db, 'lampy', zam(9113), {});
    const powody = [
      [zaDni(-1), 'wcześniejsza niż dziś'], ['2026-02-30', 'to nie jest data'],
      ['31.12.2026', 'to nie jest data'], [zaDni(400), 'najwyżej rok naprzód'],
    ];
    for (const [zla, powod] of powody) {
      const r = await zapisz(id, zla);
      expect(r.statusCode, zla).toBe(400);
      // Powód, nie ogólnik „błąd techniczny” — operator ma wiedzieć, co poprawić.
      expect(r.body).toContain(`Nie zapisano daty wysyłki: `);
      expect(r.body, zla).toContain(powod);
    }
    expect(kolumna(id)).toBeNull();
    expect(wpisy(id)).toEqual([]);
  });

  it('po wysyłce: 409, data nietknięta, karta bez formularza i z oceną terminu', async () => {
    const id = zapiszZamowienie(db, 'lampy', zam(9114), {});
    await zapisz(id, zaDni(3));
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    const r = await zapisz(id, zaDni(7));
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatch(/już wysłane/);
    expect(kolumna(id)).toBe(zaDni(3));
    const html = await karta(id, '?edytuj=szczegoly');
    expect(formularzTerminu(html)).toBe('');
    expect(wiersz(html)).toContain('wysłane w terminie');
  });

  it('zapis w bazie sam odmawia po wysyłce (paczka nadana między otwarciem karty a kliknięciem)', () => {
    const id = zapiszZamowienie(db, 'lampy', zam(9116), {});
    expect(zapiszTerminWysylkiRecznego(db, id, zaDni(2))).toBe(true);
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    expect(zapiszTerminWysylkiRecznego(db, id, zaDni(9))).toBe(false);
    expect(kolumna(id)).toBe(zaDni(2));
  });

  it('miniona ręczna data: formularz da się wysłać (min = ta data, „Przywróć” bez walidacji), ta sama data = nic', async () => {
    const id = zapiszZamowienie(db, 'lampy', zam(9117), {});
    db.prepare('UPDATE zamowienia SET termin_wysylki_reczny = ? WHERE id = ?').run(zaDni(-3), id);
    const f = formularzTerminu(await karta(id, '?edytuj=szczegoly'));
    expect(f).toContain(`value="${zaDni(-3)}" min="${zaDni(-3)}"`);
    expect(f).toMatch(/name="przywroc" value="1" formnovalidate/);
    const r = await zapisz(id, zaDni(-3));
    expect(r.statusCode).toBe(302);
    expect(kolumna(id)).toBe(zaDni(-3));
    expect(wpisy(id)).toEqual([]);
  });

  it('nieznane zamówienie: 404', async () => {
    expect((await zapisz(999999, zaDni(1))).statusCode).toBe(404);
  });
});
