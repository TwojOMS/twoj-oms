import { describe, it, expect, vi, afterEach } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { utworzAlarmAutoKsef } from '../../../src/moduly/faktury/db/alarm-auto-ksef.js';
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

const ADRES = '/ustawienia/integracje/fakturownia';
const TOKEN = 'fikcyjny/token+ekranu=prz11906';
const DOMENA = 'konto-probne-11906';
afterEach(() => vi.unstubAllGlobals());
function panel(env = {}, fabryki = undefined) {
  const siec = vi.fn(async () => new Response('[]', { status: 200 }));
  vi.stubGlobal('fetch', siec);
  const p = nowyPanel({ moduly: [modulRdzen, modulWeb, modulKanaly, createModulFaktury(fabryki ? { fabryki } : undefined), modulWiadomosci,
    createModulZamowienia({ zWiadomosciami: true }), createModulWysylka(), modulMagazyn,
    modulUstawienia, modulMarketing, modulZdrowie], env });
  zalozKonto(p.db, { login: 'operator', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'sprzedaz', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'sprzedaz').id, ['faktury']);
  return { ...p, admin: jako(p.db, 'operator'), sprzedaz: jako(p.db, 'sprzedaz'), siec };
}
async function zapisz(p) {
  const r = await post(p.app, ADRES, p.admin, { domena: DOMENA, token: TOKEN });
  expect(r.statusCode, r.body).toBe(303);
}
function bezTokenu(html) {
  expect(html).not.toContain(TOKEN);
  expect(html).not.toContain(encodeURIComponent(TOKEN));
  expect(html).toMatch(/name="token"[^>]*value=""/u);
}

describe('PRZ-119.06 Ustawienia → Fakturownia', () => {
  it('pusty ekran, wejście z katalogu, uprawnienia jak inFakt', async () => {
    const p = panel();
    try {
      const r = await get(p.app, ADRES, p.admin);
      expect(r.statusCode, r.body).toBe(200);
      bezTokenu(r.body);
      expect(r.body).toContain('autocomplete="new-password"');
      expect(r.body).toContain('type="password"');
      expect(r.body).toContain('Automatyczna wysyłka = Wyłączona');
      expect((await get(p.app, '/ustawienia/integracje/katalog', p.admin)).body).toContain(`href="${ADRES}"`);
      expect((await get(p.app, ADRES, p.sprzedaz)).statusCode).toBe(403);
      expect((await post(p.app, ADRES, p.sprzedaz, { domena: DOMENA, token: TOKEN })).statusCode).toBe(403);
    } finally { await p.app.close(); }
  });
  it('zapis i błędy zapisu nigdy nie zwracają tokenu; pusty token zachowuje zapisany', async () => {
    const p = panel();
    try {
      await zapisz(p);
      const ekran = await get(p.app, ADRES, p.admin);
      bezTokenu(ekran.body);
      expect(ekran.body).toContain('zapisany — wpisz nowy, żeby zmienić');
      expect((await get(p.app, '/ustawienia/integracje', p.admin)).body).toContain(`href="${ADRES}"`);
      for (const domena of ['zla/domena', 'zla.domena', 'zla@domena']) {
        const r = await post(p.app, ADRES, p.admin, { domena, token: TOKEN });
        expect(r.statusCode).toBe(400);
        bezTokenu(r.body);
        expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia').ustawienia.domena).toBe(DOMENA);
      }
      expect((await post(p.app, ADRES, p.admin, { domena: DOMENA, token: '' })).statusCode).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia').sekrety.token).toBe(TOKEN);
      expect(p.siec).not.toHaveBeenCalled();
    } finally { await p.app.close(); }
  });
  it('pierwszy błędny zapis też pozostawia puste pole tokenu', async () => {
    const p = panel();
    try {
      const r = await post(p.app, ADRES, p.admin, { domena: 'zla/domena', token: TOKEN });
      expect(r.statusCode).toBe(400);
      bezTokenu(r.body);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia')).toBeNull();
    } finally { await p.app.close(); }
  });
  it('plik ma pierwszeństwo, zapis = 409 bez ujawnienia wartości', async () => {
    const p = panel({ FAKTUROWNIA_API_TOKEN: TOKEN, FAKTUROWNIA_DOMENA: DOMENA });
    try {
      const r = await post(p.app, ADRES, p.admin, { domena: 'inne-konto', token: TOKEN });
      expect(r.statusCode).toBe(409);
      expect(r.body).toContain('Fakturownia jest ustawiona w pliku konfiguracji');
      for (const html of [r.body, (await get(p.app, ADRES, p.admin)).body]) {
        expect(html).not.toContain(TOKEN);
        expect(html).not.toContain(DOMENA);
      }
      expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia')).toBeNull();
    } finally { await p.app.close(); }
  });
  it('sprawdzenie bez zapisu daje zdanie; po zapisie tylko jeden odczyt, bez zapisu faktur', async () => {
    const p = panel();
    try {
      const brak = await post(p.app, `${ADRES}/sprawdz`, p.admin);
      expect(brak.statusCode).toBe(200);
      expect(brak.body).toContain('Najpierw zapisz');
      expect(p.siec).not.toHaveBeenCalled();
      await zapisz(p);
      const r = await post(p.app, `${ADRES}/sprawdz`, p.admin);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).toContain('Połączenie z Fakturownią działa');
      expect(p.siec).toHaveBeenCalledTimes(1);
      expect(String(p.siec.mock.calls[0][0])).toBe(`https://${DOMENA}.fakturownia.pl/invoices.json?page=1&per_page=1`);
      expect(p.siec.mock.calls[0][1].method).toBe('GET');
      expect(p.db.prepare('SELECT count(*) AS n FROM faktury').get().n).toBe(0);
    } finally { await p.app.close(); }
  });
  for (const status of [401, 403, 422, 500]) {
    it(`odmowa ${status}: komunikat bez tokenu i domeny (także kodowanych)`, async () => {
      const p = panel();
      try {
        await zapisz(p);
        p.siec.mockImplementation(async () => new Response(JSON.stringify({ message: `${TOKEN} ${encodeURIComponent(TOKEN)} ${DOMENA}` }), { status }));
        const r = await post(p.app, `${ADRES}/sprawdz`, p.admin);
        expect(r.statusCode).toBe(200);
        bezTokenu(r.body);
        const komunikat = /id="fakturownia-test"[\s\S]*?<\/div>/u.exec(r.body)?.[0];
        expect(komunikat).toBeTruthy();
        expect(komunikat).not.toContain(DOMENA);
        if (status === 401 || status === 403) expect(komunikat).toContain(`Fakturownia nie przyjęła tokenu (HTTP ${status}) — sprawdź, czy token jest skopiowany w całości i należy do użytkownika z dostępem do faktur.`);
      } finally { await p.app.close(); }
    });
  }
  it('jawny wybór Brak nie pozwala wysłać zapisanego tokenu przy sprawdzeniu', async () => {
    const p = panel({ OMS_PROGRAM_FAKTUROWY: 'brak' });
    try {
      await zapisz(p);
      const r = await post(p.app, `${ADRES}/sprawdz`, p.admin);
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Faktury w OMS-ie są wyłączone');
      expect(p.siec).not.toHaveBeenCalled();
    } finally { await p.app.close(); }
  });
  it('Odłącz usuwa tylko Fakturownię — konfiguracja inFaktu nietknięta', async () => {
    const p = panel();
    try {
      zapiszKonfiguracjeIntegracji(p.db, 'infakt', { ustawienia: {}, sekrety: { apiKey: 'klucz-testowy-infakt' } });
      await zapisz(p);
      const przed = wczytajKonfiguracjeIntegracji(p.db, 'infakt');
      expect(przed).not.toBeNull();
      expect((await post(p.app, `${ADRES}/odlacz`, p.admin)).statusCode).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia')).toBeNull();
      expect(wczytajKonfiguracjeIntegracji(p.db, 'infakt')).toEqual(przed);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'infakt')).not.toBeNull();
    } finally { await p.app.close(); }
  });
  it('Sprawdziłem gasi trwały alarm z dokumentami i datą, Odłącz usuwa wiersz', async () => {
    const p = panel();
    try {
      await zapisz(p);
      const alarm = utworzAlarmAutoKsef(p.db, { teraz: () => new Date('2026-11-12T10:00:00Z') });
      alarm.dopisz({ dokument: '11906', numer: 'TEST/11906', gov_status: 'processing' });
      const ekran = await get(p.app, ADRES, p.admin);
      expect(ekran.body).toContain('TEST/11906');
      expect(ekran.body).toContain('kiedy: 2026-11-12 11:00:00'); // czas polski (UTC+1 w listopadzie), nie surowe ISO
      expect(ekran.body).not.toContain('2026-11-12T10:00:00.000Z');
      expect(ekran.body).toContain('Sprawdziłem — automatyczna wysyłka wyłączona');
      expect((await post(p.app, `${ADRES}/sprawdzilem`, p.sprzedaz)).statusCode).toBe(403);
      expect(alarm.wczytaj()).toHaveLength(1);
      expect((await post(p.app, `${ADRES}/sprawdzilem`, p.admin)).statusCode).toBe(303);
      expect(alarm.wczytaj()).toEqual([]);
      expect((await post(p.app, `${ADRES}/odlacz`, p.admin)).statusCode).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia')).toBeNull();
      expect(p.siec).not.toHaveBeenCalled();
    } finally { await p.app.close(); }
  });
});

describe('PRZ-119.11b ekran Fakturowni w profilu próby', () => {
  const PROBNA = 'pracownia-polcien';
  function panelProby(env = {}) {
    const transport = vi.fn(async () => new Response('[]', { status: 200 }));
    const p = panel({ OMS_TRYB: 'proba', ...env },
      { fakturowniaProby: { domena: PROBNA, fetchImpl: transport, znacznik: () => 'test' } });
    return { ...p, transport };
  }
  it('pole domeny ma wartość z profilu, jest tylko do odczytu (readonly, nie disabled)', async () => {
    const p = panelProby();
    try {
      const r = await get(p.app, ADRES, p.admin);
      expect(r.statusCode, r.body).toBe(200);
      const pole = /<input id="fakturownia-domena"[^>]*>/u.exec(r.body)?.[0];
      expect(pole).toContain(`value="${PROBNA}"`);
      expect(pole).toMatch(/\sreadonly[\s>]/u);
      expect(pole).not.toContain('disabled');
      expect(r.body).toContain('Piaskownica: konto próbne z pliku profilu');
      bezTokenu(r.body);
    } finally { await p.app.close(); }
  });
  it('POST z inną domeną → 400, nic nie zapisane, token nie w odpowiedzi', async () => {
    const p = panelProby();
    try {
      const r = await post(p.app, ADRES, p.admin, { domena: 'inne-konto', token: TOKEN });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain(`Piaskownica łączy się wyłącznie z kontem próbnym ${PROBNA}`);
    expect(r.body).toContain('zapisz formularz ponownie');
      bezTokenu(r.body);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia')).toBeNull();
      const ok = await post(p.app, ADRES, p.admin, { domena: PROBNA, token: TOKEN });
      expect(ok.statusCode, ok.body).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia').ustawienia.domena).toBe(PROBNA);
      expect(p.transport).not.toHaveBeenCalled();
      expect(p.siec).not.toHaveBeenCalled();
    } finally { await p.app.close(); }
  });
  it('Sprawdź połączenie idzie transportem profilu (GET na domenę profilu), nie globalnym fetch', async () => {
    const p = panelProby();
    try {
      expect((await post(p.app, ADRES, p.admin, { domena: PROBNA, token: TOKEN })).statusCode).toBe(303);
      const r = await post(p.app, `${ADRES}/sprawdz`, p.admin);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).toContain('Połączenie z Fakturownią działa');
      bezTokenu(r.body);
      expect(p.transport).toHaveBeenCalledTimes(1);
      expect(String(p.transport.mock.calls[0][0])).toBe(`https://${PROBNA}.fakturownia.pl/invoices.json?page=1&per_page=1`);
      expect(p.transport.mock.calls[0][1].method).toBe('GET');
      expect(p.siec).not.toHaveBeenCalled();
    } finally { await p.app.close(); }
  });
  it('zapisana domena innego konta → Sprawdź odmawia bez sieci (token nie idzie na konto próbne)', async () => {
    const p = panelProby();
    try {
      zapiszKonfiguracjeIntegracji(p.db, 'fakturownia', { ustawienia: { domena: 'inne-konto' }, sekrety: { token: TOKEN } });
      const r = await post(p.app, `${ADRES}/sprawdz`, p.admin);
      expect(r.statusCode).toBe(200); // ekran pokazuje odmowę w ramce wyniku, jak inne odmowy sprawdzenia
      expect(r.body).toContain(`Piaskownica łączy się wyłącznie z kontem próbnym ${PROBNA}`);
      bezTokenu(r.body);
      expect(p.transport).not.toHaveBeenCalled();
      expect(p.siec).not.toHaveBeenCalled();
    } finally { await p.app.close(); }
  });
});
