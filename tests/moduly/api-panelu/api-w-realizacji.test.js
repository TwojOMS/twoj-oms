import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { pobierzZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zalozZamowienieReczne } from '../../../src/moduly/zamowienia/services/zamowienie-reczne.js';
import { parsujZamowienieZKarty } from '../../../src/domena/zamowienie-z-karty.js';
import { wyliczStatus } from '../../../src/domena/status.js';

// Akceptacja projektu przez klienta ma przenosic zamowienie z „Indywidualne" do
// „W realizacji" SAMA. Do 22.08.2026 robil to czlowiek, klikajac w OMS-ie belke statusu —
// czyli ta sama informacja byla wprowadzana dwa razy, a rozjazd („karta w realizacji,
// zamowienie dalej indywidualne") nie dawal o sobie znac w zaden sposob.

const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
const naglowki = {
  authorization: 'Basic ' + Buffer.from('adam:x').toString('base64'),
  origin: 'http://localhost',
  host: 'localhost',
};

const cialo = {
  kartaId: 'karta-abc',
  klient: { first_name: 'Jan', last_name: 'Kowalski', email: 'jan@example.com', phone: '500900008' },
  dostawa: { first_name: 'Jan', last_name: 'Kowalski', address_1: 'Długa 45', postcode: '30-001', city: 'Kraków' },
  nip: null, chceFakture: false,
  kosztDostawyBrutto: '19.00',
  pozycje: [{ nazwa: 'Lampa wisząca — Kopuła 40x60cm', ilosc: 1, cena_brutto: '250.00' }],
  uwagi: 'Zamówienie indywidualne — karta karta-abc',
};

let db, app, id;
// Log czytamy wprost z bazy (ta sama droga, co w pozostalych testach OMS-u).
const logi = (akcja) => db.prepare('SELECT * FROM log WHERE zamowienie_id = ? AND akcja = ? ORDER BY id').all(id, akcja);
const zaloz = () => zalozZamowienieReczne({
  db, dane: parsujZamowienieZKarty(cialo), znacznik: new Date().toISOString(), okresId: null,
}).id;
const wyslij = (docelowe = id) => app.inject({ method: 'POST', url: `/api/zamowienia/${docelowe}/w-realizacji`, headers: naglowki });

beforeEach(async () => {
  db = openOmsDb(':memory:');
  app = buildOmsServer({ db, config });
  await app.ready();
  id = zaloz();
});

describe('POST /api/zamowienia/:id/w-realizacji', () => {
  it('zamowienie indywidualne przechodzi do realizacji', async () => {
    // Warunek sensu testu: PRZED wywolaniem zamowienie ma byc „indywidualne".
    // Bez tego sprawdzenia test przechodzilby takze wtedy, gdyby status byl juz zmieniony.
    expect(wyliczStatus(pobierzZamowienie(db, id))).toBe('indywidualne');

    const res = await wyslij();
    expect(res.statusCode).toBe(200);

    const z = pobierzZamowienie(db, id);
    expect(z.w_realizacji_at).toBeTruthy();
    expect(wyliczStatus(z)).toBe('w_realizacji');
  });

  it('odpowiedz mowi, co sie stalo — panel zapisuje to w logu karty', async () => {
    const dane = (await wyslij()).json();
    expect(dane).toMatchObject({ id, status: 'w_realizacji' });
    expect(dane.numer).toMatch(/^R\/2026\/\d+$/);
  });

  it('drugie wywolanie NIE przestawia daty (idempotencja pollera)', async () => {
    await wyslij();
    const pierwsza = pobierzZamowienie(db, id).w_realizacji_at;
    const res = await wyslij();
    expect(res.statusCode).toBe(200);
    expect(pobierzZamowienie(db, id).w_realizacji_at).toBe(pierwsza);
  });

  it('log mowi wprost, ze zrobil to AUTOMAT, a nie czlowiek przy panelu', async () => {
    await wyslij();
    const wpisy = logi('status.automat');
    expect(wpisy).toHaveLength(1);
    expect(wpisy[0].wynik).toMatch(/zaakceptował projekt/);
    expect(wpisy[0].wynik).toMatch(/W realizacji/);
  });

  it('nie zasmieca logu przy powtorkach — drugi przebieg pollera nie dopisuje wiersza', async () => {
    await wyslij();
    await wyslij();
    expect(logi('status.automat')).toHaveLength(1);
  });

  it('nieznane zamowienie → 404', async () => {
    const res = await wyslij(999999);
    expect(res.statusCode).toBe(404);
  });

  it('bez logowania → 401 (trasa nie jest wyjeta spod ochrony)', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/zamowienia/${id}/w-realizacji`, headers: { origin: 'http://localhost', host: 'localhost' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/zamowienia/:id/w-realizacji — czego NIE wolno cofnac', () => {
  it('⚠️ zamowienia WYSLANEGO nie cofa do realizacji', async () => {
    // `faktyDlaStatusu(z,'w_realizacji')` KASUJE `wyslane_at` — to poprawne przy swiadomym
    // cofnieciu z belki karty, ale zabojcze tutaj: spozniona akceptacja zdjelaby zamowieniu
    // status „Wyslane", paczka wrocilaby na liste robocza i dalaby sie nadac drugi raz.
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run('2026-08-20T10:00:00.000Z', id);
    const res = await wyslij();
    expect(res.statusCode).toBe(409);
    const z = pobierzZamowienie(db, id);
    expect(z.wyslane_at).toBe('2026-08-20T10:00:00.000Z');
    expect(wyliczStatus(z)).toBe('wyslane');
  });

  it('zamowienia ANULOWANEGO nie wskrzesza', async () => {
    db.prepare('UPDATE zamowienia SET anulowane_recznie = 1 WHERE id = ?').run(id);
    const res = await wyslij();
    expect(res.statusCode).toBe(409);
    expect(wyliczStatus(pobierzZamowienie(db, id))).toBe('anulowane');
  });

  it('zamowienia ze ZWROTEM nie przestawia', async () => {
    db.prepare('UPDATE zamowienia SET zwrot_at = ? WHERE id = ?').run('2026-08-20T10:00:00.000Z', id);
    const res = await wyslij();
    expect(res.statusCode).toBe(409);
    expect(wyliczStatus(pobierzZamowienie(db, id))).toBe('zwrot');
  });

  it('odmowa niesie powod czytelny dla czlowieka, nie sam kod', async () => {
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run('2026-08-20T10:00:00.000Z', id);
    const { powod } = (await wyslij()).json();
    expect(powod).toMatch(/wysłan/i);
  });

  it('odmowa zostawia slad w logu zamowienia', async () => {
    db.prepare('UPDATE zamowienia SET wyslane_at = ? WHERE id = ?').run('2026-08-20T10:00:00.000Z', id);
    await wyslij();
    const wpisy = logi('status.automat');
    expect(wpisy.length).toBeGreaterThan(0);
    expect(wpisy[0].wynik).toMatch(/ODMOWA/);
  });
});
