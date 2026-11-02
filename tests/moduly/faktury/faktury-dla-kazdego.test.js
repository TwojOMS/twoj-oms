import { describe, it, expect, vi, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { czyFakturaDlaKazdego, zapiszFakturaDlaKazdego, ZDANIE_KASA } from '../../../src/moduly/faktury/db/faktury-dla-kazdego.js';
import { zapiszKonsumenckie } from '../../../src/moduly/faktury/db/ksef-konsumenckie.js';
import { szewTwojeFaktury } from '../../../src/moduly/faktury/wczytaj-szew.ts';
import * as ustawieniaProgramu from '../../../src/moduly/faktury/trasy/ustawienia-programu.js';

const ADRES = '/ustawienia/faktury/zasady';
const ZAPIS = '/ustawienia/integracje/program-fakturowy/dla-kazdego';
const PDF = 'Faktury dla osób bez NIP-u nie idą teraz do KSeF, więc klient nie dostanie PDF-a — włącz wysyłkę faktur konsumenckich.';
const pole = (html) => html.match(/<input[^>]*name="dlaKazdego"[^>]*>/u)?.[0] ?? '';
const wiersz = (db) => db.prepare('SELECT * FROM ustawienia WHERE klucz = ?').get('faktury.dla_kazdego');

function panel(program = 'brak') {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Test nie może używać sieci'); }));
  const p = nowyPanel({ env: { OMS_PROGRAM_FAKTUROWY: program, ...(program === 'twojefaktury' ? { OMS_TWOJEFAKTURY: 'tak' } : {}) } });
  zalozKonto(p.db, { login: 'polcien', imie: 'Pracownia Półcień', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ida', imie: 'Ida', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ida').id, ['ustawienia']);
  return { ...p, admin: jako(p.db, 'polcien'), ida: jako(p.db, 'ida') };
}
afterEach(() => vi.unstubAllGlobals());

describe('PRZ-126.F01 faktury także bez żądania klienta', () => {
  it('magazyn: brak wiersza wyłącza, zapis tak/nie i ponowny odczyt bez pamięci podręcznej', () => {
    const db = openOmsDb(':memory:');
    try {
      expect(wiersz(db)).toBeUndefined();
      expect(czyFakturaDlaKazdego(db)).toBe(false);
      for (const wartosc of [true, false, true]) {
        zapiszFakturaDlaKazdego(db, wartosc);
        expect(wiersz(db).wartosc).toBe(wartosc ? 'tak' : 'nie');
        expect(wiersz(db).zmienione_at).toBeTruthy();
        expect(czyFakturaDlaKazdego(db)).toBe(wartosc);
      }
    } finally { db.close(); }
  });

  it('admin zapisuje i wyłącza, widok czyta bazę, zawiera stałe zdanie o kasie i potwierdzenie', async () => {
    const { app, db, admin } = panel();
    try {
      const poczatek = await get(app, ADRES, admin);
      expect(poczatek.statusCode).toBe(200);
      expect(poczatek.body).toContain(ZDANIE_KASA);
      expect(pole(poczatek.body)).not.toBe('');
      expect(pole(poczatek.body)).not.toContain('checked');
      expect(poczatek.body).not.toContain(PDF);
      for (const wlaczone of [true, false]) {
        const r = await post(app, ZAPIS, admin, wlaczone ? { dlaKazdego: 'tak' } : {});
        expect(r.statusCode, r.body).toBe(303);
        expect(czyFakturaDlaKazdego(db)).toBe(wlaczone);
        const ekran = await get(app, r.headers.location, admin);
        expect(ekran.body).toContain('Zapisano ustawienie wystawiania faktur.');
        expect(pole(ekran.body).includes('checked')).toBe(wlaczone);
        expect(ekran.body).toContain(ZDANIE_KASA);
      }
    } finally { await app.close(); db.close(); }
  });

  it.each([false, true])('nie-admin: 403, wiersz bez zmian (początkowo %s), formularz niewidoczny', async (wlaczone) => {
    const { app, db, ida } = panel();
    try {
      if (wlaczone) zapiszFakturaDlaKazdego(db, true);
      const przed = wiersz(db);
      const r = await post(app, ZAPIS, ida, wlaczone ? {} : { dlaKazdego: 'tak' });
      expect(r.statusCode).toBe(403);
      expect(wiersz(db)).toEqual(przed);
      const ekran = await get(app, ADRES, ida);
      expect(ekran.statusCode).toBe(200);
      expect(ekran.body).not.toContain(`action="${ZAPIS}"`);
      expect(ekran.body).toContain(ZDANIE_KASA);
    } finally { await app.close(); db.close(); }
  });

  it.each([['nie'], [''], [true], [['tak', 'nie']], [{ wartosc: 'tak' }]])('nieprawidłowe dane %j: 400 bez zmiany wiersza', async (wartosc) => {
    const { app, db, admin } = panel();
    try {
      zapiszFakturaDlaKazdego(db, true);
      const przed = wiersz(db);
      expect((await post(app, ZAPIS, admin, { dlaKazdego: wartosc })).statusCode).toBe(400);
      expect(wiersz(db)).toEqual(przed);
    } finally { await app.close(); db.close(); }
  });

  it.each([[[]], [{ program: 'brak' }]])('nieprawidłowy formularz %j: nie wyłącza ustawienia', async (payload) => {
    const { app, db, admin } = panel();
    try {
      zapiszFakturaDlaKazdego(db, true);
      const przed = wiersz(db);
      expect((await post(app, ZAPIS, admin, payload)).statusCode).toBe(400);
      expect(wiersz(db)).toEqual(przed);
    } finally { await app.close(); db.close(); }
  });

  it('POST bez ochrony Origin jest odrzucony przed zapisem', async () => {
    const { app, db, admin } = panel();
    try {
      const r = await app.inject({ method: 'POST', url: ZAPIS, headers: admin, payload: { dlaKazdego: 'tak' } });
      expect(r.statusCode).toBe(403);
      expect(wiersz(db)).toBeUndefined();
    } finally { await app.close(); db.close(); }
  });

  // W kopii bez TwojeFaktury (wycięcie) OMS z OMS_TWOJEFAKTURY=tak nie startuje.
  it.runIf(szewTwojeFaktury)('TwojeFaktury: ostrzeżenie o PDF zależy od bieżącego ustawienia konsumenckich', async () => {
    const { app, db, admin } = panel('twojefaktury');
    try {
      zapiszFakturaDlaKazdego(db, true);
      expect((await get(app, ADRES, admin)).body).toContain(PDF);
      zapiszKonsumenckie(db, true);
      expect((await get(app, ADRES, admin)).body).not.toContain(PDF);
      zapiszKonsumenckie(db, false);
      expect((await get(app, ADRES, admin)).body).toContain(PDF);
    } finally { await app.close(); db.close(); }
  });
});

describe('PRZ-126.F04 warunek włączenia przy TwojeFaktury', () => {
  it.runIf(szewTwojeFaktury).each([undefined, false])('bez konsumenckich odmawia włączenia bez zmiany wiersza (%s)', async (wlaczone) => {
    const { app, db, admin } = panel('twojefaktury');
    try {
      zapiszKonsumenckie(db, false);
      if (wlaczone !== undefined) zapiszFakturaDlaKazdego(db, wlaczone);
      const przed = wiersz(db);
      const r = await post(app, ZAPIS, admin, { dlaKazdego: 'tak' });
      expect(r.statusCode).toBe(400);
      expect(ustawieniaProgramu.BLAD_WLACZENIA_BEZ_KSEF).toBeTypeOf('string');
      // PRZ-126 DRB: zdanie odmowy raz (pas błędów), nie drugi raz pod polem.
      expect(r.body.split(ustawieniaProgramu.BLAD_WLACZENIA_BEZ_KSEF).length - 1).toBe(1);
      expect(wiersz(db)).toEqual(przed);
    } finally { await app.close(); db.close(); }
  });

  // PRZ-126 DRB (piaskownica): „Zapisz” bez zmian przy opcji już włączonej to nie włączanie — bez 400.
  it.runIf(szewTwojeFaktury)('bez konsumenckich zapis „tak” przy już włączonej opcji przechodzi', async () => {
    const { app, db, admin } = panel('twojefaktury');
    try {
      zapiszKonsumenckie(db, false);
      zapiszFakturaDlaKazdego(db, true);
      expect((await post(app, ZAPIS, admin, { dlaKazdego: 'tak' })).statusCode).toBe(303);
      expect(czyFakturaDlaKazdego(db)).toBe(true);
    } finally { await app.close(); db.close(); }
  });

  it.runIf(szewTwojeFaktury)('z konsumenckimi pozwala włączyć', async () => {
    const { app, db, admin } = panel('twojefaktury');
    try {
      zapiszKonsumenckie(db, true);
      expect((await post(app, ZAPIS, admin, { dlaKazdego: 'tak' })).statusCode).toBe(303);
      expect(czyFakturaDlaKazdego(db)).toBe(true);
      expect(pole((await get(app, ADRES, admin)).body)).not.toContain('disabled');
    } finally { await app.close(); db.close(); }
  });

  it.runIf(szewTwojeFaktury)('bez konsumenckich pozwala wyłączyć już włączoną opcję', async () => {
    const { app, db, admin } = panel('twojefaktury');
    try {
      zapiszKonsumenckie(db, false);
      zapiszFakturaDlaKazdego(db, true);
      const ekran = await get(app, ADRES, admin);
      expect(pole(ekran.body)).toContain('checked');
      expect(pole(ekran.body)).not.toContain('disabled');
      expect(ekran.body).toContain(PDF);
      expect((await post(app, ZAPIS, admin, {})).statusCode).toBe(303);
      expect(czyFakturaDlaKazdego(db)).toBe(false);
    } finally { await app.close(); db.close(); }
  });

  it('inFakt bez konsumenckich nadal pozwala włączyć', async () => {
    const { app, db, admin } = panel('infakt');
    try {
      zapiszKonsumenckie(db, false);
      expect((await post(app, ZAPIS, admin, { dlaKazdego: 'tak' })).statusCode).toBe(303);
      expect(czyFakturaDlaKazdego(db)).toBe(true);
    } finally { await app.close(); db.close(); }
  });

  it.runIf(szewTwojeFaktury)('wyłączona opcja bez konsumenckich ma disabled i wyjaśnienie blokady', async () => {
    const { app, db, admin } = panel('twojefaktury');
    try {
      zapiszKonsumenckie(db, false);
      const ekran = await get(app, ADRES, admin);
      expect(ekran.statusCode).toBe(200);
      expect(pole(ekran.body)).toContain('disabled');
      expect(pole(ekran.body)).not.toContain('checked');
      expect(ustawieniaProgramu.BLAD_WLACZENIA_BEZ_KSEF).toBeTypeOf('string');
      expect(ekran.body).toContain(ustawieniaProgramu.BLAD_WLACZENIA_BEZ_KSEF);
    } finally { await app.close(); db.close(); }
  });
});
