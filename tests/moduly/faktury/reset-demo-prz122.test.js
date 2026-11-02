import { szewTwojeFaktury } from '../../../src/moduly/faktury/wczytaj-szew.ts';
import { describe, it, expect, vi } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { MODULY } from '../../../src/moduly/lista.ts';
import { KLUCZ_ZLECENIA_RESETU } from '../../../src/domena/reset-demo.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

const ADRES = '/ustawienia/dane-demo';
const RESET = `${ADRES}/reset`;
const poKolejce = () => new Promise((r) => setImmediate(r));

function panel(env) {
  const zdarzenia = [];
  const zakonczProces = vi.fn(() => zdarzenia.push('koniec'));
  const modul = createModulFaktury({ fabryki: { zakonczProces } });
  const p = nowyPanel({ env: { OMS_SPRZEDAWCA_NIP: '4534240685', ...env }, moduly: MODULY.map(m => m.nazwa === 'faktury' ? modul : m) });
  zalozKonto(p.db, { login: 'polcien', imie: 'Pracownia Półcień', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ida', imie: 'Ida', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ida').id, ['ustawienia']);
  return { ...p, admin: jako(p.db, 'polcien'), ida: jako(p.db, 'ida'), zakonczProces, zdarzenia };
}
const klucz = db => db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ_ZLECENIA_RESETU);

describe('RESET-DEMOb', () => {
  it.runIf(szewTwojeFaktury)('admin widzi dane, potwierdza reset i otrzymuje odpowiedź przed zakończeniem procesu', async () => {
    const { app, db, admin, zakonczProces, zdarzenia } = panel({ OMS_TRYB: 'proba', OMS_TWOJEFAKTURY: 'tak', OMS_RESTART_Z_PANELU: 'tak', OMS_PROGRAM_FAKTUROWY: 'twojefaktury' });
    try {
      const ekran = await get(app, ADRES, admin);
      expect(ekran.statusCode).toBe(200);
      expect(ekran.body).toContain('TwojeFaktury');
      expect(ekran.body).toContain('4534240685');
      expect(ekran.body).toContain('Numeracja faktur');
      expect(ekran.body).toContain('FV/');
      expect(ekran.body).toContain('Rozumiem, że dane demo zostaną zastąpione');
      expect(ekran.body).toContain('Przywróć dane demo');
      expect((await get(app, '/ustawienia/moduly', admin)).body).toContain('Dane demo'); // zakładki tylko bieżącego działu
      expect((await post(app, RESET, admin)).statusCode).toBe(400);
      expect(klucz(db)).toBeUndefined();
      await poKolejce();
      expect(zakonczProces).not.toHaveBeenCalled();
      const odpowiedz = await post(app, RESET, admin, { potwierdzam: 'tak' });
      zdarzenia.push('odpowiedz');
      expect(odpowiedz.statusCode).toBe(200);
      expect(odpowiedz.body).toContain('http-equiv="refresh"');
      expect(JSON.parse(klucz(db).wartosc)).toMatchObject({ login: 'polcien' });
      await poKolejce();
      expect(zakonczProces).toHaveBeenCalledTimes(1);
      expect(zdarzenia).toEqual(['odpowiedz', 'koniec']);
    } finally { await app.close(); db.close(); }
  });
  it('operator bez admina dostaje 403', async () => {
    const { app, db, ida, zakonczProces } = panel({ OMS_TRYB: 'proba', OMS_RESTART_Z_PANELU: 'tak' });
    try {
      expect((await get(app, ADRES, ida)).statusCode).toBe(403);
      expect((await post(app, RESET, ida, { potwierdzam: 'tak' })).statusCode).toBe(403);
      expect(klucz(db)).toBeUndefined();
      expect(zakonczProces).not.toHaveBeenCalled();
    } finally { await app.close(); db.close(); }
  });
  it.each([
    ['produkcja', { OMS_RESTART_Z_PANELU: 'tak' }],
    ['próba z atrapą', { OMS_TRYB: 'proba', OMS_RESTART_Z_PANELU: 'atrapa' }],
    ['próba bez restartu', { OMS_TRYB: 'proba' }],
  ])('%s: brak tras i pozycji menu', async (_opis, env) => {
    const { app, db, admin, zakonczProces } = panel(env);
    try {
      expect((await get(app, ADRES, admin)).statusCode).toBe(404);
      expect((await post(app, RESET, admin, { potwierdzam: 'tak' })).statusCode).toBe(404);
      const menu = await get(app, '/ustawienia/firma', admin);
      expect(menu.statusCode).toBe(200);
      expect(menu.body).not.toContain('Dane demo');
      expect(klucz(db)).toBeUndefined();
      expect(zakonczProces).not.toHaveBeenCalled();
    } finally { await app.close(); db.close(); }
  });
});
