import { describe, it, expect, vi } from 'vitest';
import { createErliPrzesylkiClient } from '../../../src/oms/kurierzy/erli.js';
import { etapPrzesylki } from '../../../src/domena/etap-przesylki.js';
import { sprawyPrzesylki, mozliweUkrycie } from '../../../src/domena/przesylka-stan.js';
import { sprawyKarty } from '../../../src/domena/sprawy-karty.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { rozpocznijPrzesylke, zakonczPrzesylke, pobierzPrzesylke } from '../../../src/moduly/wysylka/db/przesylki.js';
import { createCzuwaczPrzesylek } from '../../../src/moduly/wysylka/services/czuwacz-przesylek.js';
import { createErliClient } from '../../../src/oms/erli/client.js';
import { createAtrapaErli } from '../../../deploy/proba/atrapy/erli.mjs';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const z = { sklep: 'erli-polcien' };
const zamowienie = { zrodlo_id: 'PC-ERLI-0001', numer: 'PC-ERLI-0001', klient: {}, dostawa: {}, pozycje: [],
  metoda_wysylki: 'erli_przesylki', kwota_pobrania: null, chce_fakture: 0, nip: null,
  kwota_brutto: '10.00', status_woo: 'purchased', oplacone_at: null, anulowane: 0 };
function zestaw(status, statusHistory = []) {
  const erli = { szukajPaczek: vi.fn().mockResolvedValue([{ id: 41, status, statusHistory, updatedAt: '2026-11-11T10:00:00Z' }]),
    anulujPaczke: vi.fn().mockResolvedValue({ id: 41, status: 'canceled' }),
    protokolyOdbioru: vi.fn().mockResolvedValue({ url: 'https://polcien.example/protokol.pdf' }) };
  const erliDla = vi.fn(() => erli);
  return { erli, erliDla, klient: createErliPrzesylkiClient({ erliDla }) };
}

describe('PRZ-157.09 anulowanie', () => {
  it.each(['preparing', 'readyToSend', 'waitingForCourier'])('%s: sprawdza stan i DELETE raz', async status => {
    const { klient, erli, erliDla } = zestaw(status);
    await klient.anulujPrzesylke('41', z);
    expect(erliDla).toHaveBeenCalledWith(z);
    expect(erli.szukajPaczek).toHaveBeenCalledWith({ filter: { field: 'id', operator: '=', value: 41 } });
    expect(erli.anulujPaczke).toHaveBeenCalledExactlyOnceWith('41');
  });
  it.each(['sent', 'onTheWay', 'delivered', 'returned', 'deliveryUnsuccessful', 'unknown', 'nowyStatus', 'canceled'])('%s: odmowa bez DELETE', async status => {
    const { klient, erli } = zestaw(status);
    await expect(klient.anulujPrzesylke('41', z)).rejects.toThrow(/nie można anulować/);
    expect(erli.anulujPaczke).not.toHaveBeenCalled();
  });
  it('nie anuluje po cofnięciu statusu, jeśli historia zawiera odbiór', async () => {
    const { klient, erli } = zestaw('readyToSend', [{ status: 'sent' }]);
    await expect(klient.anulujPrzesylke('41', z)).rejects.toThrow(/nie można anulować/);
    expect(erli.anulujPaczke).not.toHaveBeenCalled();
  });
  it.each(['szukajPaczek', 'anulujPaczke'])('błąd %s nie ujawnia odpowiedzi', async metoda => {
    const { klient, erli } = zestaw('readyToSend');
    erli[metoda].mockRejectedValue(new Error('treść odpowiedzi prywatna'));
    const blad = await klient.anulujPrzesylke('41', z).catch(e => e);
    expect(blad).toMatchObject({ dlaOperatora: true });
    expect(blad.message).toMatch(/ERLI/);
    expect(blad.message).not.toContain('prywatna');
  });
});

const etapy = { preparing: 'nadana', readyToSend: 'nadana', waitingForCourier: 'nadana', sent: 'w_drodze',
  onTheWay: 'w_drodze', readyToDeliver: 'w_drodze', delivered: 'doreczona', readyToPickup: 'w_drodze',
  pickupTimeExpired: 'w_drodze', returned: 'zwrot', canceled: 'nadana', claimed: 'w_drodze',
  trackingUnavailable: null, unknown: null, error: 'nadana', deliveryUnsuccessful: 'zwrot',
  redirected: 'w_drodze', technical: null, trackingExpired: null, nowyStatus: null };
describe('PRZ-157.09 statusy', () => {
  it.each(Object.entries(etapy))('%s → %s', async (status, etap) => {
    const { klient, erliDla } = zestaw(status);
    const wynik = await klient.statusPrzesylki('41', { kanal: z.sklep });
    expect(erliDla).toHaveBeenCalledWith(z);
    expect(wynik ? etapPrzesylki(wynik.opis, wynik.kod) : null).toBe(etap);
    if (etap === 'zwrot') {
      const p = { status: 'nadana', kurier: 'erli_przesylki', etykieta_sciezka: '/p.pdf', status_kuriera: wynik.opis };
      expect(sprawyPrzesylki(p)).toContain('zwrot przesyłki');
      expect(sprawyKarty({ przesylki: [p] })).toContainEqual(expect.objectContaining({ klucz: 'przesylka', tekst: 'zwrot przesyłki' }));
    }
  });
  it('czuwacz zapisuje doręczenie po id paczki, zachowuje etap przy nieznanym i przestaje pytać doręczoną', async () => {
    const db = openOmsDb(':memory:');
    try {
      const id = zapiszZamowienie(db, z.sklep, zamowienie, {});
      const p = rozpocznijPrzesylke(db, id, 'erli_przesylki');
      zakonczPrzesylke(db, p.id, { idPrzesylkiKuriera: '41', numerListu: 'PC41', etykietaSciezka: '/p.pdf', surowa: '{}' });
      const { klient, erli } = zestaw('sent');
      let czas = new Date();
      const czuwacz = createCzuwaczPrzesylek({ db, kurierzy: { erli_przesylki: klient }, teraz: () => czas });
      await czuwacz.przebieg();
      expect(etapPrzesylki(pobierzPrzesylke(db, p.id).status_kuriera)).toBe('w_drodze');
      erli.szukajPaczek.mockResolvedValue([{ id: 41, status: 'nowyStatus' }]);
      czas = new Date(Date.now() + 7200000);
      await czuwacz.przebieg();
      expect(etapPrzesylki(pobierzPrzesylke(db, p.id).status_kuriera)).toBe('w_drodze');
      erli.szukajPaczek.mockResolvedValue([{ id: 41, status: 'delivered' }]);
      await czuwacz.przebieg();
      expect(etapPrzesylki(pobierzPrzesylke(db, p.id).status_kuriera)).toBe('doreczona');
      erli.szukajPaczek.mockClear();
      expect(await czuwacz.przebieg()).toMatchObject({ kandydatow: 0 });
      expect(erli.szukajPaczek).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
});

describe('PRZ-157.09 protokół', () => {
  it('zwraca dokument z klienta HTTP i atrapy', async () => {
    const db = openOmsDb(':memory:');
    try {
      const atrapa = createAtrapaErli({ db, kanal: z.sklep, env: { OMS_TRYB: 'proba' } });
      const erli = createErliClient({ kluczApi: 'testowy', adresApi: 'https://sklep.polcien.example', fetchImpl: atrapa.fetchImpl });
      const [p] = await erli.utworzPaczki([{ orderId: 'PC-ERLI-0001', dimensions: { width: 100, height: 100, length: 100, weight: 1000 }, shipping: { typeId: 'erliPaczkomat' } }]);
      const klient = createErliPrzesylkiClient({ erliDla: () => erli });
      expect(await klient.protokolOdbioru(String(p.id), z)).toEqual({ url: expect.stringContaining('/protokoly/') });
    } finally { db.close(); }
  });
  it.each(['javascript:alert(1)', 'http://polcien.example/p.pdf', 'brak'])('odrzuca niebezpieczny URL %s', async url => {
    const { klient, erli } = zestaw('sent');
    erli.protokolyOdbioru.mockResolvedValue({ url });
    await expect(klient.protokolOdbioru('41', z)).rejects.toThrow(/protok/);
  });
  it('PRZESYŁKI udostępniają dokument przez adapter właściwego kanału', async () => {
    const db = openOmsDb(':memory:');
    const { klient, erli } = zestaw('readyToSend');
    const app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'test' } }, kurierzy: { erli_przesylki: klient } });
    const headers = { authorization: `Basic ${Buffer.from('operator:test').toString('base64')}` };
    try {
      const id = zapiszZamowienie(db, z.sklep, zamowienie, {});
      const p = rozpocznijPrzesylke(db, id, 'erli_przesylki');
      zakonczPrzesylke(db, p.id, { idPrzesylkiKuriera: '41', numerListu: 'PC41', etykietaSciezka: '/p.pdf', surowa: '{}' });
      const lista = await app.inject({ url: '/przesylki', headers });
      expect(lista.statusCode).toBe(200);
      expect(lista.body).toContain(`href="/przesylki/${p.id}/protokol"`);
      expect(lista.body).toContain('Protokół odbioru');
      const dokument = await app.inject({ url: `/przesylki/${p.id}/protokol`, headers });
      expect(dokument.statusCode).toBe(302);
      expect(dokument.headers.location).toBe('https://polcien.example/protokol.pdf');
      expect(erli.protokolyOdbioru).toHaveBeenCalledExactlyOnceWith(['41']);
      erli.protokolyOdbioru.mockRejectedValue(new Error('prywatna odpowiedź'));
      const blad = await app.inject({ url: `/przesylki/${p.id}/protokol`, headers });
      expect(blad.statusCode).toBe(400);
      expect(blad.body).not.toContain('prywatna');
    } finally { await app.close(); db.close(); }
  });
});

describe('PRZ-157.09 sprawa zwrotu tylko dla Przesyłek Erli', () => {
  const zwrot = { status: 'nadana', etykieta_sciezka: '/p.pdf', status_kuriera: 'Zwrot przesyłki', status_kuriera_at: '2026-11-10T10:00:00Z' };
  it('zwrot InPost/DPD nie daje sprawy (jak przed zmianą)', () => {
    for (const kurier of ['inpost', 'dpd', 'allegro', 'wza']) expect(sprawyPrzesylki({ ...zwrot, kurier })).not.toContain('zwrot przesyłki');
  });
  it('zwrot ERLI daje sprawę, „Ukryj” jest dostępne przy jedynej paczce i zamyka sprawę', () => {
    const p = { ...zwrot, kurier: 'erli_przesylki', kolejnosc: 1 };
    expect(sprawyPrzesylki(p)).toContain('zwrot przesyłki');
    expect(mozliweUkrycie(p, [p])).toBe(true);
    expect(sprawyPrzesylki({ ...p, ukryta_at: '2026-11-10T11:00:00Z' })).not.toContain('zwrot przesyłki');
  });
});
