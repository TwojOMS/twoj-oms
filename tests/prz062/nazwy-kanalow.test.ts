// PRZ-062: sklep (typ woo) z kluczem zaczynającym się od „allegro” przechodzi walidację OMS_KANALY, pobiera
// zamówienia — i po cichu liczy terminy jak Allegro (a z „allegro_” traci wszystko, co sklepowe, bo prefiks
// w `czyKanalAllegro` wygrywa z typem). Strażnik w /health instalacji klienta (OMS_KOPIE_KATALOG z compose
// klienta): produkcja właściciela bez tej zmiennej i jej /health bez zmian.
// PRZ-101.08 (zmiana zachowania): alarm „kanał typu allegro bez prefiksu allegro_” zniknął — panel rozpoznaje
// taki kanał po typie z konfiguracji (rejestr w module kanałów), więc alarm mówiłby nieprawdę.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alarmyNazwKanalow } from '../../src/moduly/zdrowie/bezpiecznik-kanalow.ts';
import { zbudujOms } from '../../src/oms/bootstrap.ts';

describe('alarmyNazwKanalow', () => {
  it('klucze klienta zgodne z regułą: zero alarmów (Allegro z prefiksem albo bez)', () => {
    expect(alarmyNazwKanalow([{ klucz: 'allegro_przykladowa', typ: 'allegro' }, { klucz: 'woo_przykladowa', typ: 'woo' },
      { klucz: 'przykladowa', typ: 'allegro' }, { klucz: 'allegro', typ: 'allegro' }])).toEqual([]);
  });
  it('sklep z przedrostkiem allegro: alarm z nazwą kanału', () => {
    expect(alarmyNazwKanalow([{ klucz: 'allegrowka', typ: 'woo' }, { klucz: 'allegro_sklep', typ: 'woo' }])).toEqual([
      'kanał allegrowka (typ woo): klucz sklepu nie może zaczynać się od „allegro” — terminy wysyłki liczyłyby się jak dla Allegro (a z „allegro_” cały panel wziąłby zamówienia za Allegro); zmień klucz w OMS_KANALY przed pierwszym zamówieniem',
      'kanał allegro_sklep (typ woo): klucz sklepu nie może zaczynać się od „allegro” — terminy wysyłki liczyłyby się jak dla Allegro (a z „allegro_” cały panel wziąłby zamówienia za Allegro); zmień klucz w OMS_KANALY przed pierwszym zamówieniem',
    ]);
  });
});

describe('/health instalacji klienta', () => {
  const env = (extra: Record<string, string>) => ({ OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
    OMS_USER: 'serwis062', OMS_PASS: 'syntetyczne-062', OMS_PROFORMY_KATALOG: os.tmpdir(), OMS_ETYKIETY_KATALOG: os.tmpdir(),
    OMS_KANALY: JSON.stringify([{ klucz: 'allegrowka', typ: 'woo', prefiks: 'ALLEGROWKA' }, { klucz: 'przykladowa', typ: 'allegro', prefiks: 'PRZYKLADOWA' }]), ...extra });
  async function health(e: Record<string, string>) {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Sieć zabroniona'));
    const z = await zbudujOms({ env: e });
    try { const r = await z.app.inject({ url: '/health' }); expect(r.statusCode).toBe(200); return JSON.parse(r.body); }
    finally { await z.app.close(); z.db.close(); fetchSpy.mockRestore(); }
  }
  it('z OMS_KOPIE_KATALOG (compose klienta) zgłasza zły klucz sklepu jako alarm, a kanału Allegro bez prefiksu nie', async () => {
    const kopie = fs.mkdtempSync(path.join(os.tmpdir(), 'prz062-kopie-'));
    try {
      const j = await health(env({ OMS_KOPIE_KATALOG: kopie }));
      expect(j.ok).toBe(false);
      expect(j.alarmy).toContain(alarmyNazwKanalow([{ klucz: 'allegrowka', typ: 'woo' }])[0]);
      expect(JSON.stringify(j)).not.toContain('kanał przykladowa (typ allegro)');
    } finally { fs.rmSync(kopie, { recursive: true, force: true }); }
  });
  it('bez OMS_KOPIE_KATALOG (produkcja właściciela, testy) /health bez tego alarmu', async () => {
    const j = await health(env({}));
    expect(JSON.stringify(j)).not.toContain('nie może zaczynać się od');
  });
});
