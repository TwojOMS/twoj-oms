import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zapiszUstawienia } from '../../../src/oms/db/ustawienia.js';
import { odczytajSzablony, zmienSzablon, ustawDomyslnySzablon, zapiszSzablony } from '../../../src/domena/szablony-paczek.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { createDpdClient } from '../../../src/oms/kurierzy/dpd.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// PRZ-070 (właściciel 14.10.2026): ekran podglądu i zatwierdzenie nadania hurtem — rozmiar
// w wierszu, „Wysyłam z Allegro" sprawdzane na żywo, „Nadaj i drukuj", pobranie z zamówienia.
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const headers = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`, origin: 'http://localhost' };
const DPD_AD = '03f26351-f683-4db2-8895-f2c599280e3c';
const ONE_BOX = '0b9bed2c-0bc1-4e1f-9694-29bb39ebb483';
const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dir, 'fixtures', 'dpd', n), 'utf8');
const odp = (status, tekst) => ({ status, ok: status >= 200 && status < 300, text: async () => tekst });

const zamowienie = (n, nad = {}) => ({
  zrodlo_id: n, numer: String(n),
  klient: { email: 'j@k.pl', phone: '+48500600700' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Polna 1', postcode: '00-650', city: 'Pęki', country: 'PL' },
  metoda_wysylki: 'dpd', punkt_odbioru: null, kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '104.00',
  status_woo: 'processing', oplacone_at: '2026-10-13T13:00:00', anulowane: 0,
  utworzone_at: '2026-10-13T13:13:48Z', pozycje: [], ...nad,
});

function zestaw({ uslugi = {}, nadanie: nadanieWlasne, awariaAllegro = false } = {}) {
  const db = openOmsDb(':memory:');
  let stan = odczytajSzablony({});
  stan = zmienSzablon(stan, { nazwa: 'Mała', waga: '0,5', dlugosc: '30', szerokosc: '20', wysokosc: '10' }, 'mala').stan;
  stan = zmienSzablon(stan, { nazwa: 'Duża', waga: '3', dlugosc: '110', szerokosc: '75', wysokosc: '1' }, 'duza').stan;
  stan = ustawDomyslnySzablon(stan, 'duza').stan;
  zapiszUstawienia(db, zapiszSzablony(stan));
  const nadanie = nadanieWlasne ?? { nadaj: vi.fn().mockResolvedValue({ numerListu: 'TEST-1' }), paczkaDomyslna: { waga: 1, dlugosc: 110, szerokosc: 75, wysokosc: 1 } };
  const pobierzMetodeDostawy = vi.fn(async (z) => {
    if (awariaAllegro) throw new Error('Allegro 503');
    return uslugi[z.id] ?? DPD_AD;
  });
  const kurierzy = { allegro_wza: { pobierzMetodeDostawy } };
  const app = buildOmsServer({ db, config, nadanie, kurierzy });
  return { app, db, nadanie, pobierzMetodeDostawy };
}

const podglad = async (app, ids) => {
  await app.ready();
  return app.inject({ method: 'POST', url: '/zamowienia/masowe/nadaj-podglad', headers, payload: { id: ids.map(String) } });
};
const zatwierdz = async (app, payload) => {
  await app.ready();
  return app.inject({ method: 'POST', url: '/zamowienia/masowe/nadaj', headers, payload });
};
const tabela = (html) => html.slice(html.indexOf('<table class="nadanie-hurtem"'), html.indexOf('</table>', html.indexOf('<table class="nadanie-hurtem"')));
const wywolanieDla = (nadanie, id) => nadanie.nadaj.mock.calls.find((c) => c[0] === id);

describe('PRZ-070: podgląd nadania hurtem', () => {
  it('DPD za pobraniem i Allegro DPD w jednej partii — szablony, pobranie, usługa Allegro, dwa przyciski', async () => {
    const { app, db } = zestaw();
    const pro = zapiszZamowienie(db, 'pro', zamowienie(1589, {
      pobranie: 1, kwota_pobrania: '104.00', oplacone_at: null,
      pozycje: [
        { nazwa: 'STOP 70x100', sku: 'PRO-STOP-001', ilosc: 2, cena_brutto: '40.00', vat: null },
        { nazwa: 'Szablon cyfry 0–9', sku: 'PRO-CYF-10', ilosc: 1, cena_brutto: '24.00', vat: null },
      ],
    }), {});
    const all = zapiszZamowienie(db, 'allegro_szkicownia', zamowienie(7001, { metoda_wysylki: 'allegro_dpd', kwota_brutto: '74.90' }), {});
    const r = await podglad(app, [pro, all]);
    expect(r.statusCode).toBe(200);
    const t = tabela(r.body);
    expect(t).toContain(`name="szablon_${pro}"`);
    expect(t).toContain(`name="szablon_${all}"`);
    expect(t).toMatch(/<option value="duza" selected>Duża \(110 × 75 × 1 cm, 3 kg\)<\/option>/);
    expect(t).toContain('<option value="mala">Mała (30 × 20 × 10 cm, 0.5 kg)</option>');
    expect(t).toContain(`name="usluga_${all}" value="${DPD_AD}"`);
    expect(t).toContain('Wysyłam z Allegro — Allegro Kurier DPD (AD)');
    // Decyzje właściciela 14.10 po obejrzeniu ekranu: „DPD umowa własna”, kolumna Produkty zamiast Odbiorcy.
    expect(t).toContain('DPD umowa własna');
    expect(t).not.toContain('nasza umowa');
    expect(t).toContain('<th>Produkty</th>');
    expect(t).not.toContain('<th>Odbiorca</th>');
    expect(t).toContain('2 × STOP 70x100');
    expect(t).toContain('1 × Szablon cyfry 0–9');
    expect(t).toContain('PRO-STOP-001');
    expect(t).toContain('104.00 zł');
    expect(r.body).toContain('Suma pobrań w partii: <b>104.00 zł</b>');
    expect(r.body).toContain('name="zatwierdzenie" value="nadaj"');
    expect(r.body).toContain('name="zatwierdzenie" value="nadaj_i_drukuj"');
    expect(r.body).not.toContain('Pominięte —');
    // Na telefonie tabela (≈700 px) przewija się sama, zamiast być ucinana przez panel.
    expect(r.body).toMatch(/<div class="przewijak-tabeli">\s*<table class="nadanie-hurtem">/);
    // Decyzja właściciela 14.10 (po obejrzeniu ekranu): kolumna „Przewoźnik”, bez paska o referencji.
    expect(t).toContain('<th>Przewoźnik</th>');
    expect(t).not.toContain('Którędy');
    expect(r.body).not.toContain('odmawia ponownego nadania');
  });

  it('awaria odczytu usługi Allegro: wiersz w „Pominięte”, DPD dalej w partii', async () => {
    const { app, db } = zestaw({ awariaAllegro: true });
    const pro = zapiszZamowienie(db, 'pro', zamowienie(1589), {});
    const all = zapiszZamowienie(db, 'allegro_szkicownia', zamowienie(7001, {
      metoda_wysylki: 'allegro_dpd', pobranie: 1, kwota_pobrania: '176.89', oplacone_at: null,
    }), {});
    const r = await podglad(app, [pro, all]);
    expect(r.statusCode).toBe(200);
    expect(tabela(r.body)).toContain(`name="szablon_${pro}"`);
    expect(tabela(r.body)).not.toContain(`name="szablon_${all}"`);
    const pominiete = r.body.slice(r.body.indexOf('Pominięte —'));
    expect(pominiete).toContain('Nie można sprawdzić usługi dostawy Allegro. Spróbuj ponownie później.');
    // Recenzja D8 (P3-3): pominięty wiersz nie stoi jednocześnie w „Warte oka”.
    expect(r.body).not.toContain('kwotę pobrania poda Allegro');
  });

  it('nieznana usługa Allegro: „Pominięte” z powodem z wolnoNadacZOms', async () => {
    const { app, db, pobierzMetodeDostawy } = zestaw();
    const all = zapiszZamowienie(db, 'allegro_szkicownia', zamowienie(7001, { metoda_wysylki: 'allegro_inne' }), {});
    pobierzMetodeDostawy.mockImplementation(async () => '0aaaaaaa-0000-0000-0000-000000000000');
    const r = await podglad(app, [all]);
    expect(r.statusCode).toBe(200);
    expect(r.body.slice(r.body.indexOf('Pominięte —'))).toContain('Tej metody dostawy panel nie nada przez „Wysyłam z Allegro');
    expect(r.body).not.toContain('<table class="nadanie-hurtem"');
  });

  it('One Box: S/M/L z S i waga 1; paczkomat: A/B/C z A', async () => {
    const { app, db, pobierzMetodeDostawy } = zestaw();
    const ob = zapiszZamowienie(db, 'allegro_szkicownia', zamowienie(7002, { metoda_wysylki: 'allegro_punkt', punkt_odbioru: 'P1' }), {});
    const pk = zapiszZamowienie(db, 'pro', zamowienie(1590, { metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: 'KRA01M' }), {});
    pobierzMetodeDostawy.mockImplementation(async () => ONE_BOX);
    const r = await podglad(app, [ob, pk]);
    const t = tabela(r.body);
    expect(t).toMatch(new RegExp(`<select name="gabaryt_${ob}"[^>]*>\\s*<option value="S" selected>S</option>`));
    expect(t).toContain(`name="waga_${ob}" value="1"`);
    expect(t).toMatch(new RegExp(`<select name="gabaryt_${pk}"[^>]*>\\s*<option value="A" selected>A</option>`));
    expect(t).toContain('Paczkomat InPost — KRA01M');
    expect(t).toContain(`name="usluga_${ob}" value="${ONE_BOX}"`);
  });
});

describe('PRZ-070: zatwierdzenie nadania hurtem', () => {
  it('każdy wiersz dostaje SWÓJ szablon — mała dla jednego, duża dla drugiego', async () => {
    const { app, db, nadanie } = zestaw();
    const a = zapiszZamowienie(db, 'pro', zamowienie(1), {});
    const b = zapiszZamowienie(db, 'pro', zamowienie(2), {});
    const r = await zatwierdz(app, { id: [String(a), String(b)], [`szablon_${a}`]: 'mala', [`szablon_${b}`]: 'duza', zatwierdzenie: 'nadaj' });
    expect(r.statusCode).toBe(200);
    expect(wywolanieDla(nadanie, a)[1]).toEqual({ waga: 0.5, dlugosc: 30, szerokosc: 20, wysokosc: 10 });
    expect(wywolanieDla(nadanie, b)[1]).toEqual({ waga: 3, dlugosc: 110, szerokosc: 75, wysokosc: 1 });
  });

  it('Allegro: usługa z ekranu ≠ żywa → wiersz NIE jedzie, powód na ekranie wyniku', async () => {
    const { app, db, nadanie } = zestaw();
    const all = zapiszZamowienie(db, 'allegro_szkicownia', zamowienie(7001, { metoda_wysylki: 'allegro_dpd' }), {});
    const r = await zatwierdz(app, { id: String(all), [`usluga_${all}`]: ONE_BOX, [`szablon_${all}`]: 'mala' });
    expect(nadanie.nadaj).not.toHaveBeenCalled();
    expect(r.body).toContain('Usługa dostawy Allegro zmieniła się — odśwież podgląd nadania.');
  });

  it('Allegro zgodne: nadanie z paczką niosącą oczekiwaną usługę', async () => {
    const { app, db, nadanie } = zestaw();
    const all = zapiszZamowienie(db, 'allegro_szkicownia', zamowienie(7001, { metoda_wysylki: 'allegro_dpd' }), {});
    await zatwierdz(app, { id: String(all), [`usluga_${all}`]: DPD_AD, [`szablon_${all}`]: 'mala' });
    expect(wywolanieDla(nadanie, all)[1]).toEqual({ waga: 0.5, dlugosc: 30, szerokosc: 20, wysokosc: 10, oczekiwanyDeliveryMethodId: DPD_AD });
  });

  it('stary formularz (same id): DPD z szablonem domyślnym, paczkomat bez gabarytu odpada', async () => {
    const { app, db, nadanie } = zestaw();
    const d = zapiszZamowienie(db, 'pro', zamowienie(1), {});
    const p = zapiszZamowienie(db, 'pro', zamowienie(2, { metoda_wysylki: 'inpost_paczkomat', punkt_odbioru: 'KRA01M' }), {});
    const r = await zatwierdz(app, { id: [String(d), String(p)] });
    expect(wywolanieDla(nadanie, d)[1]).toEqual({ waga: 3, dlugosc: 110, szerokosc: 75, wysokosc: 1 });
    expect(wywolanieDla(nadanie, p)).toBeUndefined();
    expect(r.body).toMatch(/gabaryt paczkomatu/);
  });

  it('„Nadaj i drukuj” przekazuje drukowac, także przy „Wysyłam z Allegro”', async () => {
    const { app, db, nadanie } = zestaw();
    const d = zapiszZamowienie(db, 'pro', zamowienie(1), {});
    const all = zapiszZamowienie(db, 'allegro_szkicownia', zamowienie(7001, { metoda_wysylki: 'allegro_dpd' }), {});
    await zatwierdz(app, { id: [String(d), String(all)], [`usluga_${all}`]: DPD_AD, zatwierdzenie: 'nadaj_i_drukuj' });
    expect(wywolanieDla(nadanie, d)[2].drukowac).toBe(true);
    expect(wywolanieDla(nadanie, all)[2].drukowac).toBe(true);
  });

  it('pobranie: kwota NIE przychodzi z formularza, w logu kwota z zamówienia', async () => {
    const { app, db, nadanie } = zestaw();
    const a = zapiszZamowienie(db, 'pro', zamowienie(1589, { pobranie: 1, kwota_pobrania: '104.00', oplacone_at: null }), {});
    await zatwierdz(app, { id: String(a), kwota_pobrania: '1', [`kwota_pobrania_${a}`]: '1' });
    expect(wywolanieDla(nadanie, a)[2]).not.toHaveProperty('kwotaPobrania');
    const log = db.prepare("SELECT wynik FROM log WHERE zamowienie_id = ? AND akcja = 'nadanie.pobranie'").all(a).map((w) => w.wynik);
    expect(log).toEqual(['nadanie hurtem: kurier zainkasuje kwotę z zamówienia — 104.00 zł']);
  });
});

describe('PRZ-070: hurt przez PRAWDZIWY klient DPD (atrapa fetch)', () => {
  it('DPD za pobraniem 104.00 hurtem → <cod> z kwotą zamówienia, „Nadaj i drukuj” → etykieta w kolejce', async () => {
    const db0 = openOmsDb(':memory:');
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(odp(200, fixture('v10-ok.xml')))
      .mockResolvedValueOnce(odp(200, fixture('v4-ok.xml')))
      .mockResolvedValueOnce(odp(200, fixture('v4-ok-zpl.xml')));
    const dpd = createDpdClient({
      url: 'https://dpd/api', login: '99999999', haslo: 'x', fid: '278216',
      nadawca: { nazwa: 'Nadawca', ulica: 'ul. Testowa 1', kod: '00-650', miasto: 'Pęki', kraj: 'PL' }, fetchImpl,
    });
    const nadanie = createNadanie({
      db: db0, kurierzy: { dpd }, woo: { dodajNotatke: vi.fn().mockResolvedValue({}) },
      katalogEtykiet: mkdtempSync(join(tmpdir(), 'oms-prz070-')),
    });
    const app = buildOmsServer({ db: db0, config, nadanie });
    const id = zapiszZamowienie(db0, 'pro', zamowienie(1589, { pobranie: 1, kwota_pobrania: '104.00', oplacone_at: null }), {});
    const r = await zatwierdz(app, { id: String(id), zatwierdzenie: 'nadaj_i_drukuj' });
    expect(r.statusCode).toBe(200);
    expect(fetchImpl.mock.calls[0][1].body).toContain('<amount>104.00</amount>');
    expect(db0.prepare('SELECT COUNT(*) AS n FROM kolejka_druku').get().n).toBe(1);
    expect(r.body).toContain('etykieta w kolejce druku');
  });
});
