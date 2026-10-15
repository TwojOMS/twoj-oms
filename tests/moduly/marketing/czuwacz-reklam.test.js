import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import {
  zapiszPolaczenie, polaczenia, dni, transakcje, stanPolaczenia,
} from '../../../src/oms/db/reklamy.js';
import { createCzuwaczReklam } from '../../../src/moduly/marketing/uslugi/czuwacz-reklam.js';

describe('czuwacz bieżących reklam', () => {
  it('odświeża GA4 mimo awarii Meta, a kolejny odczyt poprawia dojrzewający dzień', async () => {
    const db = openOmsDb(':memory:');
    const google = zapiszPolaczenie(db, { typ: 'ga4', kontoId: '123', kanal: 'pro',
      waluta: 'PLN', strefa: 'Europe/Warsaw', sekretRef: 'ga4-test' });
    const meta = zapiszPolaczenie(db, { typ: 'meta', kontoId: 'act_456', kanal: 'pro',
      waluta: 'PLN', strefa: 'Europe/Warsaw', sekretRef: 'meta-test' });
    const raportGoogle = vi.fn()
      .mockResolvedValueOnce({ waluta: 'PLN', dni: [{ dzien: '2026-09-22', kampaniaId: '42',
        nazwa: 'Produktowa', koszt: '10.00', klikniecia: 4, wyswietlenia: 100 }],
      transakcje: [{ dzien: '2026-09-22', kampaniaId: '42', transactionId: '1451', przychod: '97.40' }] })
      .mockResolvedValueOnce({ waluta: 'PLN', dni: [{ dzien: '2026-09-22', kampaniaId: '42',
        nazwa: 'Produktowa', koszt: '11.25', klikniecia: 5, wyswietlenia: 120 }],
      transakcje: [{ dzien: '2026-09-22', kampaniaId: '42', transactionId: '1451', przychod: '97.40' }] });
    const klientDla = vi.fn(async (p) => p.typ === 'ga4'
      ? { raportReklam: raportGoogle }
      : { raportReklam: async () => { const e = new Error('sekret w błędzie API'); e.status = 403; throw e; } });
    const czuwacz = createCzuwaczReklam({ db, klientDlaPolaczenia: klientDla,
      teraz: () => new Date('2026-09-23T12:00:00Z') });
    const pierwszy = await czuwacz.przebieg();
    expect(pierwszy).toMatchObject({ sukcesy: 1, bledy: 1 });
    expect(dni(db, { typ: 'ga4', polaczenieId: google.id })[0].koszt).toBe('10.00');
    expect(transakcje(db, { polaczenieId: google.id })).toHaveLength(1);
    expect(stanPolaczenia(db, meta.id).kodBledu).toBe('BRAK_UPRAWNIEN');
    expect(JSON.stringify(stanPolaczenia(db, meta.id))).not.toContain('sekret');
    expect(stanPolaczenia(db, google.id).ostatniSukcesAt).toBeTruthy();
    await czuwacz.przebieg();
    expect(dni(db, { typ: 'ga4', polaczenieId: google.id })[0].koszt).toBe('11.25');
    expect(raportGoogle).toHaveBeenCalledWith({ wlasciwosc: '123', od: '2026-08-20', do: '2026-09-23' });
    db.close();
  });

  it('bez źródeł nie pyta API ani nie zgłasza awarii', async () => {
    const db = openOmsDb(':memory:');
    const klientDlaPolaczenia = vi.fn();
    const wynik = await createCzuwaczReklam({ db, klientDlaPolaczenia }).przebieg();
    expect(wynik).toMatchObject({ sukcesy: 0, bledy: 0 });
    expect(klientDlaPolaczenia).not.toHaveBeenCalled();
    db.close();
  });

  it('zapamiętuje walutę odczytaną przy pierwszym uruchomieniu połączenia', async () => {
    const db = openOmsDb(':memory:');
    zapiszPolaczenie(db, { typ: 'ga4', kontoId: '123', kanal: 'pro' });
    const czuwacz = createCzuwaczReklam({ db, teraz: () => new Date('2026-09-23T12:00:00Z'),
      klientDlaPolaczenia: async () => ({ raportReklam: async () => ({ waluta: 'PLN', dni: [], transakcje: [] }) }) });
    await czuwacz.przebieg();
    expect(polaczenia(db)[0].waluta).toBe('PLN');
    expect(dni(db, { typ: 'ga4', polaczenieId: polaczenia(db)[0].id })).toHaveLength(0);
    db.close();
  });

  it('pierwszy raport zapisuje walutę także przy dziennych kwotach i transakcji', async () => {
    const db = openOmsDb(':memory:');
    const p = zapiszPolaczenie(db, { typ: 'ga4', kontoId: '123', kanal: 'pro' });
    const czuwacz = createCzuwaczReklam({ db, teraz: () => new Date('2026-09-23T12:00:00Z'),
      klientDlaPolaczenia: async () => ({ raportReklam: async () => ({ waluta: 'PLN',
        dni: [{ dzien: '2026-09-22', kampaniaId: 'g', koszt: '1.00' }],
        transakcje: [{ dzien: '2026-09-22', kampaniaId: 'g', transactionId: '1', przychod: '2.00' }],
      }) }) });
    await czuwacz.przebieg();
    expect(dni(db, { typ: 'ga4', polaczenieId: p.id })[0].waluta).toBe('PLN');
    expect(transakcje(db, { polaczenieId: p.id })[0].waluta).toBe('PLN');
    db.close();
  });

  it('pierwszy raport Meta zapisuje walutę i strefę przy danych dnia', async () => {
    const db = openOmsDb(':memory:');
    const p = zapiszPolaczenie(db, { typ: 'meta', kontoId: 'act_123' });
    const czuwacz = createCzuwaczReklam({ db, teraz: () => new Date('2026-09-23T12:00:00Z'),
      klientDlaPolaczenia: async () => ({ raportReklam: async () => ({ waluta: 'PLN', strefa: 'Europe/Warsaw',
        dni: [{ dzien: '2026-09-22', kampaniaId: 'm', wydatek: '1.00' }], kampanie: [{ id: 'm', nazwa: 'Meta' }],
      }) }) });
    await czuwacz.przebieg();
    expect(dni(db, { typ: 'meta', polaczenieId: p.id })[0].waluta).toBe('PLN');
    expect(polaczenia(db)[0].strefa).toBe('Europe/Warsaw');
    db.close();
  });

  it('usuwa wiersz, który zniknął z ponownego raportu', async () => {
    const db = openOmsDb(':memory:');
    const p = zapiszPolaczenie(db, { typ: 'ga4', kontoId: '123', kanal: 'pro', waluta: 'PLN' });
    const raportReklam = vi.fn()
      .mockResolvedValueOnce({ waluta: 'PLN', dni: [{ dzien: '2026-09-22', kampaniaId: '42', koszt: '10.00' }], transakcje: [] })
      .mockResolvedValueOnce({ waluta: 'PLN', dni: [], transakcje: [] });
    const czuwacz = createCzuwaczReklam({ db, klientDlaPolaczenia: async () => ({ raportReklam }),
      teraz: () => new Date('2026-09-23T12:00:00Z') });
    await czuwacz.przebieg();
    expect(dni(db, { typ: 'ga4', polaczenieId: p.id })).toHaveLength(1);
    await czuwacz.przebieg();
    expect(dni(db, { typ: 'ga4', polaczenieId: p.id })).toHaveLength(0);
    db.close();
  });

  it('nie miesza świeżego kosztu ze starą sprzedażą przy błędzie transakcji', async () => {
    const db = openOmsDb(':memory:');
    const p = zapiszPolaczenie(db, { typ: 'ga4', kontoId: '123', kanal: 'pro', waluta: 'PLN' });
    const raportReklam = vi.fn()
      .mockResolvedValueOnce({ waluta: 'PLN', dni: [{ dzien: '2026-09-22', kampaniaId: '42', koszt: '10.00' }],
        transakcje: [{ dzien: '2026-09-22', kampaniaId: '42', transactionId: '1451', przychod: '20.00' }] })
      .mockResolvedValueOnce({ waluta: 'PLN', dni: [{ dzien: '2026-09-22', kampaniaId: '42', koszt: '15.00' }],
        transakcje: [{ dzien: '2026-09-22', kampaniaId: '42', transactionId: '', przychod: '30.00' }] });
    const czuwacz = createCzuwaczReklam({ db, klientDlaPolaczenia: async () => ({ raportReklam }),
      teraz: () => new Date('2026-09-23T12:00:00Z') });
    await czuwacz.przebieg();
    expect((await czuwacz.przebieg()).bledy).toBe(1);
    expect(dni(db, { typ: 'ga4', polaczenieId: p.id })[0].koszt).toBe('10.00');
    expect(transakcje(db, { polaczenieId: p.id })[0].przychod).toBe('20.00');
    db.close();
  });
});
