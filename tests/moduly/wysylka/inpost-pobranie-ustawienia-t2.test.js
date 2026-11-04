// PRZ-135.T2.03 — Ustawienia → Integracje → Kurier InPost: przełącznik „Mam umowę z InPostem na przesyłki za pobraniem”.
// ⚠️ PIENIĄDZE: włączenie dopuszcza paczkomat przy pobraniu. Domyślnie wyłączone; tylko pole z value="tak" włącza;
// „Odłącz” wyłącza (nowe konto to może być nowa umowa). Prawdziwy serwer, zmyślone dane, zero sieci.
import { describe, it, expect, vi } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { nazwaCiasteczkaOms } from '../../../src/core/bezpieczenstwo/sesja.js';
import { umowyPobraniaFirmy, zapiszUmowePobrania } from '../../../src/moduly/wysylka/db/umowy-pobrania.js';
import { jako, get, post, CONFIG, POLLER } from '../../pomoc/konta-prz068.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { modulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { modulWiadomosci } from '../../../src/moduly/wiadomosci/modul.ts';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { modulMarketing } from '../../../src/moduly/marketing/modul.ts';
import { modulZdrowie } from '../../../src/moduly/zdrowie/modul.ts';

const NADAWCA = { DPD_NADAWCA_NAZWA: 'Pracownia Półcień', DPD_NADAWCA_ULICA: 'Zmyślona 1', DPD_NADAWCA_KOD: '00-950',
  DPD_NADAWCA_MIASTO: 'Warszawa', DPD_NADAWCA_TELEFON: '000000000', DPD_NADAWCA_EMAIL: 'nadawca@example.invalid' };
const FORMULARZ = { nazwa: 'InPost', organizacja: '4242', token: 'eyJ.ZMYSLONY-T2.podpis', paczkomatNadawczy: '' };
const ADRES = '/ustawienia/integracje/inpost';
const POBRANIE = `${ADRES}/pobranie`;
const KLUCZ = 'wysylka.umowa_pobrania.inpost';

// `demo` jak w web.config instancji z kontem gościa (OMS_TRYB=proba): wtedy stoi wspólna blokada POST z podglad-demo.js.
function panel({ env = NADAWCA, demo = null } = {}) {
  const createInpost = vi.fn(() => ({ nadaj: vi.fn(), sprawdzPrzesylke: vi.fn(), pobierzEtykiete: vi.fn(),
    statusPrzesylki: vi.fn(), sprawdzPolaczenie: vi.fn(async () => ({ ok: true })) }));
  const moduly = [modulRdzen, modulWeb, modulKanaly, modulFaktury, modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
    createModulWysylka({ fabryki: { createInpost } }), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie];
  const db = openOmsDb(':memory:');
  const config = { auth: { ...CONFIG.auth }, ...(demo ? { proba: true, demo } : {}) };
  const p = { db, app: buildOmsServer({ poller: POLLER, moduly, env, db, config }) };
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}
const wartosc = (db) => db.prepare('SELECT wartosc FROM ustawienia WHERE klucz = ?').get(KLUCZ)?.wartosc ?? null;
const sekcja = (html) => /<section[^>]*id="inpost-pobranie"[\s\S]*?<\/section>/u.exec(html)?.[0] ?? '';

describe('PRZ-135.T2.03 przełącznik umowy na pobranie w InPoście', () => {
  it('pusty ekran: sekcja z polem (niezaznaczonym), formularz POST …/pobranie, stan „wyłączone”', async () => {
    const { app, admin } = panel();
    const r = await get(app, ADRES, admin);
    expect(r.statusCode, r.body).toBe(200);
    const s = sekcja(r.body);
    expect(s).toContain('Mam umowę z InPostem na przesyłki za pobraniem');
    expect(s).toContain(`action="${POBRANIE}"`);
    expect(s).toMatch(/<input[^>]*type="checkbox"[^>]*name="umowa"[^>]*value="tak"/u);
    expect(s).not.toMatch(/name="umowa"[^>]*checked/u);
    expect(s).toContain('wyłączone');
    // PRZ-142.01: opis zgodny z regułą PRZ-137.03 — bez „kurierem DPD”, z podziałem sklep / OMS.
    expect(s).not.toContain('DPD');
    expect(s).toContain('pobranie sprzedane przez sklep (paczka nr 1');
    expect(s).toContain('zamiennik za pobraniem (paczka nr 2 i kolejne)');
  });

  it('POST z polem → „tak”, przekierowanie z komunikatem; bez pola → „nie”', async () => {
    const { app, admin, db } = panel();
    const wl = await post(app, POBRANIE, admin, { umowa: 'tak' });
    expect(wl.statusCode, wl.body).toBe(303);
    expect(wl.headers.location).toBe(`${ADRES}?zapisano=pobranie-tak`);
    expect(wartosc(db)).toBe('tak');
    expect(umowyPobraniaFirmy(db)).toEqual(['inpost']);
    expect((await get(app, wl.headers.location, admin)).body).toContain('Umowa na pobranie w InPoście: włączona.');

    const wy = await post(app, POBRANIE, admin, {});
    expect(wy.statusCode).toBe(303);
    expect(wy.headers.location).toBe(`${ADRES}?zapisano=pobranie-nie`);
    expect(wartosc(db)).toBe('nie');
    expect(umowyPobraniaFirmy(db)).toEqual([]);
    expect((await get(app, wy.headers.location, admin)).body).toContain('Umowa na pobranie w InPoście: wyłączona.');
  });

  it('wartość pola inna niż „tak” nie włącza (nie, 0, true, puste)', async () => {
    const { app, admin, db } = panel();
    for (const umowa of ['nie', '0', 'true', '', 'TAK']) {
      zapiszUmowePobrania(db, 'inpost', true);
      expect((await post(app, POBRANIE, admin, { umowa })).statusCode).toBe(303);
      expect(wartosc(db), umowa).toBe('nie');
    }
  });

  it('GET po włączeniu: pole zaznaczone, stan „włączone od” z datą zmiany', async () => {
    const { app, admin, db } = panel();
    zapiszUmowePobrania(db, 'inpost', true);
    db.prepare('UPDATE ustawienia SET zmienione_at = ? WHERE klucz = ?').run('2026-03-11T09:30:00.000Z', KLUCZ);
    const s = sekcja((await get(app, ADRES, admin)).body);
    expect(s).toMatch(/name="umowa"[^>]*checked/u);
    expect(s).toContain('włączone od 2026-03-11 10:30');
  });

  it('GET po wyłączeniu z datą: „wyłączone od …”', async () => {
    const { app, admin, db } = panel();
    zapiszUmowePobrania(db, 'inpost', false);
    db.prepare('UPDATE ustawienia SET zmienione_at = ? WHERE klucz = ?').run('2026-03-11T09:30:00.000Z', KLUCZ);
    const s = sekcja((await get(app, ADRES, admin)).body);
    expect(s).not.toMatch(/name="umowa"[^>]*checked/u);
    expect(s).toContain('wyłączone od 2026-03-11 10:30');
  });

  it('InPost w pliku .env: sekcja jest na ekranie, zapis działa (bez 409)', async () => {
    const env = { ...NADAWCA, INPOST_TOKEN: 'eyJ.Z-PLIKU.zmyslony', INPOST_ORGANIZACJA: '1' };
    const { app, admin, db } = panel({ env });
    const ekran = await get(app, ADRES, admin);
    expect(ekran.body).toContain('Ustawione przez administratora serwera');
    expect(sekcja(ekran.body)).toContain(`action="${POBRANIE}"`);
    const r = await post(app, POBRANIE, admin, { umowa: 'tak' });
    expect(r.statusCode, r.body).toBe(303);
    expect(wartosc(db)).toBe('tak');
  });

  it('„Odłącz InPost” wyłącza umowę na pobranie', async () => {
    const { app, admin, db } = panel();
    await post(app, ADRES, admin, FORMULARZ);
    await post(app, POBRANIE, admin, { umowa: 'tak' });
    expect(wartosc(db)).toBe('tak');
    expect((await post(app, `${ADRES}/odlacz`, admin, {})).statusCode).toBe(303);
    expect(wartosc(db)).toBe('nie');
    expect(umowyPobraniaFirmy(db)).toEqual([]);
  });

  it('konto bez prawa „ustawienia” — 403, nic nie zapisane', async () => {
    const { app, ewa, db } = panel();
    expect((await post(app, POBRANIE, ewa, { umowa: 'tak' })).statusCode).toBe(403);
    expect(wartosc(db)).toBeNull();
  });

  it('gość demo — odmowa zapisu, nic nie zapisane', async () => {
    const { app, db } = panel({ demo: { login: 'adam' } });
    const gosc = { cookie: jako(db, 'adam').cookie.replace(/^[^=]+=/u, `${nazwaCiasteczkaOms(true)}=`) };
    const r = await post(app, POBRANIE, gosc, { umowa: 'tak' });
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('W wersji demonstracyjnej ustawienia można tylko obejrzeć');
    expect(wartosc(db)).toBeNull();
  });
});
