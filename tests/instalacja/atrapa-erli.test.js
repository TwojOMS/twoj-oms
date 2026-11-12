import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createErliClient } from '../../src/oms/erli/client.js';
import { createAtrapaErli, surowaOdpowiedzErli } from '../../deploy/proba/atrapy/erli.mjs';
import { PRODUKTY } from '../../scripts/demo-dane-firma.mjs';

const bazy = [];
const opcje = () => {
  const db = new DatabaseSync(':memory:'); bazy.push(db);
  return { db, kanal: 'polcien', env: { OMS_TRYB: 'proba' }, teraz: () => new Date('2026-11-11T10:00:00Z') };
};
afterEach(() => { for (const db of bazy.splice(0)) db.close(); });
const metody = o => Object.keys(o).filter(k => typeof o[k] === 'function');
const tekstPdf = b => [...b.toString('latin1').matchAll(/\[([^\]]*)\]\s*TJ/g)]
  .map(m => [...m[1].matchAll(/<([0-9a-f]+)>/gi)].map(h => Buffer.from(h[1], 'hex').toString('latin1')).join('')).join('\n');
const paczka = orderId => ({ orderId, dimensions: { width: 100, height: 100, length: 100, weight: 1000 },
  shipping: { typeId: 'erliPaczkomat', sender: adres(), receiver: adres() } });
const adres = () => ({ firstName: 'Ada', lastName: 'Przykładowa', street: 'Zmyślona', buildingNumber: '1',
  city: 'Warszawa', zip: '00-001', country: 'pl', pickupType: 'point', pointCode: 'PC001', phoneNumber: '500100200', email: 'ada@polcien.example' });

describe('PRZ-157.03a — atrapa ERLI', () => {
  it('demo ma płatność PayU, katalog lamp, paczkomat i daty względne od resetu', async () => {
    const o = opcje(); const a = createAtrapaErli(o); const z = await a.szukajZamowien();
    expect(z[0].payment).toMatchObject({ status: 'COMPLETED' });
    expect(z[5].payment).toMatchObject({ status: 'PENDING' });
    expect(z[1].delivery.cod).toBe(true);
    expect(z[2].delivery).toMatchObject({ typeId: 'erliPaczkomat', pickupPlace: { externalId: 'PC001' } });
    expect(z[3].delivery.typeId).toBe('dpd');
    expect(z[10].delivery.typeId).toBe('nieznanaMetoda');
    expect(z[0].items[0]).toMatchObject({ externalId: 'PC-OF-1', sku: PRODUKTY[0].sku, name: PRODUKTY[0].nazwa, unitPrice: PRODUKTY[0].cena_gr });
    expect(new Set(z.map(z => z.totalPrice)).size).toBeGreaterThan(5);
    expect(z[0].purchasedAt).toBe('2026-11-11T08:00:00.000Z');
    expect((await createAtrapaErli({ ...o, kanal: 'reset', teraz: () => new Date('2026-11-12T10:00:00Z') }).szukajZamowien())[0].purchasedAt).toBe('2026-11-12T08:00:00.000Z');
  });
  it('ma każdą metodę klienta i wymaga trybu próby', () => {
    const o = opcje(); const a = createAtrapaErli(o);
    expect(metody(createErliClient()).filter(m => !metody(a).includes(m))).toEqual([]);
    expect(() => createAtrapaErli({ ...o, env: {} })).toThrow('OMS_TRYB=proba');
  });
  it('surowe odpowiedzi zamówienia, paczek i metod są zgodne z klientem', async () => {
    const a = createAtrapaErli(opcje());
    for (const [metoda, args] of [['pobierzZamowienie', ['PC-ERLI-0001']], ['szukajPaczek', [{ filter: { field: 'orderId', operator: '=', value: 'brak' } }]], ['metodyErli', []]]) {
      const wynik = await a[metoda](...args);
      const klient = createErliClient({ adresApi: 'https://sklep.polcien.example', kluczApi: 'atrapa-polcien', fetchImpl: async () => surowaOdpowiedzErli(wynik) });
      expect(await klient[metoda](...args)).toEqual(wynik);
    }
  });
  it('kolejka obsługuje ids i lastMessageId, zachowuje stan i rozdziela kanały', async () => {
    const o = opcje(); const a = createAtrapaErli(o); const zdarzenia = await a.zmianyZamowien();
    expect(new Set(zdarzenia.map(z => z.type))).toEqual(new Set(['orderCreated', 'orderStatusChanged']));
    expect(zdarzenia[0]).toMatchObject({ shopId: 1000001, read: false, payload: { id: 'PC-ERLI-0001' } });
    expect(await a.oznaczPrzeczytane({ ids: [zdarzenia[1].id] })).toBe(1);
    expect((await a.zmianyZamowien()).map(z => z.id)).not.toContain(zdarzenia[1].id);
    expect(await a.oznaczPrzeczytane({ lastMessageId: zdarzenia[2].id })).toBe(2); // [1] już przeczytane
    expect(await createAtrapaErli(o).zmianyZamowien()).toEqual(zdarzenia.slice(3));
    expect(await createAtrapaErli({ ...o, kanal: 'drugi' }).zmianyZamowien()).toHaveLength(zdarzenia.length);
  });
  it('sandbox zwraca 404 dla changes, inbox działa, produkt uzupełnia dispatchTime', async () => {
    const a = createAtrapaErli({ ...opcje(), tryb: 'sandbox' });
    for (const m of ['zmianyZamowien', 'oznaczPrzeczytane']) await expect(a[m]({})).rejects.toMatchObject({ status: 404, message: 'ERLI: błąd HTTP 404.' });
    const z = await a.inboxSzukaj(); expect(z.length).toBeGreaterThan(0);
    expect(z[0].payload).not.toHaveProperty('market'); expect(z[0].payload.items[0]).not.toHaveProperty('dispatchTime');
    expect(await a.inboxOznacz({ lastMessageId: z.at(-1).id })).toBe(z.length); expect(await a.inboxSzukaj()).toEqual([]);
    expect(await a.pobierzProdukt('PC-OF-1')).toHaveProperty('dispatchTime.period', 2);
    expect(await a.pobierzProdukt('nieznany')).toBeNull();
    expect(await a.pobierzProdukt('PC-OF-6')).not.toHaveProperty('dispatchTime');
  });
  it('paginacja nie gubi remisów, ma szesnaście scenariuszy i nie zwraca kont bankowych', async () => {
    const a = createAtrapaErli(opcje()); const wszystkie = await a.szukajZamowien();
    expect(wszystkie).toHaveLength(16); expect(wszystkie.some(z => z.status === 'pending')).toBe(true);
    expect(wszystkie.some(z => z.delivery.cod)).toBe(true); expect(wszystkie.some(z => z.user.invoiceAddress?.nip)).toBe(true);
    const wynik = []; let after;
    for (let i = 0; i < 8; i++) { const strona = await a.szukajZamowien({ pagination: { sortField: 'updated', after, limit: 2 } }); wynik.push(...strona); after = strona.at(-1)?.cursor; }
    expect(wynik).toEqual(wszystkie); expect(JSON.stringify(wszystkie)).not.toContain('bankAccount');
    expect(await a.szukajZamowien({ pagination: { sortField: 'updated', order: 'DESC', limit: 2 } })).toEqual(wszystkie.slice(-2).reverse());
    expect(await a.szukajZamowien({ filter: { field: 'status', operator: '=', value: 'pending' } })).toEqual([wszystkie[5]]);
    await expect(a.pobierzZamowienie('brak')).rejects.toMatchObject({ status: 404 });
  });
  it('zapisuje status i paczki zewnętrzne; waliduje jak klient', async () => {
    const o = opcje(); const a = createAtrapaErli(o);
    await a.ustawStatusSprzedawcy('PC-ERLI-0001', 'sent');
    expect(o.db.prepare('SELECT status FROM atrapa_erli_statusy WHERE kanal=? AND order_id=?').get('polcien', 'PC-ERLI-0001').status).toBe('sent');
    await expect(a.ustawStatusSprzedawcy('PC-ERLI-0001', 'zly')).rejects.toThrow('Nieznany status');
    await expect(a.utworzPaczkiZewnetrzne([{ vendor: 'dpd' }])).rejects.toThrow('numeru');
    const [p] = await a.utworzPaczkiZewnetrzne([{ orderId: 'PC-ERLI-0001', vendor: 'dpd', trackingNumber: 'PC123' }]);
    expect(p).toMatchObject({ type: 'external', shipping: { vendor: 'dpd' }, trackingNumber: 'PC123' });
    expect(await a.edytujPaczkeZewnetrzna(p.id, { vendor: 'dpd', trackingNumber: 'PC456' })).toHaveProperty('trackingNumber', 'PC456');
    await a.usunPaczkeZewnetrzna(p.id);
    await expect(a.edytujPaczkeZewnetrzna(p.id, { vendor: 'selfPickup' })).rejects.toMatchObject({ status: 404 });
  });
  it('etykieta dopiero w drugim wyszukaniu konkretnej paczki, PDF ma czerwone ATRAPA', async () => {
    const o = opcje(); const a = createAtrapaErli(o); const [p, drugi] = await a.utworzPaczki([paczka('PC-ERLI-0001'), paczka('PC-ERLI-0002')]);
    expect(p.status).toBe('preparing'); expect(p.shipping.waybills).toBeUndefined();
    expect(p.trackingNumber).toBeUndefined();
    const query = id => ({ filter: { field: 'id', operator: '=', value: id } });
    const pierwsza = (await a.szukajPaczek(query(p.id)))[0];
    expect(pierwsza.shipping.waybills).toBeUndefined(); expect(pierwsza.trackingNumber).toBeUndefined();
    const gotowa = (await createAtrapaErli(o).szukajPaczek(query(p.id)))[0];
    expect(gotowa.shipping.waybills).toHaveLength(1);
    expect(gotowa.trackingNumber).toMatch(/^PC/);
    expect((await a.szukajPaczek(query(drugi.id)))[0].shipping.waybills).toBeUndefined();
    const pdf = await a.pobierzEtykiete(gotowa.shipping.waybills[0]);
    expect(Buffer.isBuffer(pdf)).toBe(true); expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(tekstPdf(pdf).split('\n')).toContain('ATRAPA'); expect(pdf.toString('latin1')).toContain('1 0 0 scn');
    const protokol = await a.protokolyOdbioru([p.id]);
    expect(protokol).toHaveProperty('url');
    expect(tekstPdf(await a.pobierzEtykiete(protokol.url))).toContain('ATRAPA');
    expect(await a.anulujPaczke(p.id)).toMatchObject({ id: p.id, status: 'canceled' }); expect((await a.szukajPaczek(query(p.id)))[0].status).toBe('canceled');
    await expect(a.pobierzEtykiete(gotowa.shipping.waybills[0])).rejects.toMatchObject({ status: 404 });
    expect((await a.szukajPaczek(query(p.id)))[0].shipping.waybills).toBeUndefined();
    await expect(a.utworzPaczki([])).rejects.toThrow('1 do 100');
  });
  it('udostępnia obie rodziny słowników i 429 tylko przez zadany czas', async () => {
    const a = createAtrapaErli(opcje()); expect(await a.mojSklep()).toMatchObject({ id: 1000001, name: 'pracownia-polcien' }); // wzorzec name ze specyfikacji: bez spacji
    expect((await a.metodyErli()).map(m => m.id)).toEqual(expect.arrayContaining(['erliPaczkomat', 'erliKurier24InPost10kg']));
    expect((await a.metodyDostawy()).map(m => m.vendor)).toEqual(expect.arrayContaining(['dpd', 'inpost', 'selfPickup', 'ownTransport']));
    expect((await a.metodyDostawy({ vendor: 'dpd' })).every(m => m.vendor === 'dpd')).toBe(true);
    expect(await a.metodyErli({ id: 'erliPaczkomat', cod: false })).toHaveLength(1);
    expect(await a.metodyErli({ groupId: 'erliKurier24InPost', cod: true })).toHaveLength(1);
    expect(await a.metodyDostawy({ id: 'paczkomat' })).toHaveLength(1);
    expect(await a.punktyNadania({ id: 999 })).toEqual([]);
    expect((await a.cennikiDostawSzczegoly())[0].prices[0].deliveryMethod).toHaveProperty('id', 'erliPaczkomat');
    for (const m of ['cennikiDostaw', 'cennikiDostawSzczegoly', 'punktyNadania']) expect((await a[m]()).length).toBeGreaterThan(0);
    a.wymus429(2); for (let i = 0; i < 2; i++) await expect(a.mojSklep()).rejects.toMatchObject({ kod: 'ERLI_429', status: 429, retryAfterS: 5 });
    await expect(a.mojSklep()).resolves.toHaveProperty('id', 1000001);
  });
});
