// PRZ-089: czysta instalacja bez kanałów (OMS_KANALY=[]) po przejściu na pracę. Pollerów nie ma, /health mówi
// `zdrowy: true, zrodla: []`, a lista do 16.10.2026 pokazywała na czerwono „Brak synchronizacji — poller nie
// wykonał jeszcze przebiegu.” bez końca (próbna instalacja: po 6 min to samo). Nowicjusz czyta to jak awarię.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';

const katalogi = [];
afterEach(() => { vi.unstubAllGlobals(); for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true }); });

async function lista(env) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Sieć zabroniona'); }));
  const a = await zbudujOms({ env });
  try {
    zalozKonto(a.db, { login: 'wlasciciel', imie: 'Właściciel', haslo: 'haslo-testowe-089', rola: 'administrator', admin: true });
    const login = await a.app.inject({ method: 'POST', url: '/login', headers: { origin: 'http://localhost' }, payload: { uzytkownik: 'wlasciciel', haslo: 'haslo-testowe-089', powrot: '/' } });
    expect(login.statusCode, login.body).toBe(302);
    const cookie = [].concat(login.headers['set-cookie']).find(c => c.startsWith(`${NAZWA_CIASTECZKA_OMS}=`)).split(';')[0];
    const r = await a.app.inject({ url: '/', headers: { cookie } });
    expect(r.statusCode, r.body).toBe(200);
    return r.body;
  } finally { await a.app.close(); a.db.close?.(); }
}

describe('PRZ-089 lista zamówień bez podłączonych kanałów', () => {
  it('nie straszy „Brak synchronizacji”, tylko mówi, że kanałów nie ma', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'oms089-bez-kanalow-')); katalogi.push(katalog);
    const html = await lista({
      OMS_TRYB: 'produkcja', OMS_DB_PATH: join(katalog, 'oms.sqlite'), OMS_USER: 'operator', OMS_PASS: 'atrapa',
      OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_KANALY: '[]',
      OMS_ETYKIETY_KATALOG: katalog, OMS_PROFORMY_KATALOG: katalog,
    });
    expect(html).not.toContain('Brak synchronizacji');
    expect(html).toContain('Żaden kanał sprzedaży nie jest podłączony');
    // Filtr kanałów obcego człowieka: bez „Indywidualne” (kanał panelu zamówień indywidualnych Szkicownia).
    expect(html).toContain('<option value="reczne"');
    expect(html).not.toContain('<option value="indywidualne"');
  });
  it('z OMS_KANAL_INDYWIDUALNY=1 filtr ma „Indywidualne” jak dotąd', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'oms089-indyw-')); katalogi.push(katalog);
    const html = await lista({
      OMS_TRYB: 'produkcja', OMS_DB_PATH: join(katalog, 'oms.sqlite'), OMS_USER: 'operator', OMS_PASS: 'atrapa',
      OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000', OMS_KANALY: '[]',
      OMS_ETYKIETY_KATALOG: katalog, OMS_PROFORMY_KATALOG: katalog, OMS_KANAL_INDYWIDUALNY: '1',
    });
    expect(html).toContain('<option value="indywidualne"');
  });
  it('z kanałami i bez przebiegu pollera nadal ostrzega jak dotąd', async () => {
    const html = await lista({ ...ENV_DEMO, OMS_TRYB: 'produkcja', OMS_USER: 'operator', OMS_PASS: 'atrapa', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() });
    expect(html).toContain('Brak synchronizacji — poller nie wykonał jeszcze przebiegu.');
    expect(html).not.toContain('Żaden kanał sprzedaży nie jest podłączony');
  });
});
