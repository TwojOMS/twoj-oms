import { describe, it, expect, vi } from 'vitest';
import { createErliAdapter, stanErliWPamieci } from '../../../src/oms/erli/adapter.js';

// PRZ-157.04 — adapter kanału ERLI (D1, D6). Klient podstawiony w teście, dane zmyślone.
const TERAZ = new Date('2026-11-13T12:00:00Z');

const zam = (id, zmiany = {}) => ({
  id, status: 'purchased', currency: 'PLN', market: 'pl', totalPrice: 1000,
  created: '2026-11-13T09:00:00Z', updated: '2026-11-13T09:05:00Z', purchasedAt: '2026-11-13T09:01:00Z',
  user: { email: 'ala@polcien.example', deliveryAddress: { firstName: 'Ala', lastName: 'Zmyślonowicz', street: 'Fikcyjna', buildingNumber: '1', city: 'Testowo', country: 'pl', zip: '00-000', phone: '000000000' } },
  delivery: { name: 'Kurier testowy', typeId: 'kurierTestowy', price: 0, cod: false },
  items: [{ id: 1, externalId: 'PC-OF-001', quantity: 1, unitPrice: 1000, name: 'Szablon', slug: 'szablon', taxRate: 'TAX_23', dispatchTime: { period: 1, unit: 'day' } }],
  ...zmiany,
});
const wiad = (id, payload, type = 'orderCreated') => ({ id, shopId: 1000001, created: '2026-11-13T09:06:00Z', read: false, type, payload });

function klientAtrapa({ zmiany = [], inbox = [], zmiany404 = false, strony = [], produkty = {} } = {}) {
  const k = {
    zmianyZamowien: vi.fn(async () => {
      if (zmiany404) { const e = new Error('ERLI: nie znaleziono (HTTP 404)'); e.status = 404; throw e; }
      return zmiany;
    }),
    oznaczPrzeczytane: vi.fn(async () => 1),
    inboxSzukaj: vi.fn(async () => inbox),
    inboxOznacz: vi.fn(async () => 1),
    szukajZamowien: vi.fn(async (dane) => {
      const after = dane?.pagination?.after ?? null;
      return strony.find((s) => s.after === after)?.zamowienia ?? [];
    }),
    pobierzProdukt: vi.fn(async (id) => produkty[id] ?? null),
  };
  return k;
}

const uzgodnione = () => stanErliWPamieci({ uzgodnienieAt: TERAZ.toISOString(), uzgodnienieKursor: 'k0' });

describe('adapter ERLI — tor główny /orders/changes (D1)', () => {
  it('ta sama wiadomość dwa razy w paczce → jedno zamówienie (ostatnia wersja)', async () => {
    const klient = klientAtrapa({ zmiany: [
      wiad('m1', zam('PC-ERLI-0001')),
      wiad('m2', zam('PC-ERLI-0001', { status: 'cancelled', updated: '2026-11-13T10:00:00Z' }), 'orderStatusChanged'),
    ] });
    const a = createErliAdapter({ klient, stan: uzgodnione(), teraz: () => TERAZ });
    const { zamowienia, stron } = await a.pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(stron).toBe(1);
    expect(zamowienia.map((z) => z.id)).toEqual(['PC-ERLI-0001']);
    expect(zamowienia[0].status).toBe('cancelled');
  });

  it('potwierdz oznacza przeczytane do ostatniej wiadomości dopiero na żądanie', async () => {
    const klient = klientAtrapa({ zmiany: [wiad('m1', zam('PC-ERLI-0001')), wiad('m2', zam('PC-ERLI-0002'))] });
    const a = createErliAdapter({ klient, stan: uzgodnione(), teraz: () => TERAZ });
    await a.pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(klient.oznaczPrzeczytane).not.toHaveBeenCalled();
    await a.potwierdz();
    expect(klient.oznaczPrzeczytane).toHaveBeenCalledWith({ lastMessageId: 'm2' });
    expect(klient.inboxOznacz).not.toHaveBeenCalled();
  });

  it('pusta paczka zmian → nic do oznaczenia', async () => {
    const klient = klientAtrapa();
    const a = createErliAdapter({ klient, stan: uzgodnione(), teraz: () => TERAZ });
    await a.pobierzStrone({ od: null, kursor: null, strona: 1 });
    await a.potwierdz();
    expect(klient.oznaczPrzeczytane).not.toHaveBeenCalled();
  });
});

describe('adapter ERLI — 404 na /orders/changes → /inbox (D1)', () => {
  it('przechodzi na inbox, zapisuje wybór toru i potwierdza przez inbox', async () => {
    const stan = uzgodnione();
    const klient = klientAtrapa({ zmiany404: true, inbox: [wiad('i7', zam('PC-ERLI-0003'))] });
    const a = createErliAdapter({ klient, stan, teraz: () => TERAZ });
    const { zamowienia } = await a.pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(zamowienia.map((z) => z.id)).toEqual(['PC-ERLI-0003']);
    expect(stan.wczytaj().tor).toBe('inbox');
    expect(a.tor()).toBe('inbox');
    await a.potwierdz();
    expect(klient.inboxOznacz).toHaveBeenCalledWith({ lastMessageId: 'i7' });
    expect(klient.oznaczPrzeczytane).not.toHaveBeenCalled();
  });

  it('zapisany tor inbox → następny przebieg nie pyta już o /orders/changes', async () => {
    const klient = klientAtrapa({ zmiany404: true });
    const a = createErliAdapter({ klient, stan: stanErliWPamieci({ ...uzgodnione().wczytaj(), tor: 'inbox' }), teraz: () => TERAZ });
    await a.pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(klient.zmianyZamowien).not.toHaveBeenCalled();
    expect(klient.inboxSzukaj).toHaveBeenCalledTimes(1);
  });

  it('inny błąd niż 404 nie przełącza toru', async () => {
    const stan = uzgodnione();
    const klient = klientAtrapa();
    klient.zmianyZamowien.mockRejectedValueOnce(Object.assign(new Error('ERLI: błąd (HTTP 500)'), { status: 500 }));
    const a = createErliAdapter({ klient, stan, teraz: () => TERAZ });
    await expect(a.pobierzStrone({ od: null, kursor: null, strona: 1 })).rejects.toThrow(/500/);
    expect(stan.wczytaj().tor).toBeUndefined();
    expect(klient.inboxSzukaj).not.toHaveBeenCalled();
  });

  it('wiadomość inbox bez zamówienia (np. productsNeedSync) jest pomijana', async () => {
    const klient = klientAtrapa({ zmiany404: true, inbox: [wiad('i1', { productId: 'PC-OF-001' }, 'productsNeedSync')] });
    const a = createErliAdapter({ klient, stan: uzgodnione(), teraz: () => TERAZ });
    const { zamowienia } = await a.pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(zamowienia).toEqual([]);
  });
});

describe('adapter ERLI — uzgodnienie orders/_search (D1)', () => {
  it('pierwsze podłączenie: strony po cursor, remis dat updated nie gubi zamówienia', async () => {
    const remis = '2026-11-13T09:05:00Z';
    const stan = stanErliWPamieci();
    const klient = klientAtrapa({ strony: [
      { after: null, zamowienia: [zam('PC-ERLI-0010', { updated: remis, cursor: 'c10' })] },
      { after: 'c10', zamowienia: [zam('PC-ERLI-0011', { updated: remis, cursor: 'c11' })] },
      { after: 'c11', zamowienia: [] },
    ] });
    const a = createErliAdapter({ klient, stan, teraz: () => TERAZ, limitUzgodnienia: 1 });
    const { zamowienia } = await a.pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(zamowienia.map((z) => z.id).sort()).toEqual(['PC-ERLI-0010', 'PC-ERLI-0011']);
    const [pierwsze] = klient.szukajZamowien.mock.calls[0];
    expect(pierwsze.pagination).toMatchObject({ sortField: 'updated', order: 'ASC', limit: 1 });
    expect(klient.szukajZamowien.mock.calls[1][0].pagination.after).toBe('c10');
    expect(stan.wczytaj().uzgodnienieKursor).toBeUndefined();
    await a.potwierdz();
    expect(stan.wczytaj()).toMatchObject({ uzgodnienieKursor: 'c11', uzgodnienieAt: TERAZ.toISOString() });
  });

  it('uzgodnienie raz na dobę: świeże nie pyta, po dobie pyta od zapisanego kursora', async () => {
    const swieze = klientAtrapa();
    await createErliAdapter({ klient: swieze, stan: stanErliWPamieci({ uzgodnienieAt: '2026-11-13T00:00:00Z', uzgodnienieKursor: 'k5' }), teraz: () => TERAZ })
      .pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(swieze.szukajZamowien).not.toHaveBeenCalled();
    const stare = klientAtrapa();
    await createErliAdapter({ klient: stare, stan: stanErliWPamieci({ uzgodnienieAt: '2026-11-12T11:59:00Z', uzgodnienieKursor: 'k5' }), teraz: () => TERAZ })
      .pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(stare.szukajZamowien.mock.calls[0][0].pagination.after).toBe('k5');
  });

  it('pierwsze uzgodnienie filtruje updated >= od (data startu kanału), nie czyta całej historii', async () => {
    const klient = klientAtrapa();
    await createErliAdapter({ klient, stan: stanErliWPamieci(), teraz: () => TERAZ })
      .pobierzStrone({ od: '2026-11-01T00:00:00Z', kursor: null, strona: 1 });
    expect(klient.szukajZamowien.mock.calls[0][0].filter).toEqual({ field: 'updated', operator: '>=', value: '2026-11-01T00:00:00Z' });
  });

  it('429 na stronie 2 uzgodnienia → zamówienie z /changes wchodzi, postęp strony 1 zostaje, błąd w stanie', async () => {
    const stan = stanErliWPamieci();
    const klient = klientAtrapa({ zmiany: [wiad('m1', zam('PC-ERLI-NOWE'))] });
    klient.szukajZamowien.mockImplementation(async (dane) => {
      if (dane.pagination.after === 'c1') throw Object.assign(new Error('ERLI: limit żądań (HTTP 429).'), { status: 429 });
      return [zam('PC-ERLI-0001', { cursor: 'c1' })];
    });
    const a = createErliAdapter({ klient, stan, teraz: () => TERAZ, limitUzgodnienia: 1 });
    const { zamowienia } = await a.pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(zamowienia.map((z) => z.id).sort()).toEqual(['PC-ERLI-0001', 'PC-ERLI-NOWE']);
    expect(stan.wczytaj().uzgodnienieBlad).toMatch(/429/);
    await a.potwierdz();
    expect(klient.oznaczPrzeczytane).toHaveBeenCalledWith({ lastMessageId: 'm1' });
    expect(stan.wczytaj()).toMatchObject({ uzgodnienieKursor: 'c1', uzgodnienieWToku: true });
    expect(stan.wczytaj().uzgodnienieAt).toBeUndefined();
    // Następny przebieg wraca do uzgodnienia od strony 2, nie od zera.
    klient.szukajZamowien.mockClear();
    klient.szukajZamowien.mockImplementation(async () => []);
    await createErliAdapter({ klient, stan, teraz: () => TERAZ, limitUzgodnienia: 1 }).pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(klient.szukajZamowien.mock.calls[0][0].pagination.after).toBe('c1');
  });

  it('limit stron uzgodnienia na przebieg: reszta w następnym przebiegu, dopiero koniec zalicza uzgodnienie', async () => {
    const stan = stanErliWPamieci();
    const klient = klientAtrapa({ strony: [
      { after: null, zamowienia: [zam('PC-ERLI-0001', { cursor: 'c1' })] },
      { after: 'c1', zamowienia: [zam('PC-ERLI-0002', { cursor: 'c2' })] },
      { after: 'c2', zamowienia: [zam('PC-ERLI-0003', { cursor: 'c3' })] },
    ] });
    const opcje = { klient, stan, teraz: () => TERAZ, limitUzgodnienia: 1, stronUzgodnieniaNaPrzebieg: 2 };
    const a = createErliAdapter(opcje);
    expect((await a.pobierzStrone({ od: null, kursor: null, strona: 1 })).zamowienia).toHaveLength(2);
    await a.potwierdz();
    expect(stan.wczytaj()).toMatchObject({ uzgodnienieKursor: 'c2', uzgodnienieWToku: true });
    const b = createErliAdapter(opcje);
    expect((await b.pobierzStrone({ od: null, kursor: null, strona: 1 })).zamowienia.map((z) => z.id)).toEqual(['PC-ERLI-0003']);
    await b.potwierdz();
    expect(stan.wczytaj()).toMatchObject({ uzgodnienieKursor: 'c3', uzgodnienieWToku: false, uzgodnienieAt: TERAZ.toISOString() });
  });

  it('zatrzymanie kanału w trakcie uzgodnienia nie jest połykane', async () => {
    const klient = klientAtrapa();
    klient.szukajZamowien.mockRejectedValue(Object.assign(new Error('zatrzymany'), { name: 'KanalZatrzymany' }));
    await expect(createErliAdapter({ klient, stan: stanErliWPamieci(), teraz: () => TERAZ })
      .pobierzStrone({ od: null, kursor: null, strona: 1 })).rejects.toThrow(/zatrzymany/);
  });

  it('ta sama zmiana z wiadomości i z uzgodnienia → jedno zamówienie', async () => {
    const klient = klientAtrapa({ zmiany: [wiad('m1', zam('PC-ERLI-0001'))], strony: [{ after: null, zamowienia: [zam('PC-ERLI-0001', { cursor: 'c1' })] }] });
    const a = createErliAdapter({ klient, stan: stanErliWPamieci(), teraz: () => TERAZ });
    const { zamowienia } = await a.pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(zamowienia).toHaveLength(1);
  });
});

describe('adapter ERLI — czas wysyłki (D6)', () => {
  it('pozycja bez dispatchTime → produkt z ERLI, potem domyślny; termin w surowych danych', async () => {
    const bezCzasu = (extId) => ({ id: extId, externalId: extId, quantity: 1, unitPrice: 1000, name: 'X', slug: 'x', taxRate: 'TAX_23' });
    const klient = klientAtrapa({
      zmiany: [wiad('m1', zam('PC-ERLI-0020', { items: [bezCzasu('PC-OF-010')] })), wiad('m2', zam('PC-ERLI-0021', { items: [bezCzasu('PC-OF-011')] }))],
      produkty: { 'PC-OF-010': { externalId: 'PC-OF-010', dispatchTime: { period: 1, unit: 'day' } } },
    });
    const a = createErliAdapter({ klient, stan: uzgodnione(), teraz: () => TERAZ, domyslnyCzasWysylki: 3 });
    const { zamowienia } = await a.pobierzStrone({ od: null, kursor: null, strona: 1 });
    const [z20, z21] = zamowienia;
    expect(klient.pobierzProdukt).toHaveBeenCalledWith('PC-OF-010');
    expect(z20._oms.termin).toEqual({ termin: '2026-11-16', przyblizony: false, zrodlo: 'produkt' });
    expect(z21._oms.termin).toEqual({ termin: '2026-11-18', przyblizony: true, zrodlo: 'domyslny' });
    // W surowych danych zamówienia tylko czasy jego własnych produktów, nie całej paczki.
    expect(Object.keys(z21._oms.czasyProduktow)).toEqual(['PC-OF-011']);
  });

  it('pozycja z dispatchTime nie pyta o produkt', async () => {
    const klient = klientAtrapa({ zmiany: [wiad('m1', zam('PC-ERLI-0001'))] });
    const a = createErliAdapter({ klient, stan: uzgodnione(), teraz: () => TERAZ });
    await a.pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(klient.pobierzProdukt).not.toHaveBeenCalled();
  });

  it('sprawy (DE/EUR) trafiają do surowych danych zamówienia', async () => {
    const klient = klientAtrapa({ zmiany: [wiad('m1', zam('PC-ERLI-0030', { market: 'de', currency: 'EUR' }))] });
    const a = createErliAdapter({ klient, stan: uzgodnione(), teraz: () => TERAZ });
    const { zamowienia } = await a.pobierzStrone({ od: null, kursor: null, strona: 1 });
    expect(zamowienia[0]._oms.sprawy.map((s) => s.tekst)).toContain('ERLI: zamówienie z rynku DE / w EUR — obsłuż ręcznie');
  });
});

describe('adapter ERLI — kontrakt kanału', () => {
  it('kursorZ = updated, zlozoneZ = purchasedAt (albo created), mapuj pomija pending', () => {
    const a = createErliAdapter({ klient: klientAtrapa(), stan: stanErliWPamieci() });
    expect(a.kursorZ(zam('PC-ERLI-0001'))).toBe('2026-11-13T09:05:00Z');
    expect(a.zlozoneZ(zam('PC-ERLI-0001'))).toBe('2026-11-13T09:01:00Z');
    expect(a.zlozoneZ(zam('PC-ERLI-0001', { purchasedAt: undefined }))).toBe('2026-11-13T09:00:00Z');
    expect(a.mapuj(zam('PC-ERLI-0001', { status: 'pending' }))).toBeNull();
    expect(a.mapuj(zam('PC-ERLI-0001')).zrodlo_id).toBe('PC-ERLI-0001');
  });
});
