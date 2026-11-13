import { describe, it, expect, vi, afterEach } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { utworzAlarmAutoKsef } from '../../../src/moduly/faktury/db/alarm-auto-ksef.js';
import { koncowkaTokenu, ADRES_KSEF_W_FAKTUROWNI } from '../../../src/moduly/faktury/trasy/ustawienia-fakturownia.js';
import { ADRES_RESTARTU } from '../../../src/moduly/faktury/trasy/ustawienia-programu.js';
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
  // PRZ-161: po podłączeniu pola tokenu nie ma na ekranie (otwiera je „Zmień token”); jeśli jest — zawsze puste.
  if (html.includes('name="token"')) expect(html).toMatch(/name="token"[^>]*value=""/u);
  expect(html).not.toMatch(/name="token"[^>]*value="[^"]/u);
}
/** PRZ-161: do sieci wolno wyjść wyłącznie z odczytem pierwszej strony listy faktur (sprawdzenie), nic innego. */
function tylkoSprawdzenia(siec, domena) {
  for (const [url, init] of siec.mock.calls) {
    expect(String(url)).toBe(`https://${domena}.fakturownia.pl/invoices.json?page=1&per_page=1`);
    expect(init?.method ?? 'GET').toBe('GET');
  }
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
      expect(r.body).toContain('Automatycznie wysyłaj tworzone dokumenty do KSeF'); // PRZ-161: ścieżka i nazwa suwaka z pomocy Fakturowni
      expect((await get(p.app, '/ustawienia/integracje/katalog', p.admin)).body).toContain(`href="${ADRES}"`);
      expect((await get(p.app, ADRES, p.sprzedaz)).statusCode).toBe(403);
      expect((await post(p.app, ADRES, p.sprzedaz, { domena: DOMENA, token: TOKEN })).statusCode).toBe(403);
    } finally { await p.app.close(); }
  });
  it('zapis i błędy zapisu nigdy nie zwracają tokenu; pusty token zachowuje zapisany', async () => {
    const p = panel();
    try {
      await zapisz(p);
      // PRZ-161: po podłączeniu formularz otwiera „Zmień token” (?zmien=1) — tam pole tokenu musi być puste.
      const ekran = await get(p.app, `${ADRES}?zmien=1`, p.admin);
      bezTokenu(ekran.body);
      expect(ekran.body).toContain('zapisany — wpisz nowy, żeby zmienić');
      expect((await get(p.app, ADRES, p.admin)).body).not.toContain(TOKEN);
      expect((await get(p.app, '/ustawienia/integracje', p.admin)).body).toContain(`href="${ADRES}"`);
      for (const domena of ['zla/domena', 'zla.domena', 'zla@domena']) {
        const r = await post(p.app, ADRES, p.admin, { domena, token: TOKEN });
        expect(r.statusCode).toBe(400);
        bezTokenu(r.body);
        expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia').ustawienia.domena).toBe(DOMENA);
      }
      expect((await post(p.app, ADRES, p.admin, { domena: DOMENA, token: '' })).statusCode).toBe(303);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia').sekrety.token).toBe(TOKEN);
      tylkoSprawdzenia(p.siec, DOMENA); // PRZ-161: zapis najpierw pyta Fakturownię (jeden GET listy), nic więcej
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
      expect(p.siec).toHaveBeenCalledTimes(2); // PRZ-161: pierwszy GET przy zapisie, drugi — przycisk
      expect(String(p.siec.mock.calls[1][0])).toBe(`https://${DOMENA}.fakturownia.pl/invoices.json?page=1&per_page=1`);
      expect(p.siec.mock.calls[1][1].method).toBe('GET');
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
      tylkoSprawdzenia(p.siec, DOMENA);
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
      expect(p.transport).toHaveBeenCalledTimes(1); // PRZ-161: zapis z domeną profilu sprawdza ją transportem profilu
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
      expect(p.transport).toHaveBeenCalledTimes(2);
      expect(String(p.transport.mock.calls[1][0])).toBe(`https://${PROBNA}.fakturownia.pl/invoices.json?page=1&per_page=1`);
      expect(p.transport.mock.calls[1][1].method).toBe('GET');
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

describe('PRZ-161 porządek ekranu Fakturowni', () => {
  const TOKEN_BEZ_UKOSNIKA = 'fikcyjnyTokenPrz161Q7xZ';
  const zapiszCzysty = async (p) => {
    const r = await post(p.app, ADRES, p.admin, { domena: DOMENA, token: TOKEN_BEZ_UKOSNIKA });
    expect(r.statusCode, r.body).toBe(303);
  };
  it('końcówka tokenu: 4 ostatnie znaki, przed ukośnikiem; krótki token — nic', () => {
    expect(koncowkaTokenu('abcdefghijklQ7xZ')).toBe('Q7xZ');
    expect(koncowkaTokenu('abcdefghijklmnop/konto')).toBe('mnop');
    expect(koncowkaTokenu('krotki')).toBeNull();
    expect(koncowkaTokenu('krotki/abcdefghijklmnop')).toBeNull();
    expect(koncowkaTokenu(null)).toBeNull();
  });
  it('po podłączeniu: konto i końcówka tokenu w stanie, bez formularza; „Zmień token” go otwiera', async () => {
    const p = panel();
    try {
      await zapiszCzysty(p);
      const r = await get(p.app, ADRES, p.admin);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.body).not.toContain(TOKEN_BEZ_UKOSNIKA);
      expect(r.body).toContain('••••Q7xZ');
      expect(r.body).toContain(`${DOMENA}.fakturownia.pl`);
      expect(r.body).not.toContain('id="fakturownia-token"');
      expect(r.body).toContain(`href="${ADRES}?zmien=1#fakturownia-formularz"`);
      expect(r.body).toContain('Odłącz');
      const z = await get(p.app, `${ADRES}?zmien=1`, p.admin);
      expect(z.body).toContain('id="fakturownia-token"');
      expect(z.body).not.toContain(TOKEN_BEZ_UKOSNIKA);
    } finally { await p.app.close(); }
  });
  it('niepodłączona: formularz od razu, bez Odłącz i bez Sprawdź', async () => {
    const p = panel();
    try {
      const r = await get(p.app, ADRES, p.admin);
      expect(r.body).toContain('id="fakturownia-token"');
      expect(r.body).not.toContain(`${ADRES}/odlacz`);
      expect(r.body).not.toContain(`${ADRES}/sprawdz"`);
    } finally { await p.app.close(); }
  });
  it('zapisana, niewybrana w Module faktur: link do Modułu faktur, bez przycisku restartu', async () => {
    const p = panel({ OMS_RESTART_Z_PANELU: 'tak' });
    try {
      await zapiszCzysty(p);
      const r = await get(p.app, ADRES, p.admin);
      const pas = /id="fakturownia-uruchomienie"[\s\S]*?<\/div>/u.exec(r.body)?.[0] ?? '';
      expect(pas).toContain(`href="${EKRAN_WYBORU_PROGRAMU}"`);
      expect(pas).toContain('Wybierz ją');
      expect(pas).not.toContain(ADRES_RESTARTU);
    } finally { await p.app.close(); }
  });
  it('wybrana, czeka na restart: przycisk restartu (tak), nieaktywny (atrapa), polecenie (brak zmiennej)', async () => {
    for (const [env, oczekiwane] of [
      [{ OMS_RESTART_Z_PANELU: 'tak' }, (pas) => { expect(pas).toContain(`action="${ADRES_RESTARTU}"`); expect(pas).not.toContain('disabled'); }],
      [{ OMS_RESTART_Z_PANELU: 'atrapa' }, (pas) => { expect(pas).toContain(`action="${ADRES_RESTARTU}"`); expect(pas).toContain('disabled'); }],
      [{}, (pas) => { expect(pas).not.toContain(ADRES_RESTARTU); expect(pas).toContain('docker compose restart oms'); }],
    ]) {
      const p = panel(env);
      try {
        await zapiszCzysty(p);
        zapiszWyborProgramu(p.db, 'fakturownia');
        const r = await get(p.app, ADRES, p.admin);
        const pas = /id="fakturownia-uruchomienie"[\s\S]*?<\/div>\s*<\/div>|id="fakturownia-uruchomienie"[\s\S]*?<\/div>/u.exec(r.body)?.[0] ?? '';
        expect(pas).toContain('jest wybrana');
        expect(pas).toContain(`href="${EKRAN_WYBORU_PROGRAMU}"`);
        oczekiwane(pas);
      } finally { await p.app.close(); }
    }
  });
  it('KSeF: przed potwierdzeniem link do ustawień KSeF w Fakturowni; po „Sprawdziłem” — stan Wyłączona z datą; nowy alarm wraca', async () => {
    const p = panel();
    try {
      const przed = await get(p.app, ADRES, p.admin);
      expect(przed.body).toContain(`href="${ADRES_KSEF_W_FAKTUROWNI}"`);
      expect(przed.body).toContain('Sprawdziłem — automatyczna wysyłka wyłączona');
      expect((await post(p.app, `${ADRES}/sprawdzilem`, p.admin)).statusCode).toBe(303);
      const po = await get(p.app, ADRES, p.admin);
      expect(po.body).toContain('Potwierdzono ');
      expect(po.body).not.toContain('Sprawdziłem — automatyczna wysyłka wyłączona');
      expect(po.body).not.toContain(`href="${ADRES_KSEF_W_FAKTUROWNI}"`);
      utworzAlarmAutoKsef(p.db).dopisz({ dokument: '161', numer: 'TEST/161', gov_status: 'processing' });
      const alarm = await get(p.app, ADRES, p.admin);
      expect(alarm.body).toContain('Alarm: Fakturownia sama wysłała');
      expect(alarm.body).not.toContain('Potwierdzono ');
      expect(alarm.body).toContain('Sprawdziłem — automatyczna wysyłka wyłączona');
    } finally { await p.app.close(); }
  });
});

describe('PRZ-161 Zapisz najpierw sprawdza w Fakturowni', () => {
  const etykieta = (html) => /id="fakturownia-stan-etykieta"[^>]*><strong>([^<]*)</u.exec(html)?.[1] ?? null;
  it('Fakturownia odrzuca (401) → 400, nic nie zapisane, wpisana domena wraca w polu, token nie', async () => {
    const p = panel();
    try {
      p.siec.mockImplementation(async () => new Response('Musisz być zalogowany', { status: 401 }));
      const r = await post(p.app, ADRES, p.admin, { domena: 'inne-konto-161', token: TOKEN });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.body).toContain('Fakturownia nie przyjęła tych danych — nic nie zapisano.');
      expect(r.body).toContain('HTTP 401');
      expect(/<input id="fakturownia-domena"[^>]*>/u.exec(r.body)?.[0]).toContain('value="inne-konto-161"');
      bezTokenu(r.body);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia')).toBeNull();
      tylkoSprawdzenia(p.siec, 'inne-konto-161');
      expect(p.siec).toHaveBeenCalledTimes(1);
    } finally { await p.app.close(); }
  });
  it('odrzucenie zmiany tokenu zostawia stary zapis i jego stan „Podłączony”', async () => {
    const p = panel();
    try {
      await zapisz(p);
      p.siec.mockImplementation(async () => new Response('', { status: 403 }));
      expect((await post(p.app, ADRES, p.admin, { domena: DOMENA, token: 'zupelnie-inny-token-161' })).statusCode).toBe(400);
      expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia').sekrety.token).toBe(TOKEN);
      expect(etykieta((await get(p.app, ADRES, p.admin)).body)).toBe('Podłączony');
    } finally { await p.app.close(); }
  });
  it('Fakturownia przyjmuje → zapis, „Podłączony” z datą sprawdzenia', async () => {
    const p = panel();
    try {
      const r = await post(p.app, ADRES, p.admin, { domena: DOMENA, token: TOKEN });
      expect(r.statusCode).toBe(303);
      expect(r.headers.location).toBe(`${ADRES}?zapisano=zapisano`);
      const e = await get(p.app, `${ADRES}?zapisano=zapisano`, p.admin);
      expect(etykieta(e.body)).toBe('Podłączony');
      expect(e.body).toContain('Fakturownia przyjęła token');
      expect(e.body).toContain('<dt>Sprawdzono</dt>');
    } finally { await p.app.close(); }
  });
  for (const [opis, odpowiedz] of [
    ['brak odpowiedzi (błąd sieci)', async () => { throw new TypeError('fetch failed'); }],
    ['5xx', async () => new Response('', { status: 503 })],
    ['429', async () => new Response('', { status: 429 })],
  ]) {
    it(`${opis} → zapis ze stanem „Zapisany, niesprawdzony” i powodem`, async () => {
      const p = panel();
      try {
        p.siec.mockImplementation(odpowiedz);
        const r = await post(p.app, ADRES, p.admin, { domena: DOMENA, token: TOKEN });
        expect(r.statusCode).toBe(303);
        expect(r.headers.location).toBe(`${ADRES}?zapisano=niesprawdzone`);
        expect(wczytajKonfiguracjeIntegracji(p.db, 'fakturownia').sekrety.token).toBe(TOKEN);
        const e = await get(p.app, ADRES, p.admin);
        expect(etykieta(e.body)).toBe('Zapisany, niesprawdzony');
        expect(e.body).toContain('Kliknij „Sprawdź połączenie”');
        bezTokenu(e.body);
        // Przycisk po powrocie Fakturowni zmienia stan na „Podłączony”.
        p.siec.mockImplementation(async () => new Response('[]', { status: 200 }));
        await post(p.app, `${ADRES}/sprawdz`, p.admin);
        expect(etykieta((await get(p.app, ADRES, p.admin)).body)).toBe('Podłączony');
      } finally { await p.app.close(); }
    });
  }
  it('„Sprawdź połączenie” z odmową zmienia „Podłączony” na „Fakturownia odrzuca token”', async () => {
    const p = panel();
    try {
      await zapisz(p);
      p.siec.mockImplementation(async () => new Response('', { status: 401 }));
      await post(p.app, `${ADRES}/sprawdz`, p.admin);
      const e = await get(p.app, ADRES, p.admin);
      expect(etykieta(e.body)).toBe('Fakturownia odrzuca token');
      bezTokenu(e.body);
    } finally { await p.app.close(); }
  });
  it('zmiana danych poza ekranem unieważnia stary wynik → „Zapisany, niesprawdzony”', async () => {
    const p = panel();
    try {
      await zapisz(p);
      zapiszKonfiguracjeIntegracji(p.db, 'fakturownia', { ustawienia: { domena: DOMENA }, sekrety: { token: 'podmieniony-token-161' } });
      expect(etykieta((await get(p.app, ADRES, p.admin)).body)).toBe('Zapisany, niesprawdzony');
    } finally { await p.app.close(); }
  });
  it('jawne „Brak”: zapis bez sieci, stan niesprawdzony ze zdaniem o wyłączonych fakturach', async () => {
    const p = panel({ OMS_PROGRAM_FAKTUROWY: 'brak' });
    try {
      const r = await post(p.app, ADRES, p.admin, { domena: DOMENA, token: TOKEN });
      expect(r.statusCode).toBe(303);
      expect(p.siec).not.toHaveBeenCalled();
      const e = await get(p.app, ADRES, p.admin);
      expect(etykieta(e.body)).toBe('Zapisany, niesprawdzony');
      expect(e.body).toContain('Połączenia nie sprawdzono.');
    } finally { await p.app.close(); }
  });
  it('Odłącz kasuje też wynik sprawdzenia', async () => {
    const p = panel();
    try {
      await zapisz(p);
      await post(p.app, `${ADRES}/odlacz`, p.admin);
      expect(p.db.prepare("SELECT count(*) AS n FROM ustawienia WHERE klucz = 'faktury.fakturownia.sprawdzenie'").get().n).toBe(0);
    } finally { await p.app.close(); }
  });
});
