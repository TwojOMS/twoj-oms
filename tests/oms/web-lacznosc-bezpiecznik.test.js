import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { zapiszStanWeryfikacji } from '../../src/oms/db/stan-weryfikacji.js';
import { buildOmsServer } from '../pomoc/serwer-parytetu.ts';

// NIC PO CICHU. Bezpiecznik, ktory w milczeniu przestaje pytac, jest gorszy od bledu —
// dlatego jego stan musi byc widoczny na ekranie lacznosci.

const AUTH = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };
const CONFIG = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

let db; let app;
const wejdz = (opcje) => app.inject({ ...opcje, headers: AUTH });

beforeEach(() => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config: CONFIG, lacznosc: { sprawdz: async () => [] } });
});

describe('bezpiecznik weryfikacji na ekranie łączności', () => {
  it('otwarty bezpiecznik jest WIDOCZNY, z nazwą kanału i datą', async () => {
    zapiszStanWeryfikacji(db, 'allegro_szkicownia', {
      kolejnePuste: 3, bezpiecznikOd: '2026-08-20T10:00:00Z', ostatniaProbaAt: '2026-08-28T11:00:00Z',
    });

    const r = await wejdz({ method: 'GET', url: '/ustawienia/lacznosc' });

    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('allegro_szkicownia');
    expect(r.body).toContain('2026-08-20');
    expect(r.body).toMatch(/raz na dobę/i);
  });

  it('bez otwartych bezpieczników ekran nie straszy — sekcji nie ma', async () => {
    const r = await wejdz({ method: 'GET', url: '/ustawienia/lacznosc' });

    expect(r.statusCode).toBe(200);
    expect(r.body).not.toMatch(/raz na dobę/i);
  });

  it('zamknięty bezpiecznik nie jest pokazywany jako otwarty', async () => {
    zapiszStanWeryfikacji(db, 'allegro_szkicownia', {
      kolejnePuste: 0, bezpiecznikOd: null, ostatniaProbaAt: '2026-08-28T11:00:00Z',
    });

    const r = await wejdz({ method: 'GET', url: '/ustawienia/lacznosc' });

    expect(r.body).not.toMatch(/raz na dobę/i);
  });
});
