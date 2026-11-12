import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createErliPrzesylkiClient } from '../../../src/oms/kurierzy/erli.js';
import { createAtrapaErli } from '../../../deploy/proba/atrapy/erli.mjs';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie, pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { mapujZamowienieErli } from '../../../src/domena/erli-mapowanie.js';
import { createNadanie } from '../../../src/moduly/wysylka/services/nadanie.js';
import { rozpocznijPrzesylke, oznaczTworzonaUKuriera, pobierzPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { stanPrzesylki, sprawyPrzesylki } from '../../../src/domena/przesylka-stan.js';

// PRZ-157.08 — kurier „Przesyłki Erli”. ⚠️ Zero sieci: klient ERLI to atrapa `vi.fn`
// albo atrapa z deploy/proba (fetch w pamięci). Dane zmyślone (Pracownia Półcień).

const ODBIORCA = { firstName: 'Ada', lastName: 'Przykładowa', street: 'Zmyślona', buildingNumber: '1',
  city: 'Warszawa', zip: '00-001', country: 'pl', pickupType: 'point', pointCode: 'PC001',
  phoneNumber: '500100200', email: 'ada@polcien.example' };

const surowe = (nad = {}) => ({
  id: 'PC-ERLI-0003', totalPrice: 21290, status: 'purchased',
  delivery: { typeId: 'erliPaczkomat', cod: false, price: 1000 }, ...nad,
});
const zamowienie = (sur = surowe()) => ({ id: 7, numer: String(sur.id), zrodlo_id: String(sur.id), sklep: 'erli-polcien', surowe_json: JSON.stringify(sur) });

const paczkaZErli = (nad = {}) => ({ id: 41, type: 'internal', orderId: 'PC-ERLI-0003', status: 'preparing',
  dimensions: { width: 380, height: 80, length: 640, weight: 1200 },
  shipping: { typeId: 'erliPaczkomat', receiver: ODBIORCA, registeredAt: '2026-11-11T10:00:00Z' },
  createdAt: '2026-11-11T10:00:00Z', updatedAt: '2026-11-11T10:00:00Z', ...nad });

function klientErli({ istniejace = [], odpowiedz = [paczkaZErli()] } = {}) {
  return {
    szukajPaczek: vi.fn().mockResolvedValue(istniejace),
    utworzPaczki: vi.fn().mockResolvedValue(odpowiedz),
    pobierzEtykiete: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 etykieta')),
  };
}
const kurier = (erli, punkt = () => null) => createErliPrzesylkiClient({ erliDla: () => erli, punktNadaniaDla: punkt });

describe('PRZ-157.08 — nadanie przez POST /shipping/parcels/', () => {
  it('wysyła orderId, typeId z zamówienia, punkt nadania i wymiary gabarytu w mm/g; wynik czeka na etykietę', async () => {
    const erli = klientErli();
    const wynik = await kurier(erli, () => 7).nadaj({ zamowienie: zamowienie(), paczka: { waga: 1.2, gabaryt: 'B' }, kolejnosc: 1 });
    expect(erli.szukajPaczek).toHaveBeenCalledWith({ filter: { field: 'orderId', operator: '=', value: 'PC-ERLI-0003' } });
    expect(erli.utworzPaczki).toHaveBeenCalledWith([{ orderId: 'PC-ERLI-0003',
      dimensions: { length: 640, width: 380, height: 190, weight: 1200 },
      shipping: { typeId: 'erliPaczkomat', postingPointId: 7 } }]);
    expect(wynik).toMatchObject({ shipmentId: '41', numerListu: null, wTrakcieTworzenia: true, etykietaPdf: null, etykietaZpl: null });
    expect(erli.pobierzEtykiete).not.toHaveBeenCalled();
  });

  it('wymiary z karty (cm → mm), bez punktu nadania nie wysyła postingPointId, nonStandard tylko gdy zaznaczone', async () => {
    const erli = klientErli();
    const paczka = { waga: 2.5, dlugosc: 110, szerokosc: 75, wysokosc: 1 };
    await kurier(erli).nadaj({ zamowienie: zamowienie(surowe({ delivery: { typeId: 'erliKurier24InPost10kg', cod: false } })), paczka });
    await kurier(erli).nadaj({ zamowienie: zamowienie(surowe({ delivery: { typeId: 'erliKurier24InPost10kg', cod: false } })), paczka: { ...paczka, niestandardowa: true } });
    expect(erli.utworzPaczki.mock.calls[0][0][0]).toEqual({ orderId: 'PC-ERLI-0003',
      dimensions: { length: 1100, width: 750, height: 10, weight: 2500 }, shipping: { typeId: 'erliKurier24InPost10kg' } });
    expect(erli.utworzPaczki.mock.calls[1][0][0].shipping).toEqual({ typeId: 'erliKurier24InPost10kg', nonStandard: true });
  });

  it('bez typeId w zamówieniu odmawia przed POST', async () => {
    const erli = klientErli();
    await expect(kurier(erli).nadaj({ zamowienie: zamowienie(surowe({ delivery: { cod: false } })), paczka: { waga: 1, gabaryt: 'A' } }))
      .rejects.toThrow(/metody dostawy ERLI/);
    expect(erli.utworzPaczki).not.toHaveBeenCalled();
  });

  it('błąd z errors[] → wyjątek z kodem i identyfikatorem paczki (sprawa na karcie)', async () => {
    const erli = klientErli({ odpowiedz: [paczkaZErli({ status: 'error', errors: [{ errorCode: 1102, errorMessage: 'Nie udało się nadać paczki' }] })] });
    const blad = await kurier(erli).nadaj({ zamowienie: zamowienie(), paczka: { waga: 1, gabaryt: 'A' } }).catch(e => e);
    expect(blad.message).toMatch(/1102 — Nie udało się nadać paczki/);
    expect(blad).toMatchObject({ shipmentId: '41', dlaOperatora: true });
  });
});

describe('PRZ-157.08 — sprawdzenie: etykieta dopiero, gdy są i waybills[], i numer', () => {
  it.each([
    ['jest trackingNumber, brak waybills', { trackingNumber: 'PC000000000000000000000041' }],
    ['są waybills, brak trackingNumber', { shipping: { typeId: 'erliPaczkomat', receiver: ODBIORCA, waybills: ['https://x.example/e.pdf'] } }],
  ])('%s → nadal w trakcie tworzenia, bez pobierania etykiety', async (_n, nad) => {
    const erli = klientErli({ istniejace: [paczkaZErli(nad)] });
    expect(await kurier(erli).sprawdzPrzesylke('41', zamowienie()))
      .toMatchObject({ shipmentId: '41', numerListu: null, wTrakcieTworzenia: true, etykietaPdf: null });
    expect(erli.pobierzEtykiete).not.toHaveBeenCalled();
  });
});

describe('PRZ-157.08 — pobranie i druga paczka', () => {
  const cod = () => zamowienie(surowe({ id: 'PC-ERLI-0002', delivery: { typeId: 'erliKurier24InPost10kg', cod: true } }));

  it('pobranie: kwota z zamówienia przechodzi, żądanie nie niesie własnej kwoty', async () => {
    const erli = klientErli();
    await kurier(erli).nadaj({ zamowienie: cod(), paczka: { waga: 1, gabaryt: 'A' }, kwotaPobrania: '212.90', pobranieNaTejPaczce: true });
    expect(JSON.stringify(erli.utworzPaczki.mock.calls[0][0])).not.toMatch(/cod|kwot|amount/i);
  });

  it.each([
    ['inna kwota niż zamówienie', { zamowienie: 'cod', kwotaPobrania: '100.00', pobranieNaTejPaczce: true }, /pobiera kwotę z zamówienia \(212\.90 zł\)/],
    ['pobranie przy zamówieniu opłaconym', { zamowienie: 'zwykle', kwotaPobrania: '212.90', pobranieNaTejPaczce: true }, /zamówienie w ERLI nie jest za pobraniem/],
    ['pobranie na drugiej paczce', { zamowienie: 'cod', kwotaPobrania: '212.90', pobranieNaTejPaczce: true, kolejnosc: 2 }, /tylko na pierwszej paczce/],
    // Poprawki po recenzji: pobranie sprawdzane w obie strony i waluta (D3 — zamówienie spoza PLN ręcznie).
    ['COD w ERLI, OMS bez pobrania', { zamowienie: 'cod', kwotaPobrania: null, pobranieNaTejPaczce: false }, /za pobraniem w ERLI.*bez pobrania/],
    ['COD w ERLI, OMS bez kwoty pobrania', { zamowienie: 'cod', kwotaPobrania: null, pobranieNaTejPaczce: true }, /za pobraniem w ERLI.*bez pobrania/],
    ['zamówienie w EUR bez pobrania', { zamowienie: 'eur', kwotaPobrania: null, pobranieNaTejPaczce: false }, /walucie EUR/],
    ['zamówienie w EUR za pobraniem', { zamowienie: 'eur-cod', kwotaPobrania: '49.90', pobranieNaTejPaczce: true }, /walucie EUR/],
  ])('odmowa: %s — bez POST', async (_n, { zamowienie: rodzaj, ...opcje }, blad) => {
    const erli = klientErli({ istniejace: [paczkaZErli()] });
    const zamowienia = {
      cod, zwykle: () => zamowienie(),
      eur: () => zamowienie(surowe({ id: 'PC-ERLI-0005', market: 'de', currency: 'EUR', totalPrice: 4990 })),
      'eur-cod': () => zamowienie(surowe({ id: 'PC-ERLI-0005', market: 'de', currency: 'EUR', totalPrice: 4990, delivery: { typeId: 'erliKurier24InPost10kg', cod: true } })),
    };
    await expect(kurier(erli).nadaj({ zamowienie: zamowienia[rodzaj](), paczka: { waga: 1, gabaryt: 'A' }, ...opcje }))
      .rejects.toThrow(blad);
    expect(erli.utworzPaczki).not.toHaveBeenCalled();
  });

  it('COD w ERLI: druga paczka bez pobrania przechodzi (ERLI pobiera na pierwszej)', async () => {
    const pierwsza = paczkaZErli({ orderId: 'PC-ERLI-0002' });
    const erli = klientErli({ istniejace: [pierwsza] });
    await kurier(erli).nadaj({ zamowienie: cod(), paczka: { waga: 1, gabaryt: 'A' }, kolejnosc: 2, kwotaPobrania: null, pobranieNaTejPaczce: false });
    expect(erli.utworzPaczki).toHaveBeenCalledTimes(1);
  });

  it('druga paczka dostaje adres odbiorcy pierwszej', async () => {
    const pierwsza = paczkaZErli({ shipping: { typeId: 'erliPaczkomat', receiver: { ...ODBIORCA, pointCode: 'PC009' }, registeredAt: '2026-11-11T10:00:00Z', waybills: ['https://x.example/e.pdf'] } });
    const erli = klientErli({ istniejace: [pierwsza] });
    await kurier(erli).nadaj({ zamowienie: zamowienie(), paczka: { waga: 1, gabaryt: 'A' }, kolejnosc: 2, pobranieNaTejPaczce: false });
    expect(erli.utworzPaczki.mock.calls[0][0][0].shipping).toEqual({ typeId: 'erliPaczkomat', receiver: { ...ODBIORCA, pointCode: 'PC009' } });
  });

  it('nie robi duplikatu: paczka o tym numerze już jest w ERLI; druga bez pierwszej → odmowa', async () => {
    const erli = klientErli({ istniejace: [paczkaZErli()] });
    await expect(kurier(erli).nadaj({ zamowienie: zamowienie(), paczka: { waga: 1, gabaryt: 'A' }, kolejnosc: 1 })).rejects.toThrow(/już ma paczkę nr 1/);
    const pusty = klientErli({ istniejace: [paczkaZErli({ status: 'canceled' })] });
    await expect(kurier(pusty).nadaj({ zamowienie: zamowienie(), paczka: { waga: 1, gabaryt: 'A' }, kolejnosc: 2 })).rejects.toThrow(/najpierw pierwszą paczkę/);
    expect(erli.utworzPaczki).not.toHaveBeenCalled();
    expect(pusty.utworzPaczki).not.toHaveBeenCalled();
  });
});

describe('PRZ-157.08 — etykieta asynchroniczna (atrapa ERLI)', () => {
  const bazy = [];
  afterEach(() => { for (const db of bazy.splice(0)) db.close(); });

  async function zestaw() {
    const dbAtrapy = new DatabaseSync(':memory:'); bazy.push(dbAtrapy);
    const atrapa = createAtrapaErli({ db: dbAtrapy, kanal: 'polcien', env: { OMS_TRYB: 'proba' }, teraz: () => new Date('2026-11-11T10:00:00Z') });
    const sur = await atrapa.pobierzZamowienie('PC-ERLI-0003');
    const db = openOmsDb(':memory:');
    const id = Number(zapiszZamowienie(db, 'erli-polcien', mapujZamowienieErli(sur), sur));
    const kurierErli = kurier(atrapa);
    const katalogEtykiet = mkdtempSync(join(tmpdir(), 'erli-etykiety-'));
    const nadanie = createNadanie({ db, kurierzy: { erli_przesylki: kurierErli }, klienci: {}, katalogEtykiet });
    const wynik = await kurierErli.nadaj({ zamowienie: pobierzZamowienie(db, id), paczka: { waga: 1.2, gabaryt: 'A' }, kolejnosc: 1 });
    const prz = rozpocznijPrzesylke(db, id, 'erli_przesylki');
    const przesylkaId = Number(prz?.id ?? prz);
    oznaczTworzonaUKuriera(db, przesylkaId, { idPrzesylkiKuriera: wynik.shipmentId });
    return { db, nadanie, przesylkaId, wynik, atrapa };
  }

  it('„oczekuje”, dopóki _search nie odda waybills[], potem PDF na dysku i numer śledzenia', async () => {
    const { db, nadanie, przesylkaId, wynik } = await zestaw();
    expect(wynik).toMatchObject({ wTrakcieTworzenia: true, numerListu: null });
    expect(await nadanie.sprawdzPonownie(przesylkaId)).toMatchObject({ wTrakcieTworzenia: true, numerListu: null });
    expect(stanPrzesylki(pobierzPrzesylke(db, przesylkaId))).toBe('tworzona_u_kuriera');
    expect(sprawyPrzesylki(pobierzPrzesylke(db, przesylkaId))).toContain('przesyłka tworzona u kuriera');

    const numer = `PC${String(wynik.shipmentId).padStart(22, '0')}`;
    expect(await nadanie.sprawdzPonownie(przesylkaId)).toEqual({ numerListu: numer });
    const p = pobierzPrzesylke(db, przesylkaId);
    expect(p.status).toBe('nadana');
    expect(p.numer_listu).toBe(numer);
    expect(existsSync(p.etykieta_sciezka)).toBe(true);
    expect(readFileSync(p.etykieta_sciezka).subarray(0, 5).toString()).toBe('%PDF-');
    expect(p.etykieta_zpl_sciezka).toBeNull();
  });

  it('errors[] przy sprawdzeniu → opis z kodem na przesyłce i sprawa „tworzona u kuriera”', async () => {
    const { db, nadanie, przesylkaId, atrapa } = await zestaw();
    const szukaj = atrapa.szukajPaczek;
    atrapa.szukajPaczek = async (q) => (await szukaj(q)).map(p => ({ ...p, status: 'error', errors: [{ errorCode: 1103, errorMessage: 'Punkt nadania nieaktywny' }] }));
    await expect(nadanie.sprawdzPonownie(przesylkaId)).rejects.toThrow(/1103 — Punkt nadania nieaktywny/);
    const p = pobierzPrzesylke(db, przesylkaId);
    expect(p.blad_opis).toMatch(/1103/);
    expect(sprawyPrzesylki(p)).toContain('przesyłka tworzona u kuriera');
  });
});
