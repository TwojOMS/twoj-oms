import { describe, it, expect, vi, afterEach } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { EKRAN_WYBORU_PROGRAMU } from '../../../src/domena/wybor-programu.js';
import { zapiszWyborProgramu } from '../../../src/oms/db/wybor-programu.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { modulWiadomosci } from '../../../src/moduly/wiadomosci/modul.ts';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { modulMarketing } from '../../../src/moduly/marketing/modul.ts';
import { modulZdrowie } from '../../../src/moduly/zdrowie/modul.ts';

// PRZ-174 B2 (zgubione uwagi recenzji PRZ-168, E4): ekrany Fakturowni i wyboru programu mówią „program do faktur”,
// nie „moduł faktur”. Tekst sprawdzany po zdjęciu znaczników, więc zmiana wcięcia nie czerwieni testów.
const ADRES = '/ustawienia/integracje/fakturownia';
const TOKEN = 'fikcyjnyTokenPrz174Q7xZ';
const DOMENA = 'pracownia-polcien-174';
afterEach(() => vi.unstubAllGlobals());
function panel(env = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200 })));
  const p = nowyPanel({ moduly: [modulRdzen, modulWeb, modulKanaly, createModulFaktury(), modulWiadomosci,
    createModulZamowienia({ zWiadomosciami: true }), createModulWysylka(), modulMagazyn,
    modulUstawienia, modulMarketing, modulZdrowie], env });
  zalozKonto(p.db, { login: 'operator', haslo: 'h', rola: 'administrator', admin: true });
  return { ...p, admin: jako(p.db, 'operator') };
}
const tekst = (html) => html.replace(/<script[\s\S]*?<\/script>/gu, ' ').replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').replace(/ ([.,;:])/gu, '$1');
const pasUruchomienia = (html) => tekst(/id="fakturownia-uruchomienie"[\s\S]*?<\/div>/u.exec(html)?.[0] ?? '');

describe('PRZ-174 B2 ekran Fakturowni: „program do faktur”', () => {
  it('niewybrana: „Wybierz ją na ekranie Program do faktur”, a nie o „module”', async () => {
    const p = panel();
    try {
      expect((await post(p.app, ADRES, p.admin, { domena: DOMENA, token: TOKEN })).statusCode).toBe(303);
      const r = await get(p.app, ADRES, p.admin);
      const pas = pasUruchomienia(r.body);
      expect(pas).toContain('Fakturownia jeszcze nie wystawia faktur. Wybierz ją na ekranie Program do faktur');
      expect(pas).not.toMatch(/moduł/iu);
    } finally { await p.app.close(); }
  });
  it('wybrana (z przyciskiem restartu i z poleceniem dla serwera): „jest wybrana jako program do faktur”, bez „modułu”', async () => {
    for (const env of [{ OMS_RESTART_Z_PANELU: 'tak' }, {}]) {
      const p = panel(env);
      try {
        expect((await post(p.app, ADRES, p.admin, { domena: DOMENA, token: TOKEN })).statusCode).toBe(303);
        zapiszWyborProgramu(p.db, 'fakturownia');
        const pas = pasUruchomienia((await get(p.app, ADRES, p.admin)).body);
        expect(pas).toContain('Fakturownia jest wybrana jako program do faktur. Zacznie wystawiać faktury po ponownym uruchomieniu OMS-u');
        expect(pas).not.toMatch(/moduł/iu);
      } finally { await p.app.close(); }
    }
  });
});

describe('PRZ-174 B2 ekran wyboru programu do faktur', () => {
  it('sekcja nazywa się „Wybór programu”, a cały ekran nie mówi „moduł faktur”', async () => {
    const p = panel();
    try {
      const r = await get(p.app, EKRAN_WYBORU_PROGRAMU, p.admin);
      expect(r.statusCode, r.body).toBe(200);
      const t = tekst(r.body);
      expect(t).toContain('Wybór programu');
      expect(t).toContain('Teraz działa');
      expect(t).not.toMatch(/moduł(u)? faktur/iu);
    } finally { await p.app.close(); }
  });
});
