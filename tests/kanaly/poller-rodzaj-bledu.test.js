import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { createWooAdapter } from '../../src/oms/woo/adapter.js';
import { createPoller } from '../../src/moduly/kanaly/services/poller.js';

// RODZAJ BLEDU I POCZATEK JEGO SERII — material dla dlawienia w domain/zdrowie.js.
//
// /health musi odroznic „siec czknela raz" od „sklep stoi od pol godziny" i od „zamowienie
// zostalo pominiete". Pierwsze dwa roznia sie WYLACZNIE czasem trwania, wiec ktos musi
// pamietac, KIEDY seria bledow sie zaczela — poller jest jedynym miejscem, ktore to widzi.
// Trzecie rozni sie RODZAJEM i nie podlega dlawieniu wcale (patrz zdrowie-poller-blip).

const mapa = { instancje: { 1: { metoda: 'dpd' } }, poPozycji: [] };
const zam = (id, modifiedGmt) => ({
  id, number: String(id), status: 'processing', total: '10.00',
  date_created: '2026-09-09T10:00:00', date_modified: modifiedGmt, date_modified_gmt: modifiedGmt,
  billing: {}, shipping: {}, shipping_lines: [{ method_id: 'flat_rate', instance_id: '1' }],
  line_items: [], meta_data: [],
});

let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const pollerZ = (pobierzZamowienia) => createPoller({
  db, kanal: createWooAdapter({ woo: { pobierzZamowienia }, mapowanie: mapa }), sklep: 'pro',
});

describe('poller — rodzaj bledu i poczatek serii', () => {
  it('rzut przebiegu zapisuje rodzaj „awaria" i znaczy poczatek serii', async () => {
    const p = pollerZ(vi.fn().mockRejectedValue(new Error('fetch failed')));
    await expect(p.przebieg()).rejects.toThrow('fetch failed');
    const s = p.stan();
    expect(s.ostatni_blad).toBe('fetch failed');
    expect(s.ostatni_blad_rodzaj).toBe('awaria');
    expect(s.ostatni_blad_od_at).toBeTruthy();
  });

  it('⚠️ DRUGA WPADKA Z RZEDU NIE PRZESUWA poczatku serii — inaczej nic nigdy nie „trwa"', async () => {
    // To jest cala wartosc tej kolumny. Gdyby kazdy nieudany przebieg zapisywal `teraz`,
    // sklep lezacy od godziny mialby blad wiecznie „swiezy" — czyli wiecznie dlawiony,
    // a prawdziwy postoj przestalby budzic kogokolwiek. Dokladnie odwrotnie do zamiaru.
    const pobierz = vi.fn().mockRejectedValue(new Error('fetch failed'));
    const p = pollerZ(pobierz);
    await expect(p.przebieg()).rejects.toThrow();
    const pierwszy = p.stan().ostatni_blad_od_at;
    await new Promise((r) => setTimeout(r, 5));
    await expect(p.przebieg()).rejects.toThrow();
    expect(p.stan().ostatni_blad_od_at).toBe(pierwszy);
  });

  it('udany przebieg gasi blad, rodzaj I poczatek serii naraz', async () => {
    const pobierz = vi.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValue({ zamowienia: [zam(1, '2026-09-09T10:00:00')], stron: 1 });
    const p = pollerZ(pobierz);
    await expect(p.przebieg()).rejects.toThrow();
    await p.przebieg();
    const s = p.stan();
    expect(s.ostatni_blad).toBeNull();
    expect(s.ostatni_blad_rodzaj).toBeNull();
    expect(s.ostatni_blad_od_at).toBeNull();
  });

  it('po przerwie seria liczy sie OD NOWA — czknieccie co godzine to nie awaria trwajaca godzine', async () => {
    const pobierz = vi.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({ zamowienia: [], stron: 1 })
      .mockRejectedValueOnce(new Error('fetch failed'));
    const p = pollerZ(pobierz);
    await expect(p.przebieg()).rejects.toThrow();
    const pierwszy = p.stan().ostatni_blad_od_at;
    await p.przebieg();
    await new Promise((r) => setTimeout(r, 5));
    await expect(p.przebieg()).rejects.toThrow();
    expect(p.stan().ostatni_blad_od_at).not.toBe(pierwszy);
  });

  // LICZNIK NIEUDANYCH PRZEBIEGOW Z RZEDU (10.09.2026, decyzja wlasciciela: komunikat
  // w panelu po TRZECH). Osobna kolumna, bo `ostatni_blad_od_at` mierzy CZAS, a nie PROBY.
  it('licznik prob rosnie z kazda wpadka z rzedu', async () => {
    const p = pollerZ(vi.fn().mockRejectedValue(new Error('fetch failed')));
    await expect(p.przebieg()).rejects.toThrow();
    expect(p.stan().ostatni_blad_prob).toBe(1);
    await expect(p.przebieg()).rejects.toThrow();
    expect(p.stan().ostatni_blad_prob).toBe(2);
    await expect(p.przebieg()).rejects.toThrow();
    expect(p.stan().ostatni_blad_prob).toBe(3);
  });

  it('⚠️ UDANY PRZEBIEG ZERUJE LICZNIK — „z rzedu" znaczy nieprzerwanie', async () => {
    // Bez tego czknieccie co godzine sumowaloby sie przez dobe i o polnocy panel oglaszalby
    // awarie sklepu, ktory przez caly dzien dzialal.
    const pobierz = vi.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce({ zamowienia: [], stron: 1 })
      .mockRejectedValueOnce(new Error('fetch failed'));
    const p = pollerZ(pobierz);
    await expect(p.przebieg()).rejects.toThrow();
    await expect(p.przebieg()).rejects.toThrow();
    expect(p.stan().ostatni_blad_prob).toBe(2);
    await p.przebieg();
    expect(p.stan().ostatni_blad_prob).toBeNull();
    await expect(p.przebieg()).rejects.toThrow();
    expect(p.stan().ostatni_blad_prob).toBe(1);
  });

  it('pominiecie tez liczy sie do serii — rodzaj rozstrzyga osobno, w regule', async () => {
    // Licznik jest FAKTEM o przebiegach, a nie decyzja o krzyku. Decyduje `ostatni_blad_rodzaj`
    // w domain/zdrowie.js: „pominiecie" nie podlega dlawieniu niezaleznie od licznika.
    const kanal = {
      pobierzStrone: vi.fn().mockResolvedValue({ zamowienia: [{ id: 'ALG-ZLE', mod: '2026-09-09T10:00:00' }], stron: 1 }),
      mapuj: () => { throw new Error('ALG-ZLE: nieparsowalna kwota'); },
      kursorZ: (s) => s.mod,
      zlozoneZ: () => null,
    };
    const p = createPoller({ db, kanal, sklep: 'pro' });
    await p.przebieg();
    expect(p.stan().ostatni_blad_prob).toBe(1);
  });

  it('pominiete zamowienie ma rodzaj „pominiecie", nie „awaria"', async () => {
    // Kanal, ktorego mapowanie odmawia — jak Allegro przy nieparsowalnej kwocie.
    const kanal = {
      pobierzStrone: vi.fn().mockResolvedValue({ zamowienia: [{ id: 'ALG-ZLE', mod: '2026-09-09T10:00:00' }], stron: 1 }),
      mapuj: () => { throw new Error('ALG-ZLE: nieparsowalna kwota'); },
      kursorZ: (s) => s.mod,
      zlozoneZ: () => null,
    };
    const p = createPoller({ db, kanal, sklep: 'pro' });
    await p.przebieg();
    const s = p.stan();
    expect(s.ostatni_blad).toMatch(/Pominięto 1 zamówienie/);
    expect(s.ostatni_blad_rodzaj).toBe('pominiecie');
  });
});
