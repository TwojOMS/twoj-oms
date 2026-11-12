import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { createPoller } from '../../../src/moduly/kanaly/services/poller.js';
import { createErliAdapter, stanErliWPamieci, stanErliWBazie } from '../../../src/oms/erli/adapter.js';
import { createErliClient } from '../../../src/oms/erli/client.js';

// PRZ-157.04 — import ERLI przez wspólny poller na prawdziwej bazie (D1: idempotencja i mark-read po zapisie).
const TERAZ = new Date('2026-11-13T12:00:00Z');
const zam = (id, zmiany = {}) => ({
  id, status: 'purchased', currency: 'PLN', market: 'pl', totalPrice: 1000,
  created: '2026-11-13T09:00:00Z', updated: '2026-11-13T09:05:00Z', purchasedAt: '2026-11-13T09:01:00Z',
  user: { email: 'ala@polcien.example', deliveryAddress: { firstName: 'Ala', lastName: 'Zmyślonowicz', street: 'Fikcyjna', buildingNumber: '1', city: 'Testowo', country: 'pl', zip: '00-000', phone: '000000000' } },
  delivery: { name: 'Kurier testowy', typeId: 'kurierTestowy', price: 0, cod: false },
  items: [{ id: 1, externalId: 'PC-OF-001', quantity: 1, unitPrice: 1000, name: 'Szablon', slug: 'szablon', taxRate: 'TAX_23', dispatchTime: { period: 1, unit: 'day' } }],
  ...zmiany,
});
const wiad = (id, payload) => ({ id, shopId: 1000001, created: '2026-11-13T09:06:00Z', read: false, type: 'orderCreated', payload });

function klientZWiadomosciami(wiadomosci) {
  return {
    zmianyZamowien: vi.fn(async () => wiadomosci),
    oznaczPrzeczytane: vi.fn(async () => 1),
    inboxSzukaj: vi.fn(async () => []),
    inboxOznacz: vi.fn(async () => 1),
    szukajZamowien: vi.fn(async () => []),
    pobierzProdukt: vi.fn(async () => null),
  };
}

const uzgodnione = () => stanErliWPamieci({ uzgodnienieAt: TERAZ.toISOString(), uzgodnienieKursor: 'k0' });
const liczba = (db) => db.prepare("SELECT COUNT(*) AS n FROM zamowienia WHERE sklep = 'erli_pc'").get().n;

const limit = (retryAfterS) => Object.assign(new Error('ERLI: limit żądań (429).'), {
  kod: 'ERLI_429', status: 429, ...(retryAfterS === undefined ? {} : { retryAfterS }),
});

describe('ERLI 429 — przerwa kanału (D8)', () => {
  it('429 w środku stron: bez wyjątku, zapis części, cisza w przerwie i komplet po wznowieniu', async () => {
    const db = openOmsDb(':memory:');
    let czas = TERAZ.getTime();
    const klient = klientZWiadomosciami([wiad('m1', zam('PC-ERLI-0001'))]);
    klient.szukajZamowien
      .mockResolvedValueOnce([zam('PC-ERLI-0001', { cursor: 'c1' })])
      .mockRejectedValueOnce(limit(30))
      .mockResolvedValueOnce([zam('PC-ERLI-0002', { cursor: 'c2' })])
      .mockResolvedValueOnce([]);
    const kanal = createErliAdapter({ klient, stan: stanErliWPamieci(), teraz: () => new Date(czas), limitUzgodnienia: 1 });
    const poller = createPoller({ db, sklep: 'erli_pc', kanal });
    try {
      await expect(poller.przebieg()).resolves.toMatchObject({ pobrane: 1 });
      expect(liczba(db)).toBe(1);
      expect(poller.stan()).toMatchObject({ ostatni_blad: null, ostatni_blad_prob: null });
      expect(klient.oznaczPrzeczytane).not.toHaveBeenCalled();
      const wywolania = () => Object.values(klient).map(fn => fn.mock.calls.length);
      const przed = wywolania();
      czas += 29_999;
      await expect(poller.przebieg()).resolves.toMatchObject({ pobrane: 0 });
      expect(wywolania()).toEqual(przed);
      czas += 1;
      await expect(poller.przebieg()).resolves.toMatchObject({ pobrane: 2 });
      expect(liczba(db)).toBe(2);
      expect(klient.oznaczPrzeczytane).toHaveBeenCalledWith({ lastMessageId: 'm1' });
      expect(klient.szukajZamowien.mock.calls[2][0].pagination.after).toBe('c1');
      expect(poller.stan()).toMatchObject({ ostatni_blad: null, ostatni_blad_prob: null });
    } finally { db.close(); }
  });

  it('bez Retry-After przerwa rośnie do 15 minut i zeruje się po udanym żądaniu', async () => {
    let czas = TERAZ.getTime();
    const klient = klientZWiadomosciami([]);
    klient.zmianyZamowien.mockRejectedValue(limit());
    const a = createErliAdapter({ klient, stan: uzgodnione(), teraz: () => new Date(czas) });
    for (const [i, sekundy] of [60, 120, 240, 480, 900, 900].entries()) {
      await expect(a.pobierzStrone()).resolves.toEqual({ zamowienia: [], stron: 1 });
      expect(klient.zmianyZamowien).toHaveBeenCalledTimes(i + 1);
      czas += sekundy * 1000 - 1;
      await a.pobierzStrone();
      expect(klient.zmianyZamowien).toHaveBeenCalledTimes(i + 1);
      czas += 1;
    }
    klient.zmianyZamowien.mockResolvedValueOnce([]);
    await a.pobierzStrone();
    await a.pobierzStrone();
    const przed = klient.zmianyZamowien.mock.calls.length;
    czas += 59_999;
    await a.pobierzStrone();
    expect(klient.zmianyZamowien).toHaveBeenCalledTimes(przed);
    czas += 1;
    await a.pobierzStrone();
    expect(klient.zmianyZamowien).toHaveBeenCalledTimes(przed + 1);
  });

  it('data w Retry-After nieprzekazana przez klienta → przerwa narastająca', async () => {
    let czas = TERAZ.getTime();
    const fetchImpl = vi.fn(async () => new Response('', { status: 429,
      headers: { 'Retry-After': 'Fri, 13 Nov 2026 12:10:00 GMT' } }));
    const klient = createErliClient({ adresApi: 'https://sklep.polcien.example', kluczApi: 'fikcyjny-klucz', fetchImpl });
    const a = createErliAdapter({ klient, stan: uzgodnione(), teraz: () => new Date(czas) });
    await expect(a.pobierzStrone()).resolves.toEqual({ zamowienia: [], stron: 1 });
    czas += 60_000;
    await a.pobierzStrone();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    czas += 119_999;
    await a.pobierzStrone();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    czas += 1;
    await a.pobierzStrone();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('500 nadal kończy przebieg błędem kanału', async () => {
    const db = openOmsDb(':memory:');
    const klient = klientZWiadomosciami([]);
    klient.zmianyZamowien.mockRejectedValue(Object.assign(new Error('HTTP 500'), { status: 500 }));
    const poller = createPoller({ db, sklep: 'erli_pc', kanal: createErliAdapter({ klient, stan: uzgodnione() }) });
    try {
      await expect(poller.przebieg()).rejects.toThrow('HTTP 500');
      expect(poller.stan()).toMatchObject({ ostatni_blad: 'HTTP 500', ostatni_blad_prob: 1 });
    } finally { db.close(); }
  });

  it('mark-read 500 nie blokuje kolejnych przebiegów; Retry-After przycięty do 15 min', async () => {
    const db = openOmsDb(':memory:');
    let czas = TERAZ.getTime();
    const klient = klientZWiadomosciami([wiad('m1', zam('PC-ERLI-0001'))]);
    klient.oznaczPrzeczytane.mockRejectedValue(Object.assign(new Error('HTTP 500'), { status: 500 }));
    const poller = createPoller({ db, sklep: 'erli_pc', kanal: createErliAdapter({ klient, stan: uzgodnione(), teraz: () => new Date(czas) }) });
    try {
      await poller.przebieg().catch(() => {});
      await poller.przebieg().catch(() => {});
      expect(klient.zmianyZamowien).toHaveBeenCalledTimes(2);
      klient.oznaczPrzeczytane.mockResolvedValue(1);
      klient.zmianyZamowien.mockRejectedValueOnce(limit(86400));
      await poller.przebieg();
      czas += 15 * 60_000;
      await poller.przebieg();
      expect(klient.zmianyZamowien).toHaveBeenCalledTimes(4);
    } finally { db.close(); }
  });

  it('429 przy mark-read: zapis zostaje, potwierdzenie wraca po przerwie, tylko w swoim kanale', async () => {
    const db = openOmsDb(':memory:');
    let czas = TERAZ.getTime();
    const klient = klientZWiadomosciami([wiad('m1', zam('PC-ERLI-0001'))]);
    klient.oznaczPrzeczytane.mockRejectedValueOnce(limit(7));
    const kanal = createErliAdapter({ klient, stan: uzgodnione(), teraz: () => new Date(czas) });
    const poller = createPoller({ db, sklep: 'erli_pc', kanal });
    try {
      await expect(poller.przebieg()).resolves.toMatchObject({ pobrane: 1 });
      expect(liczba(db)).toBe(1);
      expect(poller.stan().ostatni_blad).toBeNull();
      await poller.przebieg();
      expect(klient.zmianyZamowien).toHaveBeenCalledTimes(1);
      expect(klient.oznaczPrzeczytane).toHaveBeenCalledTimes(1);
      const drugiKlient = klientZWiadomosciami([]);
      await createErliAdapter({ klient: drugiKlient, stan: uzgodnione(), teraz: () => new Date(czas) }).pobierzStrone();
      expect(drugiKlient.zmianyZamowien).toHaveBeenCalledTimes(1);
      czas += 7000;
      klient.zmianyZamowien.mockResolvedValue([]);
      await poller.przebieg();
      expect(klient.oznaczPrzeczytane).toHaveBeenCalledTimes(2);
      expect(klient.oznaczPrzeczytane).toHaveBeenLastCalledWith({ lastMessageId: 'm1' });
      expect(klient.oznaczPrzeczytane.mock.invocationCallOrder[1])
        .toBeLessThan(klient.zmianyZamowien.mock.invocationCallOrder[1]);
    } finally { db.close(); }
  });

  it('429 produktu zatrzymuje dalsze odczyty; awaria zapisu nie odkłada mark-read', async () => {
    const db = openOmsDb(':memory:');
    let czas = TERAZ.getTime();
    const pozycja = { ...zam('PC-ERLI-0001').items[0], dispatchTime: undefined };
    const klient = klientZWiadomosciami([wiad('m1', zam('PC-ERLI-0001', {
      items: [pozycja, { ...pozycja, externalId: 'PC-OF-002' }],
    }))]);
    klient.pobierzProdukt.mockRejectedValueOnce(limit(5));
    const kanal = createErliAdapter({ klient, stan: uzgodnione(), teraz: () => new Date(czas) });
    const poller = createPoller({ db, sklep: 'erli_pc', kanal });
    db.exec("CREATE TRIGGER blokada_testu BEFORE INSERT ON zamowienia BEGIN SELECT RAISE(ABORT, 'dysk pełny (test)'); END");
    try {
      await expect(poller.przebieg()).rejects.toThrow('dysk pełny');
      expect(klient.pobierzProdukt).toHaveBeenCalledTimes(1);
      expect(klient.oznaczPrzeczytane).not.toHaveBeenCalled();
      czas += 5000;
      klient.zmianyZamowien.mockResolvedValue([]);
      await poller.przebieg();
      expect(klient.oznaczPrzeczytane).not.toHaveBeenCalled();
      expect(liczba(db)).toBe(0);
    } finally { db.close(); }
  });
});

describe('poller + adapter ERLI na bazie', () => {
  it('to samo zdarzenie dwa razy (niepotwierdzone) → jedno zamówienie w bazie', async () => {
    const db = openOmsDb(':memory:');
    const klient = klientZWiadomosciami([wiad('m1', zam('PC-ERLI-0001'))]);
    const poller = createPoller({ db, sklep: 'erli_pc', kanal: createErliAdapter({ klient, stan: uzgodnione(), teraz: () => TERAZ }) });
    await poller.przebieg();
    await poller.przebieg();
    expect(liczba(db)).toBe(1);
    expect(klient.oznaczPrzeczytane).toHaveBeenCalledTimes(2);
    expect(klient.oznaczPrzeczytane).toHaveBeenLastCalledWith({ lastMessageId: 'm1' });
  });

  it('awaria zapisu w bazie → wiadomości NIE są oznaczone jako przeczytane', async () => {
    const db = openOmsDb(':memory:');
    db.exec("CREATE TRIGGER blokada_testu BEFORE INSERT ON zamowienia BEGIN SELECT RAISE(ABORT, 'dysk pełny (test)'); END");
    const klient = klientZWiadomosciami([wiad('m1', zam('PC-ERLI-0001'))]);
    const poller = createPoller({ db, sklep: 'erli_pc', kanal: createErliAdapter({ klient, stan: uzgodnione(), teraz: () => TERAZ }) });
    await expect(poller.przebieg()).rejects.toThrow(/dysk pełny/);
    expect(klient.oznaczPrzeczytane).not.toHaveBeenCalled();
    expect(liczba(db)).toBe(0);
  });

  it('pending nie trafia do bazy', async () => {
    const db = openOmsDb(':memory:');
    const klient = klientZWiadomosciami([wiad('m1', zam('PC-ERLI-0001', { status: 'pending' }))]);
    const poller = createPoller({ db, sklep: 'erli_pc', kanal: createErliAdapter({ klient, stan: uzgodnione(), teraz: () => TERAZ }) });
    await poller.przebieg();
    expect(liczba(db)).toBe(0);
  });

  it('wybór toru zapisany w konfiguracji kanału przetrwa nowy adapter (bez migracji)', async () => {
    const db = openOmsDb(':memory:');
    const klient = klientZWiadomosciami([]);
    klient.zmianyZamowien.mockRejectedValue(Object.assign(new Error('ERLI: nie znaleziono (HTTP 404)'), { status: 404 }));
    const stan = stanErliWBazie(db, 'erli_pc');
    await createPoller({ db, sklep: 'erli_pc', kanal: createErliAdapter({ klient, stan, teraz: () => TERAZ }) }).przebieg();
    const drugi = createErliAdapter({ klient, stan: stanErliWBazie(db, 'erli_pc'), teraz: () => TERAZ });
    expect(drugi.tor()).toBe('inbox');
    expect(stanErliWBazie(db, 'erli_pc').wczytaj()).toMatchObject({ tor: 'inbox', uzgodnienieAt: TERAZ.toISOString() });
  });
});
