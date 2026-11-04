import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszUmowePobrania } from '../../../src/moduly/wysylka/db/umowy-pobrania.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const dopisek = 'tylko bez pobrania na tej paczce';
const zdanie = 'Pobranie na tej paczce przyjmą tylko kurierzy bez dopisku „tylko bez pobrania na tej paczce”.';
const naglowki = { authorization: 'Basic ' + Buffer.from('operator:atrapa').toString('base64') };
let db, serwer;

beforeEach(() => { db = openOmsDb(':memory:'); });
afterEach(async () => {
  if (serwer) await serwer.close();
  serwer = undefined;
  db.close();
});

async function ekran({ pobranie = 1, dosylka = true, umowa = false, metoda = 'allegro_dpd' } = {}) {
  zapiszUmowePobrania(db, 'inpost', umowa);
  const id = zapiszZamowienie(db, 'allegro_polcien', {
    zrodlo_id: 'pc-143', numer: 'PC-143', klient: { email: 'ala@example.test' },
    dostawa: { first_name: 'Ala', last_name: 'Przykładowa', address_1: 'Przykładowa 12', postcode: '00-001', city: 'Warszawa', country: 'PL' },
    metoda_wysylki: metoda, pobranie, kwota_pobrania: pobranie ? '123.45' : null,
    kwota_brutto: '123.45', chce_fakture: 0, nip: null, punkt_odbioru: null,
    status_woo: 'processing', oplacone_at: null, anulowane: 0,
    pozycje: [], utworzone_at: '2026-11-04T10:00:00',
  }, {});
  if (dosylka) db.prepare("INSERT INTO przesylki (zamowienie_id, kurier, kolejnosc, status, numer_listu, utworzona_at) VALUES (?, 'dpd', 1, 'nadana', 'PC143TEST', '2026-11-04T10:00:00')").run(id);
  const config = { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [{ klucz: 'allegro_polcien', typ: 'allegro', prefiks: 'PC', etykieta: 'Pracownia Półcień', raport: 'PC' }],
    kanaly: { allegro_polcien: {} }, sklepy: {} };
  const nadanie = { gotowe: () => true, nadaj: () => { throw new Error('GET nie może nadawać'); } };
  serwer = buildOmsServer({ db, config, nadanie, poller: { stan: () => ({}) } });
  const r = await serwer.inject({ method: 'GET', url: `/zamowienia/${id}/nadaj?wybor=1`, headers: naglowki });
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain(`Czym nadać paczkę nr ${dosylka ? 2 : 1}?`);
  return r.body;
}

function pozycja(html, kurier) {
  const li = html.match(/<li>[\s\S]*?<\/li>/g)?.find((s) => s.includes(`kurier=${kurier}`));
  expect(li, `pozycja ${kurier} pozostaje na liście`).toBeDefined();
  return li;
}

describe('wybór kuriera dosyłki — informacja przed formularzem nadania', () => {
  it('wszyscy kurierzy bez dopisku → bez zdania nad listą', async () => {
    // Nieznana usługa Allegro nie ma drogi WzA; DPD i InPost z umową przyjmują pobranie.
    const html = await ekran({ metoda: 'allegro_nieznana_usluga', umowa: true });
    expect(pozycja(html, 'dpd')).not.toContain(dopisek);
    expect(pozycja(html, 'inpost_paczkomat')).not.toContain(dopisek);
    expect(html).not.toContain(zdanie);
    expect(html).not.toContain('Zamiennik paczki nr 1 z pobraniem');
    expect(html).not.toContain(dopisek);
  });

  it('bez umowy oznacza paczkomat i WzA, pozostawiając DPD bez dopisku', async () => {
    const html = await ekran();
    expect(html).toContain(zdanie);
    expect(pozycja(html, 'inpost_paczkomat')).toContain(dopisek);
    expect(pozycja(html, 'wza')).toContain(dopisek);
    expect(pozycja(html, 'dpd')).not.toContain(dopisek);
  });

  it('z umową InPost paczkomat pozostaje bez dopisku, WzA z dopiskiem', async () => {
    const html = await ekran({ umowa: true });
    expect(pozycja(html, 'inpost_paczkomat')).not.toContain(dopisek);
    expect(pozycja(html, 'wza')).toContain(dopisek);
  });

  it.each([
    { pobranie: 1, dosylka: false },
    { pobranie: 0, dosylka: true },
    { pobranie: 0, dosylka: false },
  ])('bez nowych tekstów przy pobraniu=$pobranie, dosyłce=$dosylka', async (wariant) => {
    const html = await ekran(wariant);
    expect(html).not.toContain(dopisek);
    expect(html).not.toContain(zdanie);
  });
});
