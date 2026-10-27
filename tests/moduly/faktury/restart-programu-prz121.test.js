// PRZ-121.06 — przycisk „Uruchom OMS ponownie” na ekranie Moduł faktur (/ustawienia/integracje/program-fakturowy).
// Prawdziwy serwer (buildOmsServer) z prawdziwym modułem faktur; ubicie procesu podmienione szwem `zakonczProces`
// (inaczej test zabiłby vitesta). Globalny fetch podmieniony — nic nie wychodzi do programu fakturowego.
// Dane zmyślone („Pracownia Półcień”).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { MODULY } from '../../../src/moduly/lista.ts';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

const ADRES = '/ustawienia/integracje/program-fakturowy';
const RESTART = `${ADRES}/restart`;
const PRZYCISK = 'Uruchom OMS ponownie';
const OBJASNIENIE = 'Panel będzie niedostępny przez kilka sekund.';
const RECZNIE = 'Uruchom ponownie OMS (np. <code>docker compose restart oms</code>).';
const KLUCZ = 'zmyslony0klucz0z0pliku0restartu0prz121006';

let siec;
beforeEach(() => {
  siec = vi.fn(async () => new Response(JSON.stringify({ metainfo: { count: 0, total_count: 0 }, entities: [] }), { status: 200 }));
  vi.stubGlobal('fetch', siec);
});
afterEach(() => { vi.unstubAllGlobals(); });

/** Panel z kluczem w pliku (działa inFakt) i szwem ubicia; `zdarzenia` — kolejność odpowiedzi i ubicia. */
function panel(restart) {
  const zdarzenia = [];
  const zakonczProces = vi.fn(() => { zdarzenia.push('ubicie'); });
  const modul = createModulFaktury({ fabryki: { zakonczProces } });
  const env = { INFAKT_API_KEY: KLUCZ, ...(restart === undefined ? {} : { OMS_RESTART_Z_PANELU: restart }) };
  const p = nowyPanel({ env, moduly: MODULY.map((m) => (m.nazwa === 'faktury' ? modul : m)) });
  zalozKonto(p.db, { login: 'polcien', imie: 'Pracownia Półcień', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ida', imie: 'Ida', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ida').id, ['zamowienia', 'faktury', 'ustawienia']);
  return { ...p, zakonczProces, zdarzenia, admin: jako(p.db, 'polcien'), ida: jako(p.db, 'ida') };
}
const formularzRestartu = (html) => /<form id="modul-faktur-restart"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';
const poKolejce = () => new Promise((r) => setImmediate(r));

describe('PRZ-121.06 przycisk „Uruchom OMS ponownie”', () => {
  it('(a) admin, OMS_RESTART_Z_PANELU=tak, zapis inny niż działający: przycisk; POST → strona odświeżania, ubicie raz, po odpowiedzi', async () => {
    const { app, db, admin, zakonczProces, zdarzenia } = panel('tak');
    try {
      expect((await post(app, ADRES, admin, { program: 'brak' })).statusCode).toBe(303);
      const ekran = await get(app, ADRES, admin);
      expect(ekran.body).toContain('zadziała po ponownym uruchomieniu OMS-u');
      const f = formularzRestartu(ekran.body);
      expect(f).toContain(`action="${RESTART}"`);
      expect(f).toMatch(new RegExp(`<button class="btn" type="submit">${PRZYCISK}</button>`, 'u'));
      expect(ekran.body).toContain(OBJASNIENIE);
      expect(ekran.body).not.toContain(RECZNIE);

      // Odpowiedź dotarła do klienta, zanim proces dostał sygnał: ubicie najwcześniej po ukończeniu odpowiedzi.
      const r = await post(app, RESTART, admin);
      zdarzenia.push('odpowiedz');
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).toContain('OMS uruchamia się ponownie — strona odświeży się za kilka sekund');
      expect(r.body).toMatch(new RegExp(`<meta http-equiv="refresh" content="10; url=${ADRES}">`, 'u'));
      await poKolejce();
      expect(zakonczProces).toHaveBeenCalledTimes(1);
      expect(zdarzenia).toEqual(['odpowiedz', 'ubicie']);
    } finally { await app.close(); db.close(); }
  });

  it('(b) bez zmiennej: zamiast przycisku zdanie z poleceniem; POST nic nie robi, szew niewołany', async () => {
    const { app, db, admin, zakonczProces } = panel();
    try {
      await post(app, ADRES, admin, { program: 'brak' });
      const ekran = await get(app, ADRES, admin);
      expect(ekran.body).toContain('zadziała po ponownym uruchomieniu OMS-u');
      expect(formularzRestartu(ekran.body)).toBe('');
      expect(ekran.body).not.toContain(PRZYCISK);
      expect(ekran.body).toContain(RECZNIE);
      const r = await post(app, RESTART, admin);
      expect(r.statusCode).toBe(404);
      await poKolejce();
      expect(zakonczProces).not.toHaveBeenCalled();
    } finally { await app.close(); db.close(); }
  });

  it.each(['nie', 'TAKK', ''])('(b) wartość „%s” = brak przycisku, start bez błędu, POST 404', async (wartosc) => {
    const { app, db, admin, zakonczProces } = panel(wartosc);
    try {
      await post(app, ADRES, admin, { program: 'brak' });
      const ekran = await get(app, ADRES, admin);
      expect(ekran.statusCode).toBe(200);
      expect(ekran.body).not.toContain(PRZYCISK);
      expect((await post(app, RESTART, admin)).statusCode).toBe(404);
      await poKolejce();
      expect(zakonczProces).not.toHaveBeenCalled();
    } finally { await app.close(); db.close(); }
  });

  it('(c) operator z uprawnieniem „ustawienia”, bez admina: 403, szew niewołany', async () => {
    const { app, db, admin, ida, zakonczProces } = panel('tak');
    try {
      await post(app, ADRES, admin, { program: 'brak' });
      const r = await post(app, RESTART, ida);
      expect(r.statusCode).toBe(403);
      expect(formularzRestartu((await get(app, ADRES, ida)).body)).toBe('');
      await poKolejce();
      expect(zakonczProces).not.toHaveBeenCalled();
    } finally { await app.close(); db.close(); }
  });

  it('(d) nic nie czeka na restart: przycisku nie ma (także bez zapisu)', async () => {
    const { app, db, admin } = panel('tak');
    try {
      const bezZapisu = await get(app, ADRES, admin);
      expect(bezZapisu.body).not.toContain(PRZYCISK);
      expect((await post(app, ADRES, admin, { program: 'infakt' })).statusCode).toBe(303);
      const tenSam = await get(app, ADRES, admin);
      expect(tenSam.body).not.toContain('ponownym uruchomieniu');
      expect(tenSam.body).not.toContain(PRZYCISK);
    } finally { await app.close(); db.close(); }
  });
});
