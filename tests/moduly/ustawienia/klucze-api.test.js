import { afterEach, describe, expect, it, vi } from 'vitest';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { zalozKluczApi, usunKluczApi } from '../../../src/core/bezpieczenstwo/klucze-api.js';
import Fastify from 'fastify';
import { registerKluczeApiRoutes } from '../../../src/moduly/ustawienia/trasy/klucze-api.js';
import { modelNawigacjiUstawien } from '../../../src/domena/dzialy-ustawien.js';
import { nawigacjaUstawien } from '../../../src/moduly/ustawienia/nawigacja.js';
import { ZAKRESY_API } from '../../../src/domena/klucze-api.js';

const url = '/ustawienia/klucze-api';
const panele = [];
function panel() {
  const p = nowyPanel();
  panele.push(p);
  p.id = zalozKonto(p.db, { login: 'tester', imie: 'Tester', haslo: 'h', admin: true, rola: 'administrator' });
  p.admin = jako(p.db, 'tester');
  return p;
}
const token = r => /name="jednorazowy" value="([^"]+)"/.exec(r.body)?.[1];
const liczba = db => db.prepare('SELECT COUNT(*) AS n FROM klucze_api').get().n;
async function utworz(p, dane = {}) {
  const jednorazowy = token(await get(p.app, url, p.admin));
  const payload = { nazwa: 'integracja testowa', zakresy: ['druk'], jednorazowy, ...dane };
  return { r: await post(p.app, url, p.admin, payload), payload };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of panele.splice(0)) { await p.app.close(); p.db.close(); }
});

describe('Klucze API w Ustawieniach', () => {
  it('grupowanie nie wywraca widoku po usunięciu zakresu z katalogu', async () => {
    const p = panel();
    vi.doMock('../../../src/domena/klucze-api.js', () => ({ ZAKRESY_API: ZAKRESY_API.filter(z => z !== 'druk'), czyZakresyPoprawne: () => true }));
    const app = Fastify();
    app.decorateReply('view', function (_plik, model) { return this.send(model.grupyZakresow); });
    app.addHook('preHandler', async req => { req.konto = { admin: true, login: 'tester' }; });
    try {
      const { registerKluczeApiRoutes: register } = await import('../../../src/moduly/ustawienia/trasy/klucze-api.js?bez-druku');
      register(app, { db: p.db });
      const r = await get(app, url);
      expect(r.statusCode).toBe(200);
      expect(r.json().some(g => g.nazwa === 'Druk')).toBe(false);
      expect(r.json().flatMap(g => g.zakresy)).toHaveLength(9);
    } finally {
      vi.doUnmock('../../../src/domena/klucze-api.js');
      await app.close();
    }
  });
  it.each(['usun', 'odwolaj'])('bez potwierdzenia %s klucz zostaje czynny, karta ma akcje bez checkboxów', async akcja => {
    const p = panel();
    const { id, klucz } = zalozKluczApi(p.db, { nazwa: 'bezpieczna integracja', zakresy: ['druk'], kontoId: p.id, teraz: new Date().toISOString() });
    const r = await post(p.app, `${url}/${id}/${akcja}`, p.admin);
    expect(r.statusCode).toBe(200);
    expect(liczba(p.db)).toBe(1);
    expect((await p.app.inject({ url: '/api/v1/ja', headers: { authorization: `Bearer ${klucz}` } })).statusCode).toBe(200);
    const lista = await get(p.app, url, p.admin);
    expect(lista.body).toContain('class="klucze-api-akcje"');
    expect(lista.body).not.toContain('name="potwierdzam"');
    expect(lista.body).toContain('data-odwolaj-klucz');
    expect(lista.body).toContain('data-usun-klucz');
  });
  it('karta używa nazw z grup i rodzajów formularza, nieznany zakres pokazuje surowo', async () => {
    const p = panel();
    const { id } = zalozKluczApi(p.db, { nazwa: 'dawny klucz', zakresy: ['druk'], kontoId: p.id, teraz: new Date().toISOString() });
    p.db.prepare('UPDATE klucze_api SET zakresy = ? WHERE id = ?').run(JSON.stringify([...ZAKRESY_API, 'dawny:odczyt']), id);
    const r = await get(p.app, url, p.admin);
    expect(r.statusCode).toBe(200);
    const grupy = [...r.body.matchAll(/<h3 class="klucze-api-grupa">([^<]+)<\/h3>([\s\S]*?)<\/div>/g)];
    for (const [, grupa, html] of grupy) {
      for (const [, rodzaj] of html.matchAll(/<span>([^<]+)<\/span>/g)) {
        expect(r.body.slice(r.body.indexOf('Zakresy:'))).toContain(`${grupa} — ${rodzaj}`);
      }
    }
    expect(grupy).toHaveLength(7);
    expect(r.body).toContain('Druk — Kolejka druku, dawny:odczyt');
  });
  it('odwołuje przed DELETE, wycofuje odwołanie przy błędzie usunięcia; usuwa też odwołany klucz', () => {
    const p = panel();
    const { id } = zalozKluczApi(p.db, { nazwa: 'transakcja', zakresy: ['druk'], kontoId: p.id, teraz: new Date().toISOString() });
    p.db.exec(`CREATE TEMP TRIGGER sprawdz_odwolanie BEFORE DELETE ON klucze_api BEGIN
      SELECT CASE WHEN OLD.odwolany_at IS NULL THEN RAISE(ABORT, 'brak odwolania') ELSE RAISE(ABORT, 'odwolany przed DELETE') END; END`);
    expect(() => usunKluczApi(p.db, id, new Date().toISOString())).toThrow('odwolany przed DELETE');
    expect(p.db.prepare('SELECT odwolany_at FROM klucze_api WHERE id = ?').get(id).odwolany_at).toBeNull();
    p.db.exec('DROP TRIGGER sprawdz_odwolanie');
    p.db.prepare('UPDATE klucze_api SET odwolany_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', id);
    expect(usunKluczApi(p.db, id, new Date().toISOString())).toBe(true);
    expect(liczba(p.db)).toBe(0);
  });
  it('grupuje wszystkie zakresy w kolejności, checkbox przed opisem, zaznaczanie bez inline JS', async () => {
    const p = panel();
    const r = await get(p.app, url, p.admin);
    const grupy = [...r.body.matchAll(/<h3 class="klucze-api-grupa">([^<]+)<\/h3>/g)].map(m => m[1]);
    expect(grupy).toEqual(['Zamówienia', 'Produkty', 'Stany', 'Proformy', 'Zdjęcia', 'Sprzedaż', 'Druk']);
    expect(r.body).toContain('Zaznacz wszystko');
    expect(r.body.match(/name="zakresy"/g)).toHaveLength(10);
    expect(r.body).toMatch(/<input type="checkbox" name="zakresy" value="zamowienia:odczyt"[^>]*>\s*<span>Odczyt<\/span>/);
    expect(r.body).toMatch(/<script[^>]+src="[^"]*klucze-api.js/);
  });
  it('usuwa aktywny klucz: wiersz znika, API odmawia, dziennik zostaje; wymaga potwierdzenia', async () => {
    const p = panel();
    const { id, klucz, prefiks } = zalozKluczApi(p.db, { nazwa: 'do usunięcia', zakresy: ['druk'], kontoId: p.id, teraz: new Date().toISOString() });
    const ja = () => p.app.inject({ url: '/api/v1/ja', headers: { authorization: `Bearer ${klucz}` } });
    expect((await ja()).statusCode).toBe(200);
    // Udany GET nie jest dziennikowany; odmowa na nieistniejącej trasie zostawia ślad z klucz_id.
    await p.app.inject({ url: '/api/v1/nieistniejacy-zasob', headers: { authorization: `Bearer ${klucz}` } });
    const dziennik = p.db.prepare('SELECT * FROM klucze_api_dziennik WHERE klucz_id = ?').all(id);
    expect(dziennik.length).toBeGreaterThan(0);
    const pytanie = await post(p.app, `${url}/${id}/usun`, p.admin);
    expect(pytanie.statusCode).toBe(200);
    expect(pytanie.body).toContain('Na pewno usunąć klucz „do usunięcia”?');
    expect(pytanie.body).toContain('Tak, usuń');
    expect(pytanie.body).toContain('name="potwierdzam" value="tak"');
    expect(pytanie.body).toContain('Anuluj');
    expect((await ja()).statusCode).toBe(200);
    expect(liczba(p.db)).toBe(1);
    expect((await p.app.inject({ method: 'POST', url: `${url}/${id}/usun`, headers: { ...p.admin, origin: 'https://obcy.invalid' }, payload: { potwierdzam: 'tak' } })).statusCode).toBe(403);
    expect((await post(p.app, `${url}/${id}/usun`, p.admin, { potwierdzam: 'tak' })).statusCode).toBe(303);
    expect(liczba(p.db)).toBe(0);
    expect((await get(p.app, url, p.admin)).body).not.toContain('do usunięcia');
    expect(p.db.prepare('SELECT * FROM klucze_api_dziennik WHERE klucz_id = ?').all(id)).toEqual(dziennik);
    expect((await ja()).statusCode).toBe(401);
    expect(p.db.prepare('SELECT wynik FROM logowania WHERE wynik = ?').get(`usuniety:${prefiks}`)).toBeTruthy();
    const brak = await post(p.app, `${url}/${id}/usun`, p.admin, { potwierdzam: 'tak' });
    expect(brak.statusCode).toBe(404);
    expect(brak.body).toContain('Nie ma takiego klucza.');
  });
  it('tylko admin: odmawia na każdej trasie, również gościowi demo na GET', async () => {
    const p = panel();
    const id = zalozKonto(p.db, { login: 'pracownik', imie: 'Test', haslo: 'h', rola: 'sprzedaz' });
    ustawUprawnienia(p.db, id, ['ustawienia']);
    const headers = jako(p.db, 'pracownik');
    expect((await get(p.app, url, headers)).statusCode).toBe(403);
    expect((await post(p.app, url, headers)).statusCode).toBe(403);
    expect((await post(p.app, `${url}/1/odwolaj`, headers)).statusCode).toBe(403);
    expect((await post(p.app, `${url}/1/usun`, headers)).statusCode).toBe(403);
    // Symulacja migawki gościa po strażniku, bez wyjątku z ekranu kont.
    const demo = Fastify();
    demo.decorateReply('view', function (_plik, model) { return this.send(model); });
    demo.addHook('preHandler', async req => { req.konto = { podgladDemo: true }; });
    registerKluczeApiRoutes(demo, { db: p.db });
    try { expect((await get(demo, url)).statusCode).toBe(403); }
    finally { await demo.close(); }
    expect(modelNawigacjiUstawien(url, { admin: true }).zakladki).toContainEqual(expect.objectContaining({ klucz: 'klucze-api', aktywna: true }));
    expect(modelNawigacjiUstawien('/ustawienia/konta', { podgladDemo: true }).zakladki.some(z => z.klucz === 'klucze-api')).toBe(false);
  });
  it('pokazuje klucz raz; F5 tego samego POST nie zakłada kolejnego ani nie ujawnia klucza', async () => {
    const p = panel();
    const { r, payload } = await utworz(p);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const klucz = r.body.match(/toms_[a-z0-9]{8}_[A-Za-z0-9_-]{43}/)?.[0];
    expect(klucz).toBeTruthy();
    expect(r.body.split(klucz)).toHaveLength(2);
    expect(r.body).toContain('readonly');
    expect(r.body).toContain('aria-label="Kopiuj klucz"');
    expect(r.body).toContain('id="klucz-api-wartosc"');
    expect(r.body).toMatch(/<input type="text" id="klucz-api-wartosc" readonly[^>]*value="toms_/);
    expect(r.body).not.toContain('<textarea');
    expect(r.body).toContain('Skopiuj teraz — później nie będzie go widać.');
    const f5 = await post(p.app, url, p.admin, payload);
    expect(f5.statusCode).toBe(303);
    expect(f5.headers.location).toBe(url);
    expect(liczba(p.db)).toBe(1);
    expect((await get(p.app, url, p.admin)).body).not.toContain(klucz);
    expect(p.db.prepare('SELECT wynik FROM logowania WHERE usluga = ?').get('klucze-api').wynik).toMatch(/^zalozony:/);
  });
  it('odrzuca brak, nieznany, wygasły token oraz token z innej instancji', async () => {
    const p = panel();
    for (const jednorazowy of [undefined, 'nieznany']) {
      expect((await post(p.app, url, p.admin, { nazwa: 'test', zakresy: ['druk'], jednorazowy })).statusCode).toBe(303);
    }
    const t = token(await get(p.app, url, p.admin));
    const drugi = panel();
    expect((await post(drugi.app, url, drugi.admin, { nazwa: 'test', zakresy: ['druk'], jednorazowy: t })).statusCode).toBe(303);
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    expect((await post(p.app, url, p.admin, { nazwa: 'test', zakresy: ['druk'], jednorazowy: t })).statusCode).toBe(303);
    spy.mockRestore();
    expect(liczba(p.db)).toBe(0);
  });
  it('waliduje nazwę, zakresy i datę; zachowuje dane formularza, koniec dnia UTC', async () => {
    const p = panel();
    for (const dane of [{ zakresy: [] }, { zakresy: ['admin'] }, { zakresy: ['druk', 'druk'] }, { nazwa: ' ' }, { wygasa: '2000-01-01' }, { wygasa: '2027-02-30' }]) {
      const { r } = await utworz(p, dane);
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('pas-uprzedzenie');
      expect(token(r)).toBeTruthy();
      expect(liczba(p.db)).toBe(0);
    }
    expect((await utworz(p, { wygasa: '2099-01-02', zakresy: 'druk' })).r.statusCode).toBe(200);
    expect(p.db.prepare('SELECT wygasa_at FROM klucze_api').get().wygasa_at).toBe('2099-01-02T23:59:59.999Z');
  });
  it('pytanie potwierdzenia escapuje nazwę klucza', async () => {
    const p = panel();
    const { id } = zalozKluczApi(p.db, { nazwa: '<b>Półcień</b>', zakresy: ['druk'], kontoId: p.id, teraz: new Date().toISOString() });
    const r = await post(p.app, `${url}/${id}/usun`, p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('klucz „&lt;b&gt;Półcień&lt;/b&gt;”?');
    expect(r.body).not.toContain('<b>Półcień</b>');
  });
  it('przyjmuje rzeczywisty formularz HTML i nie wykonuje HTML z nazwy', async () => {
    const p = panel();
    const jednorazowy = token(await get(p.app, url, p.admin));
    const r = await p.app.inject({ method: 'POST', url,
      headers: { ...p.admin, origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams([['jednorazowy', jednorazowy], ['nazwa', '<script>test</script>'], ['zakresy', 'druk'], ['zakresy', 'zamowienia:odczyt']]).toString() });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('<script>test</script>');
    expect(r.body).toContain('&lt;script&gt;test&lt;/script&gt;');
    expect(JSON.parse(p.db.prepare('SELECT zakresy FROM klucze_api').get().zakresy)).toEqual(['zamowienia:odczyt', 'druk']);
  });
  it('lista: polskie zakresy w kolejności, twórca wyłączony, stany, IP; odwołanie wymaga potwierdzenia i zapisuje log', async () => {
    const p = panel();
    await utworz(p, { zakresy: ['druk', 'zamowienia:odczyt'] });
    const w = p.db.prepare('SELECT * FROM klucze_api').get();
    p.db.prepare('UPDATE klucze_api SET ostatnio_uzyty_at = ?, ostatnie_ip = ?').run('2026-11-06T10:00:00.000Z', '192.0.2.1');
    const tworca = p.db.prepare('SELECT id FROM konta WHERE login = ?').get('tester').id;
    const { id: wygasly } = zalozKluczApi(p.db, { nazwa: 'wygasła integracja testowa', zakresy: ['druk'], kontoId: tworca, teraz: '2000-01-01T00:00:00.000Z', wygasaAt: '2000-01-02T00:00:00.000Z' });
    expect(wygasly).toBeTruthy();
    // Konto twórcy może być inne niż aktualnego administratora.
    const id = zalozKonto(p.db, { login: 'dawny', imie: 'Test', haslo: 'h', admin: false, rola: 'sprzedaz' });
    p.db.prepare('UPDATE konta SET czynne = 0 WHERE id = ?').run(id);
    p.db.prepare('UPDATE klucze_api SET utworzyl_konto_id = ? WHERE id = ?').run(id, w.id);
    let lista = await get(p.app, url, p.admin);
    for (const tekst of ['dawny', 'konto wyłączone', 'czynny', 'wygasły', '192.0.2.1', 'Zamówienia — Odczyt', 'Druk — Kolejka druku']) expect(lista.body).toContain(tekst);
    expect(lista.body.indexOf('value="zamowienia:odczyt"')).toBeLessThan(lista.body.indexOf('value="druk"'));
    const pytanie = await post(p.app, `${url}/${w.id}/odwolaj`, p.admin);
    expect(pytanie.statusCode).toBe(200);
    expect(pytanie.body).toContain('Na pewno odwołać klucz „integracja testowa”?');
    expect(pytanie.body).toContain('Tak, odwołaj');
    expect(p.db.prepare('SELECT odwolany_at FROM klucze_api WHERE id = ?').get(w.id).odwolany_at).toBeNull();
    expect((await post(p.app, `${url}/${w.id}/odwolaj`, p.admin, { potwierdzam: 'tak' })).statusCode).toBe(303);
    expect(p.db.prepare('SELECT odwolany_at FROM klucze_api WHERE id = ?').get(w.id).odwolany_at).toBeTruthy();
    lista = await get(p.app, url, p.admin);
    expect(lista.body).toContain('odwołany');
    expect(lista.body).not.toContain(`action="${url}/${w.id}/odwolaj"`);
    expect(lista.body).toContain(`action="${url}/${w.id}/usun"`);
    expect(p.db.prepare('SELECT wynik FROM logowania WHERE wynik = ?').get(`odwolany:${w.prefiks}`)).toBeTruthy();
    expect((await p.app.inject({ method: 'POST', url, headers: { ...p.admin, origin: 'https://obcy.invalid' }, payload: {} })).statusCode).toBe(403);
  });
  it('karta: plakietka stanu (czynny zielona, odwołany i wygasły szare), przygaszona karta, czerwony tylko Usuń', async () => {
    const p = panel();
    await utworz(p, { nazwa: 'klucz czynny' });
    await utworz(p, { nazwa: 'klucz odwołany' });
    const tworca = p.db.prepare('SELECT id FROM konta WHERE login = ?').get('tester').id;
    zalozKluczApi(p.db, { nazwa: 'klucz wygasły', zakresy: ['druk'], kontoId: tworca, teraz: '2000-01-01T00:00:00.000Z', wygasaAt: '2000-01-02T00:00:00.000Z' });
    p.db.prepare("UPDATE klucze_api SET odwolany_at = '2026-11-06T10:00:00.000Z' WHERE nazwa = 'klucz odwołany'").run();
    const body = (await get(p.app, url, p.admin)).body;
    const karty = body.split('<div class="ust-sekcja klucze-api-karta').slice(1);
    const karta = nazwa => karty.find(k => k.includes(`<h3>${nazwa}</h3>`));
    expect(karta('klucz czynny')).toMatch(/^">/);
    expect(karta('klucz czynny')).toContain('<strong class="klucze-api-stan klucze-api-stan--czynny">czynny</strong>');
    expect(karta('klucz czynny')).toContain('<button type="submit" class="ust-przycisk">Odwołaj</button>');
    for (const [nazwa, stan] of [['klucz odwołany', 'odwołany'], ['klucz wygasły', 'wygasły']]) {
      expect(karta(nazwa)).toMatch(/^ klucze-api-karta--nieczynny">/);
      expect(karta(nazwa)).toContain(`<strong class="klucze-api-stan">${stan}</strong>`);
    }
    expect(body).not.toContain('class="ust-przycisk grozny">Odwołaj');
    expect(body.split('<button type="submit" class="ust-przycisk grozny">Usuń</button>')).toHaveLength(4);
    expect(karta('klucz czynny')).toContain('<span class="klucze-api-prefiks">Prefiks: <code>');
  });

  it('token jest przypięty do loginu; odwołanie nieznanego klucza daje 404; gość demo nie widzi zakładki w nawigacji', async () => {
    const p = panel();
    zalozKonto(p.db, { login: 'drugi', imie: 'Drugi', haslo: 'h', admin: true, rola: 'administrator' });
    const t = token(await get(p.app, url, p.admin));
    expect((await post(p.app, url, jako(p.db, 'drugi'), { nazwa: 'test', zakresy: ['druk'], jednorazowy: t })).statusCode).toBe(303);
    expect(liczba(p.db)).toBe(0);
    expect((await post(p.app, `${url}/999/odwolaj`, p.admin, { potwierdzam: 'tak' })).statusCode).toBe(404);
    const klucze = n => n.kontekst.zakladki.map(z => z.klucz);
    expect(klucze(nawigacjaUstawien({ url, konto: { podgladDemo: true } }, {}))).not.toContain('klucze-api');
    expect(klucze(nawigacjaUstawien({ url, konto: { admin: true } }, {}))).toContain('klucze-api');
  });
});
