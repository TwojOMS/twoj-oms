// PRZ-108.10 — poprawka po recenzji (D1). Token KSeF zapisany na ekranie, a panel nie zna NIP-u firmy (ani w pliku, ani
// w Ustawienia → Firma). Wcześniej „Sprawdź połączenie” mówiło „Najpierw zapisz token…”, czuwacz „brak tokenu KSeF”,
// a ekran Koszty „nie ma podpiętego KSeF” — mylące, bo token JEST. Teraz każde z tych miejsc nazywa przyczynę jednym
// zdaniem (ODMOWA_KSEF_BRAK_NIP). Odwrócony test recenzenta (scratchpad po/tests/recenzja-ksef-bez-nipu.test.js) +
// pełny skład. Sieć zabroniona, dane zmyślone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zrodloKsefKosztow, czuwaczZeZrodla, wizualizacjaZeZrodla, POWOD_BRAK_NIP, POWOD_BRAK_TOKENU } from '../../../src/moduly/koszty/ksef-ustawien.ts';
import { sprawdzFormularzKsef, ODMOWA_KSEF_BRAK_NIP } from '../../../src/domena/konfiguracja-ksef-kosztow.js';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako, get, post } from '../../pomoc/konta-prz068.js';
import { zapiszNipFirmy } from '../../../src/oms/db/nip-bdo-firmy.js';

const TOKEN = 'a'.repeat(40);
const ent = (s) => s.replaceAll('&', '&amp;').replaceAll('"', '&#34;').replaceAll("'", '&#39;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

describe('PRZ-108.10 KSeF z tokenem z panelu, bez NIP-u firmy — przyczyna wprost (źródło)', () => {
  it('formularz przyjmuje token bez NIP-u; sprawdzenie, czuwacz i PDF mówią o braku NIP-u, nie o braku tokenu', async () => {
    expect(sprawdzFormularzKsef({ token: TOKEN, nip: '' }, null, null).bledy).toEqual([]);
    let nip = null;
    const zrodlo = zrodloKsefKosztow({ wczytaj: () => ({ ustawienia: { nip: null }, sekrety: { token: TOKEN } }),
      nipSprzedawcy: () => nip, fabryka: vi.fn(() => ({})), zestaw: vi.fn(() => ({ czuwacz: { przebieg: async () => ({ ok: true }) } })) });
    expect(zrodlo.zapisany()).toBe(true);
    await expect(zrodlo.sprawdzZapisany()).rejects.toThrow(ODMOWA_KSEF_BRAK_NIP);
    expect(await czuwaczZeZrodla(zrodlo).przebieg()).toEqual({ pominiety: true, powod: POWOD_BRAK_NIP });
    expect(czuwaczZeZrodla(zrodlo).powodNiedostepnosci()).toBe(ODMOWA_KSEF_BRAK_NIP);
    await expect(wizualizacjaZeZrodla(zrodlo).pdf('1-2-3')).rejects.toThrow(ODMOWA_KSEF_BRAK_NIP);
    // Z NIP-em z panelu przyczyna znika.
    nip = '2222222222';
    expect(zrodlo.powodNiedostepnosci()).toBeNull();
    expect(await czuwaczZeZrodla(zrodlo).przebieg()).toEqual({ ok: true });
  });

  it('bez tokenu nic się nie zmienia: „brak tokenu KSeF” i „Najpierw zapisz token”', async () => {
    const zrodlo = zrodloKsefKosztow({ wczytaj: () => null, nipSprzedawcy: () => null, fabryka: vi.fn(), zestaw: vi.fn() });
    expect(zrodlo.powodNiedostepnosci()).toBeNull();
    await expect(zrodlo.sprawdzZapisany()).rejects.toThrow('Najpierw zapisz token');
    expect(await czuwaczZeZrodla(zrodlo).przebieg()).toEqual({ pominiety: true, powod: POWOD_BRAK_TOKENU });
  });
});

describe('PRZ-108.10 KSeF bez NIP-u firmy — pełny skład (ekrany)', () => {
  let katalog;
  beforeEach(() => {
    katalog = mkdtempSync(join(tmpdir(), 'prz108-10-ksef-'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Sieć zabroniona'); });
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(katalog, { recursive: true, force: true }); });

  it('Sprawdź połączenie, ekran Koszty i Odśwież teraz mówią o braku NIP-u; po wpisaniu NIP-u to zdanie znika', async () => {
    const env = { OMS_TRYB: 'produkcja', OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog };
    const a = await zbudujOms({ env, moduly: modulyDla(env) });
    try {
      zalozKonto(a.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
      const admin = jako(a.db, 'adam');
      expect((await post(a.app, '/ustawienia/integracje/ksef', admin, { token: TOKEN, nip: '' })).statusCode).toBe(303);
      const ekranKsef = await get(a.app, '/ustawienia/integracje/ksef', admin);
      expect(ekranKsef.body).toContain(ent(ODMOWA_KSEF_BRAK_NIP));
      const sprawdz = await post(a.app, '/ustawienia/integracje/ksef/sprawdz', admin);
      expect(sprawdz.body).toContain(ent(ODMOWA_KSEF_BRAK_NIP));
      expect(sprawdz.body).not.toContain('Najpierw zapisz token');
      const koszty = await get(a.app, '/koszty', admin);
      expect(koszty.statusCode, koszty.body).toBe(200);
      expect(koszty.body).toContain(ent(ODMOWA_KSEF_BRAK_NIP));
      expect(koszty.body).not.toContain('nie ma podpiętego KSeF');
      const odswiez = await post(a.app, '/koszty/odswiez', admin);
      expect(odswiez.statusCode).toBe(503);
      expect(odswiez.body).toBe(ODMOWA_KSEF_BRAK_NIP);

      zapiszNipFirmy(a.db, '2222222222');
      expect((await get(a.app, '/koszty', admin)).body).not.toContain(ent(ODMOWA_KSEF_BRAK_NIP));
      expect((await get(a.app, '/ustawienia/integracje/ksef', admin)).body).not.toContain(ent(ODMOWA_KSEF_BRAK_NIP));
    } finally { await a.app.close(); a.db.close(); }
  });
});
