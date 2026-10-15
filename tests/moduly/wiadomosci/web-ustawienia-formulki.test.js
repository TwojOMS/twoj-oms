import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { wczytajUstawienia } from '../../../src/oms/db/ustawienia.js';
import { KLUCZE } from '../../../src/domena/ustawienia-formulki.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

// ⚠️ `origin` obowiazkowy przy POST — OMS odrzuca 403 kazdy zapis bez zgodnego naglowka.
const AUTH = {
  authorization: `Basic ${Buffer.from('adam:x').toString('base64')}`,
  origin: 'http://localhost',
};
const CONFIG = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

let db; let app;
const wejdz = (opcje) => app.inject({ ...opcje, headers: AUTH });

beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: CONFIG, lacznosc: { sprawdz: async () => [] } });
});

describe('/ustawienia/wiadomosci-i-automatyzacje — autoresponder Allegro', () => {
  it('ekran pokazuje sekcję autorespondera i domyślnie WYŁĄCZONY', async () => {
    const r = await wejdz({ method: 'GET', url: '/ustawienia/wiadomosci-i-automatyzacje' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/autoresponder/i);
    expect(r.body).toContain('name="wlaczona"');
    // Brak `checked` przy wyłączonym — panel wdrożony bez decyzji człowieka NIE MOŻE pisać.
    expect(r.body).not.toMatch(/name="wlaczona"[^>]*checked/);
  });

  it('zapisuje włączony autoresponder z treścią, oknem i dniami', async () => {
    await wejdz({
      method: 'POST',
      url: '/ustawienia/formulka',
      payload: { wlaczona: 'on', tresc: 'Odpiszemy rano.', od: '18', do: '8', dni: ['1', '2'], karencja: '10' },
    });
    const u = wczytajUstawienia(db);
    expect(u[KLUCZE.wlaczony]).toBe('1');
    expect(u[KLUCZE.tresc]).toBe('Odpiszemy rano.');
    expect(u[KLUCZE.od]).toBe('18');
    expect(u[KLUCZE.do]).toBe('8');
    expect(u[KLUCZE.dni]).toBe('1,2');
  });

  it('ODMAWIA zapisu formułki dłuższej niż 2000 znaków i NIC nie zapisuje', async () => {
    const r = await wejdz({
      method: 'POST',
      url: '/ustawienia/formulka',
      payload: { wlaczona: 'on', tresc: 'x'.repeat(2001), od: '18', do: '8', dni: ['1'], karencja: '10' },
    });
    expect(r.statusCode).toBe(400);
    // ⚠️ NIC, a nie „to, co przeszło" — zapis częściowy zostawiłby autoresponder włączony
    // ze starą treścią i nowym oknem, czyli w stanie, którego nikt nie wybrał.
    expect(wczytajUstawienia(db)[KLUCZE.tresc]).toBeUndefined();
    expect(wczytajUstawienia(db)[KLUCZE.od]).toBeUndefined();
  });

  it('ODMAWIA włączenia bez ani jednego dnia', async () => {
    const r = await wejdz({
      method: 'POST',
      url: '/ustawienia/formulka',
      payload: { wlaczona: 'on', tresc: 'ok', od: '18', do: '8', karencja: '10' },
    });
    expect(r.statusCode).toBe(400);
    expect(wczytajUstawienia(db)[KLUCZE.wlaczony]).toBeUndefined();
  });

  it('WYŁĄCZENIE przechodzi nawet z pustą treścią — trzeba móc zgasić zły autoresponder', async () => {
    await wejdz({
      method: 'POST',
      url: '/ustawienia/formulka',
      payload: { tresc: '', od: '18', do: '8', karencja: '10' },
    });
    expect(wczytajUstawienia(db)[KLUCZE.wlaczony]).toBe('0');
  });

  it('po zapisie ekran pokazuje zapisane wartości', async () => {
    await wejdz({
      method: 'POST',
      url: '/ustawienia/formulka',
      payload: { wlaczona: 'on', tresc: 'Jesteśmy poza godzinami.', od: '19', do: '7', dni: ['5'], karencja: '15' },
    });
    const r = await wejdz({ method: 'GET', url: '/ustawienia/wiadomosci-i-automatyzacje' });
    expect(r.body).toContain('Jesteśmy poza godzinami.');
    expect(r.body).toMatch(/name="wlaczona"[^>]*checked/);
  });
});
