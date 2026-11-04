import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { createInpostClient } from '../../../src/oms/kurierzy/inpost.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { zapiszUmowePobrania } from '../../../src/moduly/wysylka/db/umowy-pobrania.js';

// PRZ-137.03 (D2, D3): zamiennik za pobraniem (paczka N > 1, zaznaczone „pobranie na tej
// paczce") decyduje się PO KURIERZE, nie po formularzu. Paczkomat z umową firmy wiezie `cod`,
// bez umowy — odmowa „wymaga umowy" (zamiennik to zawsze pobranie OMS-owe, także przy
// zamówieniu ze sklepu); WzA — odmowa neutralna, bez założenia, że zostaje DPD.
const NEUTRALNA = 'Wysyłam z Allegro nie przyjmie pobrania na kolejnej paczce — wybierz kuriera, który je przyjmuje, albo wyłącz pobranie na tej paczce';
const ADRES = { nazwa: 'Ala Przykładowa', ulica: 'Przykładowa 12', kod: '00-001', miasto: 'Warszawa', kraj: 'PL', phone: '+48500100200', email: 'ala@example.test' };
const TOKEN = 'atrapa-tokenu-shipx';
let db, katalog;

beforeEach(() => {
  db = openOmsDb(':memory:');
  katalog = mkdtempSync(join(process.cwd(), '.b1-etykiety-'));
});
afterEach(() => {
  db.close();
  rmSync(katalog, { recursive: true, force: true });
});

// Atrapa ShipX: domyślnie odsyła `cod`, który dostała (jak prawdziwy ShipX przy pobraniu).
const echo = (body) => ({ ok: true, status: 201, dane: {
  id: 12345, tracking_number: '520000000000000000000001', cod: body.cod ?? { amount: null, currency: null },
} });

function przygotuj({ umowa = false, metoda = 'inpost_paczkomat', shipx = echo } = {}) {
  zapiszUmowePobrania(db, 'inpost', umowa);
  const fetchImpl = vi.fn(async (url, opcje) => {
    if (String(url).includes('format=')) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('%PDF-1.4\n') };
    const { ok, status, dane } = shipx(JSON.parse(opcje.body));
    return { ok, status, text: async () => JSON.stringify(dane) };
  });
  const inpost = createInpostClient({ url: 'https://shipx.example.test/v1', token: TOKEN, organizacja: 12345,
    nadawca: { ...ADRES, nazwa: 'Pracownia Półcień' }, fetchImpl });
  const dpd = { nadaj: vi.fn(async () => ({ numerListu: 'TEST-1', etykietaPdf: Buffer.from('%PDF-1.4\n'), etykietaZpl: null, surowa: '{}' })) };
  const allegro_wza = { nadaj: vi.fn(async () => { throw new Error('WzA nie powinien być wołany'); }) };
  const nadanie = createNadanie({ db, kurierzy: { inpost, dpd, allegro_wza }, katalogEtykiet: katalog });
  const id = zapiszZamowienie(db, 'sklep_test', {
    zrodlo_id: 'test-1', numer: 'TEST-1', klient: { email: ADRES.email, phone: ADRES.phone },
    dostawa: { first_name: 'Ala', last_name: 'Przykładowa', address_1: ADRES.ulica, postcode: ADRES.kod, city: ADRES.miasto, country: 'PL' },
    metoda_wysylki: metoda, pobranie: 1, kwota_pobrania: '212.90', kwota_brutto: '212.90', chce_fakture: 0, nip: null,
    punkt_odbioru: 'WAW01M', status_woo: 'processing', oplacone_at: null, anulowane: 0, pozycje: [], utworzone_at: '2026-11-03T12:00:00',
  }, {});
  const nadaj = (opcje = {}) => nadanie.nadaj(id, { waga: 1, gabaryt: 'A' }, {
    kolejnosc: 2, pobranieNaTejPaczce: true, adres: ADRES, ...opcje });
  const przesylki = () => db.prepare('SELECT * FROM przesylki WHERE zamowienie_id = ?').all(id);
  const logi = () => db.prepare('SELECT * FROM log WHERE zamowienie_id = ?').all(id);
  const cialo = () => JSON.parse(fetchImpl.mock.calls.find(([url]) => !String(url).includes('format='))[1].body);
  return { nadaj, przesylki, logi, fetchImpl, dpd, allegro_wza, cialo };
}

describe('B1: zamiennik za pobraniem — po kurierze (PRZ-137.03)', () => {
  it('InPost paczka nr 2, umowa wł.: nadana, ShipX dostaje cod = kwota zamówienia, log obiecuje inkaso', async () => {
    const t = przygotuj({ umowa: true });
    await t.nadaj();
    expect(t.przesylki()).toMatchObject([{ status: 'nadana', kolejnosc: 2 }]);
    expect(t.cialo().cod).toEqual({ amount: 212.9, currency: 'PLN' });
    expect(t.logi().some((w) => w.wynik.includes('Kurier zainkasuje 212.90 zł.'))).toBe(true);
  });

  it('InPost paczka nr 2, umowa wł., kwota poprawiona na ekranie: cod = kwota z ekranu', async () => {
    const t = przygotuj({ umowa: true });
    await t.nadaj({ kwotaPobrania: '199.99' });
    expect(t.cialo().cod).toEqual({ amount: 199.99, currency: 'PLN' });
  });

  // Zamówienie ze sklepu z tą samą metodą byłoby przy paczce nr 1 pobraniem sklepowym (D1),
  // ale o pobraniu na KOLEJNEJ paczce decyduje operator — to zawsze pobranie OMS-owe (D2).
  it('InPost paczka nr 2, umowa wył.: odmowa „wymaga umowy" bez żądań, przesyłki i obietnicy inkasa', async () => {
    const t = przygotuj({ umowa: false });
    const wynik = await t.nadaj().catch((blad) => blad);
    expect(wynik).toMatchObject({ dlaOperatora: true });
    expect(wynik.message).toContain('Pobranie przez InPost wymaga umowy');
    expect(wynik.message).not.toContain('DPD');
    expect.soft(t.fetchImpl).not.toHaveBeenCalled();
    expect.soft(t.przesylki()).toHaveLength(0);
    expect(t.logi().some((w) => /zainkasuje/i.test(w.wynik))).toBe(false);
  });

  it.each(['allegro_dpd', 'allegro_punkt'])('WzA (%s) paczka nr 2 z pobraniem: odmowa neutralna, bez słowa „DPD"', async (metoda) => {
    const t = przygotuj({ metoda, umowa: true });
    const wynik = await t.nadaj().catch((blad) => blad);
    expect(wynik).toMatchObject({ dlaOperatora: true });
    expect(wynik.message).toContain(NEUTRALNA);
    expect(wynik.message).not.toContain('DPD');
    expect.soft(t.allegro_wza.nadaj).not.toHaveBeenCalled();
    expect.soft(t.przesylki()).toHaveLength(0);
    expect(t.logi().some((w) => /zainkasuje/i.test(w.wynik))).toBe(false);
  });

  it('DPD paczka nr 2 z pobraniem: nadana, decyzja i kwota trafiają do kuriera oraz logu', async () => {
    const t = przygotuj({ metoda: 'dpd' });
    await t.nadaj();
    expect(t.przesylki()).toMatchObject([{ status: 'nadana', kolejnosc: 2 }]);
    expect(t.dpd.nadaj).toHaveBeenCalledWith(expect.objectContaining({ kolejnosc: 2, pobranieNaTejPaczce: true }));
    expect(t.logi().some((w) => w.wynik.includes('Kurier zainkasuje 212.90 zł.'))).toBe(true);
    expect(t.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([true, false])('InPost paczka nr 2 bez pobrania na tej paczce (umowa %s): nadana bez cod', async (umowa) => {
    const t = przygotuj({ umowa });
    await t.nadaj({ pobranieNaTejPaczce: false });
    expect(t.przesylki()).toMatchObject([{ status: 'nadana', kolejnosc: 2 }]);
    expect(t.cialo().cod).toBeFalsy();
    expect(t.logi().some((w) => /zainkasuje/i.test(w.wynik))).toBe(false);
  });

  // Recenzja 137-03: jawne `false` na paczce nr 1 zamówienia za pobraniem nie robi z niej cichej przedpłaty.
  it.each([true, false])('InPost paczka nr 1 z jawnym pobranieNaTejPaczce:false (umowa %s): cod i tak jedzie', async (umowa) => {
    const t = przygotuj({ umowa });
    await t.nadaj({ kolejnosc: 1, pobranieNaTejPaczce: false });
    expect(t.przesylki()).toMatchObject([{ status: 'nadana', kolejnosc: 1 }]);
    expect(t.cialo().cod).toEqual({ amount: 212.9, currency: 'PLN' });
  });

  it('InPost paczka nr 1 z pobraniem i umową: nadana z cod.amount z kwoty', async () => {
    const t = przygotuj({ umowa: true });
    await t.nadaj({ kolejnosc: 1, kwotaPobrania: '310.33' });
    expect(t.przesylki()).toMatchObject([{ status: 'nadana', kolejnosc: 1 }]);
    expect(t.cialo().cod).toEqual({ amount: 310.33, currency: 'PLN' });
  });

  // Siatka: ShipX przyjął przesyłkę, ale oddał INNĄ kwotę pobrania niż wysłana — panel nie
  // melduje „nadane", tylko odkłada sprawę do wyjaśnienia (paczka u kuriera istnieje).
  it('zamiennik: echo cod.amount ≠ wysłanej kwoty → błąd i wiersz do wyjaśnienia', async () => {
    const t = przygotuj({ umowa: true, shipx: (body) => {
      const odp = echo(body);
      return { ...odp, dane: { ...odp.dane, cod: { amount: 21.29, currency: 'PLN' } } };
    } });
    const wynik = await t.nadaj().catch((blad) => blad);
    expect(wynik).toMatchObject({ dlaOperatora: true });
    expect(wynik.message).toMatch(/NIE POTWIERDZIŁ pobrania 212\.90 zł/);
    expect(t.cialo().cod).toEqual({ amount: 212.9, currency: 'PLN' });
    expect(t.przesylki()).toMatchObject([{ status: 'do_wyjasnienia', kolejnosc: 2 }]);
  });

  // Decyzja właściciela 5: limitu pobrania InPostu NIE wpisujemy na sztywno — gdy ShipX odrzuci
  // kwotę, operator czyta TEKST InPostu (bez tokenu), a panel niczego nie nadał.
  it('ShipX odrzuca kwotę cod → operator widzi powód od InPostu, bez tokenu', async () => {
    const t = przygotuj({ umowa: true, shipx: () => ({ ok: false, status: 400, dane: {
      status: 400, error: 'validation_failed', message: 'There are some validation errors.',
      details: { cod: { amount: ['less_than_or_equal_to'] } },
    } }) });
    const wynik = await t.nadaj().catch((blad) => blad);
    expect(wynik).toMatchObject({ dlaOperatora: true });
    expect(wynik.message).toContain('InPost odrzucił przesyłkę');
    expect(wynik.message).toContain('There are some validation errors.');
    expect(wynik.message).toContain('less_than_or_equal_to');
    expect(wynik.message).not.toContain(TOKEN);
    expect(wynik.message).not.toContain('DPD');
    expect(t.przesylki()).toMatchObject([{ status: 'blad', kolejnosc: 2 }]);
  });
});
