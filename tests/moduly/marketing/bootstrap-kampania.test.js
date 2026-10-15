import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms, uruchomZegary } from '../../pomoc/bootstrap-parytetu.ts';

// OKABLOWANIE ZRODEL KAMPANII (Etapy 1-2, 2026-08-25).
//
// ⚠️ TO JEST TEST NA DOKLADNIE TE KLASE AWARII, KTORA W TYM REPO ZDARZYLA SIE JUZ TRZY RAZY:
// klient zbudowany i NIEWPIETY (albo czuwacz zbudowany i NIEURUCHOMIONY) wyglada z zewnatrz
// identycznie jak brak konfiguracji — zakladka po prostu milczy, bez bledu i bez sladu.
// Testy jednostkowe czuwacza podaja atrapy WPROST, wiec przechodza takze wtedy, gdy
// bootstrap w ogole ich nie buduje.

const PELNE = {
  OMS_AUTH_USER: 'adam', OMS_AUTH_PASS: 'x',
  OMS_DB_PATH: ':memory:',
  SHOP_PRO_URL: 'https://drugi-sklep.test', SHOP_PRO_CK: 'ck', SHOP_PRO_CS: 'cs',
};

const env = (nad = {}) => ({ ...PELNE, OMS_ETYKIETY_DIR: mkdtempSync(join(tmpdir(), 'oms-kamp-')), ...nad });
function wstawKampanieTestowa(db) {
  db.prepare(`INSERT INTO kampanie (kod,nazwa,od_dnia,do_dnia,sklep,cel_uzyc,ga4_wlasciwosc,ga4_sciezka,fale_json)
    VALUES (?,?,?,?,?,?,?,?,?)`).run('promo-test','Kampania testowa','2026-08-24','2026-09-07','sklep-test',10,
    '123456789','/promocja-test',JSON.stringify([
      {od:'2026-08-26',napis:'start reklam'}, {od:'2026-08-30',napis:'fala 2'}, {od:'2026-09-04',napis:'fala 3'}
    ]));
}

const META = { META_TOKEN: 'SEKRET-SYSTEM-USER', META_KONTA: 'act_101,act_202' };
const GA4 = { GA4_KLUCZ: '/data-oms/google-sa.json' };

describe('zbudujOms — źródła kampanii', () => {
  it('bez zmiennych nie buduje ani klientów, ani czuwacza (panel działa jak dotąd)', () => {
    const { metaKlient, ga4Klient, czuwaczKampanii } = zbudujOms({ env: env() });
    expect(metaKlient).toBeNull();
    expect(ga4Klient).toBeNull();
    expect(czuwaczKampanii).toBeNull();
  });

  it('token i konta Meta budują klienta i czuwacza', () => {
    const createMeta = vi.fn(() => ({ dzienneStatystyki: vi.fn() }));
    const { metaKlient, czuwaczKampanii } = zbudujOms({ env: env(META), createMeta });

    expect(createMeta).toHaveBeenCalledTimes(1);
    expect(createMeta.mock.calls[0][0]).toMatchObject({
      token: 'SEKRET-SYSTEM-USER',
      konta: ['act_101', 'act_202'],
    });
    expect(metaKlient).toBeTruthy();
    expect(czuwaczKampanii).toBeTruthy();
  });

  it('klucz GA4 buduje klienta ze ścieżką z konfiguracji', () => {
    const createGa4 = vi.fn(() => ({ dzienneStatystyki: vi.fn() }));
    const { ga4Klient, czuwaczKampanii } = zbudujOms({ env: env(GA4), createGa4 });

    expect(createGa4.mock.calls[0][0]).toMatchObject({ sciezkaKlucza: '/data-oms/google-sa.json' });
    expect(ga4Klient).toBeTruthy();
    expect(czuwaczKampanii).toBeTruthy();
  });

  // ⚠️ JEDNO ZRODLO WYSTARCZY: wymaganie kompletu znaczyloby, ze brak klucza Google gasi
  // takze wydatki z Mety — czyli jedna nieskonfigurowana rzecz zabiera druga, dzialajaca.
  it('samo jedno źródło wystarczy, żeby czuwacz powstał', () => {
    expect(zbudujOms({ env: env(META), createMeta: () => ({}) }).czuwaczKampanii).toBeTruthy();
    expect(zbudujOms({ env: env(GA4), createGa4: () => ({}) }).czuwaczKampanii).toBeTruthy();
  });

  // ⚠️⚠️ SEDNO: klient MUSI trafic do czuwacza. Zbudowany i niewpiety = zakladka milczy.
  it('zbudowani klienci NAPRAWDĘ trafiają do czuwacza', async () => {
    const dzienneStatystyki = vi.fn(async () => []);
    const { czuwaczKampanii, db } = zbudujOms({
      env: env({ ...META, ...GA4 }),
      createMeta: () => ({ dzienneStatystyki }),
      createGa4: () => ({ dzienneStatystyki }),
    });
    // Jawna neutralna kampania testowa ma okno 24.08–07.09 —
    // czuwacz pyta tylko o kampanie trwajace, wiec przesuwamy okno na „dzis".
    wstawKampanieTestowa(db);
    const dzis = new Date().toISOString().slice(0, 10);
    db.prepare('UPDATE kampanie SET od_dnia = ?, do_dnia = ?').run(dzis, dzis);

    await czuwaczKampanii.przebieg();
    // Dwa zrodla, jedna kampania — kazdy klient odpytany raz.
    expect(dzienneStatystyki).toHaveBeenCalledTimes(2);
  });

  it('literówka w koncie reklamowym wywala start, zamiast cicho nic nie mierzyć', () => {
    expect(() => zbudujOms({ env: env({ META_TOKEN: 'x', META_KONTA: '101' }) }))
      .toThrow(/nie wygląda na konto reklamowe/);
  });

  it('konta bez tokenu wywalają start (połowiczna konfiguracja jest głośna)', () => {
    expect(() => zbudujOms({ env: env({ META_KONTA: 'act_1' }) })).toThrow(/META_TOKEN/);
  });
});

describe('uruchomZegary — zegar kampanii', () => {
  it('czuwacz kampanii dostaje własny zegar', () => {
    const ustawInterwal = vi.fn(() => 'uchwyt');
    const czuwaczKampanii = { przebieg: vi.fn(async () => ({})) };
    uruchomZegary({ czuwaczKampanii, ustawInterwal });

    expect(ustawInterwal).toHaveBeenCalledTimes(1);
    // Tyknięcie naprawdę woła przebieg — sam `setInterval` z pustą funkcją przeszedłby test.
    ustawInterwal.mock.calls[0][0]();
    expect(czuwaczKampanii.przebieg).toHaveBeenCalled();
  });

  it('bez czuwacza nie zakłada zegara', () => {
    const ustawInterwal = vi.fn();
    uruchomZegary({ czuwaczKampanii: null, ustawInterwal });
    expect(ustawInterwal).not.toHaveBeenCalled();
  });

  // ⚠️ Odrzucona obietnica w `setInterval` to nieobsluzony wyjatek, ktory kladzie proces —
  // czyli awaria pomiaru marketingu zabijalaby CALY panel zamowien.
  it('awaria przebiegu nie wywraca procesu, tylko ląduje w logu', async () => {
    const ustawInterwal = vi.fn(() => 'uchwyt');
    const log = vi.fn();
    const czuwaczKampanii = { przebieg: vi.fn(async () => { throw new Error('Meta padła'); }) };
    uruchomZegary({ czuwaczKampanii, ustawInterwal, log });

    await ustawInterwal.mock.calls[0][0]();
    await new Promise((r) => { setTimeout(r, 0); });
    expect(log).toHaveBeenCalledWith('czuwacz kampanii:', 'Meta padła');
  });

  it('pominięty przebieg zostawia ślad w logu', async () => {
    const ustawInterwal = vi.fn(() => 'uchwyt');
    const log = vi.fn();
    const czuwaczKampanii = { przebieg: vi.fn(async () => ({ pominiety: true })) };
    uruchomZegary({ czuwaczKampanii, ustawInterwal, log });

    await ustawInterwal.mock.calls[0][0]();
    await new Promise((r) => { setTimeout(r, 0); });
    expect(log.mock.calls[0][0]).toMatch(/JESZCZE TRWA/);
  });
});
