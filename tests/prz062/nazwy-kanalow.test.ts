// PRZ-062: panel rozpoznaje kanał Allegro po przedrostku klucza `allegro_` (51 miejsc w src: wysyłka, faktury
// do Allegro, terminy, podjazdy, statystyki, masowe nadania). Definicja `{klucz:'przykladowa',typ:'allegro'}`
// przechodzi walidację OMS_KANALY, pobiera zamówienia — i po cichu traci wszystko, co Allegro-owe.
// Strażnik w /health instalacji klienta (OMS_KOPIE_KATALOG z compose klienta): produkcja właściciela bez tej
// zmiennej i jej /health bez zmian; testy z kluczem „rynek” (typ allegro) nie są instalacją klienta.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alarmyNazwKanalow } from '../../src/moduly/zdrowie/bezpiecznik-kanalow.ts';
import { zbudujOms } from '../../src/oms/bootstrap.ts';
import { czyKanalAllegro } from '../../src/domena/wysylka.js';

describe('alarmyNazwKanalow', () => {
  it('klucze klienta zgodne z regułą: zero alarmów', () => {
    expect(alarmyNazwKanalow([{ klucz: 'allegro_przykladowa', typ: 'allegro' }, { klucz: 'woo_przykladowa', typ: 'woo' }])).toEqual([]);
  });
  it('Allegro bez przedrostka allegro_ i sklep z przedrostkiem allegro: alarm z nazwą kanału', () => {
    expect(alarmyNazwKanalow([{ klucz: 'przykladowa', typ: 'allegro' }, { klucz: 'allegrowka', typ: 'woo' }, { klucz: 'allegro', typ: 'allegro' }])).toEqual([
      'kanał przykladowa (typ allegro): klucz kanału Allegro musi zaczynać się od „allegro_” — bez tego panel nie rozpozna jego zamówień jako Allegro (wysyłka, faktury, terminy, statystyki); zmień klucz w OMS_KANALY przed pierwszym zamówieniem',
      'kanał allegrowka (typ woo): klucz sklepu nie może zaczynać się od „allegro” — terminy wysyłki liczyłyby się jak dla Allegro (a z „allegro_” cały panel wziąłby zamówienia za Allegro); zmień klucz w OMS_KANALY przed pierwszym zamówieniem',
      'kanał allegro (typ allegro): klucz kanału Allegro musi zaczynać się od „allegro_” — bez tego panel nie rozpozna jego zamówień jako Allegro (wysyłka, faktury, terminy, statystyki); zmień klucz w OMS_KANALY przed pierwszym zamówieniem',
    ]);
  });
  it('reguła strażnika = reguła panelu (czyKanalAllegro)', () => {
    for (const klucz of ['allegro_przykladowa', 'przykladowa', 'allegro', 'allegrowka', 'woo_przykladowa'])
      expect(alarmyNazwKanalow([{ klucz, typ: 'allegro' }]).length === 0).toBe(czyKanalAllegro({ sklep: klucz }));
  });
});

describe('/health instalacji klienta', () => {
  const env = (extra: Record<string, string>) => ({ OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
    OMS_USER: 'serwis062', OMS_PASS: 'syntetyczne-062', OMS_PROFORMY_KATALOG: os.tmpdir(), OMS_ETYKIETY_KATALOG: os.tmpdir(),
    OMS_KANALY: JSON.stringify([{ klucz: 'przykladowa', typ: 'allegro', prefiks: 'PRZYKLADOWA' }]), ...extra });
  async function health(e: Record<string, string>) {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
    const z = await zbudujOms({ env: e });
    try { const r = await z.app.inject({ url: '/health' }); expect(r.statusCode).toBe(200); return JSON.parse(r.body); }
    finally { await z.app.close(); z.db.close(); fetchSpy.mockRestore(); }
  }
  it('z OMS_KOPIE_KATALOG (compose klienta) zgłasza zły klucz kanału jako alarm', async () => {
    const kopie = fs.mkdtempSync(path.join(os.tmpdir(), 'prz062-kopie-'));
    try {
      const j = await health(env({ OMS_KOPIE_KATALOG: kopie }));
      expect(j.ok).toBe(false);
      expect(j.alarmy).toContain(alarmyNazwKanalow([{ klucz: 'przykladowa', typ: 'allegro' }])[0]);
    } finally { fs.rmSync(kopie, { recursive: true, force: true }); }
  });
  it('bez OMS_KOPIE_KATALOG (produkcja właściciela, testy) /health bez tego alarmu', async () => {
    const j = await health(env({}));
    expect(JSON.stringify(j)).not.toContain('musi zaczynać się od');
  });
});
