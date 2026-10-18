// PRZ-094.10 (decyzja właściciela 18.10): „Adres panelu w mailach” ma wartość domyślną — adres, z którego admin właśnie
// korzysta. Kolejność źródeł linku z tokenem: OMS_ADRES_PANELU → zapis z Ustawień → Integracje → Poczta wychodząca →
// adres bieżącego żądania admina. Jedna zasada dla maila i „Pokaż link”. Adres z żądania przechodzi tę samą walidację
// co wpis; zły = odmowa wysyłki. Nie-admin z podstawionym Host nie wywoła wysyłki (403). Mailer to atrapa — nic nie
// wychodzi. Dane zmyślone.
import { describe, it, expect, vi } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { wczytajKonfiguracjeIntegracji, zapiszKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { adresLinkow, adresPaneluZZadania } from '../../../src/moduly/ustawienia/adres-panelu.ts';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

const BIURO = '192.168.1.20:3001';
const Z_ZAPISU = 'https://panel.pracownia.example.test';
const Z_PLIKU = 'https://z-pliku.pracownia.example.test';
const EKRAN_POCZTY = '/ustawienia/integracje/poczta';
const NOWA = { imie: 'Nowa Osoba', login: 'nowa', email: 'nowa@pracownia.example.test', rola: 'produkcja', sposob: 'mail' };
const UWAGA = 'adres, z którego teraz korzystasz';
const atrapa = () => ({ sendMail: vi.fn(async () => ({ messageId: 'atrapa' })) });

function panel({ env = {} } = {}) {
  const mailer = atrapa();
  const p = nowyPanel({ env, nadpisania: { 'wiadomosci.mailer': mailer } });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  return { ...p, mailer };
}
/** Żądanie admina „z biura”: Host i Origin tego samego adresu (CSRF porównuje jedno z drugim). */
const zBiura = (db, login = 'adam', host = BIURO) => ({ ...jako(db, login), host, origin: `http://${host}` });
const wyslij = (app, naglowki, url = '/ustawienia/konta/nowe', payload = NOWA) => app.inject({
  method: 'POST', url, headers: { accept: 'text/html', ...naglowki }, payload,
});
const tekstMaila = (mailer) => mailer.sendMail.mock.calls[0][0].text;
const liczbaLinkow = (db) => db.prepare('SELECT count(*) AS n FROM linki_hasla').get().n;

describe('PRZ-094.10 adres linków — jedna funkcja, kolejność źródeł', () => {
  it('skonfigurowany (plik albo zapis) wygrywa nad żądaniem; bez niego adres żądania jako domyślny', () => {
    const zadanie = { protocol: 'http', host: BIURO };
    expect(adresLinkow(Z_ZAPISU, zadanie)).toEqual({ adres: Z_ZAPISU, domyslny: false });
    expect(adresLinkow(null, zadanie)).toEqual({ adres: `http://${BIURO}`, domyslny: true });
    expect(adresLinkow(null, null)).toBeNull();
  });

  it('adres z żądania: ta sama walidacja co wpis — sam schemat, host i port', () => {
    expect(adresPaneluZZadania({ protocol: 'https', host: 'panel.example.test:443' })).toBe('https://panel.example.test');
    expect(adresPaneluZZadania({ protocol: 'http', host: '[::1]:3001' })).toBe('http://[::1]:3001');
    for (const [protocol, host] of [['ftp', 'panel.example.test'], ['http', 'ktos@panel.example.test'], ['http', 'panel.example.test/x'],
      ['http', 'panel.example.test?a=1'], ['http', 'panel.example.test#x'], ['http', ''], ['http', 'panel.example.test:99999'],
      [undefined, 'panel.example.test']]) {
      expect(adresPaneluZZadania({ protocol, host }), `${protocol}://${host}`).toBeNull();
    }
  });
});

describe('PRZ-094.10 zaproszenie i reset mailem bez wpisanego adresu', () => {
  it('(a) bez .env i zapisu: mail idzie z linkiem http://<host żądania>/haslo/<token>', async () => {
    const { db, app, mailer } = panel();
    const r = await wyslij(app, zBiura(db));
    expect(r.statusCode, r.body).toBe(302);
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(tekstMaila(mailer)).toMatch(new RegExp(`http://${BIURO.replace(/\./gu, '\\.')}/haslo/[A-Za-z0-9_-]{43}`, 'u'));
    expect(mailer.sendMail.mock.calls[0][0].html).toContain(`http://${BIURO}/haslo/`);
    // Reset istniejącego konta tą samą drogą.
    const id = kontoPoLoginie(db, 'nowa').id;
    const reset = await wyslij(app, zBiura(db), `/ustawienia/konta/${id}/link`, { sposob: 'mail' });
    expect(reset.statusCode, reset.body).toBe(302);
    expect(mailer.sendMail.mock.calls[1][0].text).toContain(`http://${BIURO}/haslo/`);
  });

  it('(b) zapis z ekranu poczty wygrywa z adresem żądania', async () => {
    const { db, app, mailer } = panel();
    zapiszKonfiguracjeIntegracji(db, 'adres_panelu', { ustawienia: { adres: Z_ZAPISU }, sekrety: {} });
    const r = await wyslij(app, zBiura(db));
    expect(r.statusCode, r.body).toBe(302);
    expect(tekstMaila(mailer)).toContain(`${Z_ZAPISU}/haslo/`);
    expect(tekstMaila(mailer)).not.toContain(BIURO);
  });

  it('(c) OMS_ADRES_PANELU wygrywa z zapisem i z żądaniem (produkcja z adresem w .env — bez zmian)', async () => {
    const { db, app, mailer } = panel({ env: { OMS_ADRES_PANELU: Z_PLIKU } });
    zapiszKonfiguracjeIntegracji(db, 'adres_panelu', { ustawienia: { adres: Z_ZAPISU }, sekrety: {} });
    const r = await wyslij(app, zBiura(db));
    expect(r.statusCode, r.body).toBe(302);
    expect(tekstMaila(mailer)).toContain(`${Z_PLIKU}/haslo/`);
    expect(tekstMaila(mailer)).not.toContain(Z_ZAPISU);
    expect(tekstMaila(mailer)).not.toContain(BIURO);
    const strona = await get(app, r.headers.location, zBiura(db));
    expect(strona.body).toContain('Wysłano link e-mailem.');
    expect(strona.body).not.toContain(UWAGA);
  });

  it('(d) komunikat po wysyłce mówi, dokąd prowadzi link — tylko przy adresie domyślnym', async () => {
    const domyslny = panel();
    const r = await wyslij(domyslny.app, zBiura(domyslny.db));
    expect(r.statusCode, r.body).toBe(302);
    const strona = await get(domyslny.app, r.headers.location, zBiura(domyslny.db));
    expect(strona.statusCode).toBe(200);
    expect(strona.body).toContain(`Wysłano. Link w mailu prowadzi do http://${BIURO} (adres, z którego teraz korzystasz). `
      + 'Jeśli pracownik otworzy go spoza tej sieci, wpisz adres w Ustawienia → Integracje → Poczta wychodząca.');

    const zapisany = panel();
    zapiszKonfiguracjeIntegracji(zapisany.db, 'adres_panelu', { ustawienia: { adres: Z_ZAPISU }, sekrety: {} });
    const r2 = await wyslij(zapisany.app, zBiura(zapisany.db));
    const strona2 = await get(zapisany.app, r2.headers.location, zBiura(zapisany.db));
    expect(strona2.body).toContain('Wysłano link e-mailem.');
    expect(strona2.body).not.toContain(UWAGA);
  });

  it('(e) adres żądania nie przechodzi walidacji → mail odmawia obecnym komunikatem, konto nie powstaje, nic nie wysłane', async () => {
    // Za zaufanym proxy Host i protokół przychodzą z X-Forwarded-*; CSRF porównuje Origin z samym Host, więc przejdzie.
    const { db, app, mailer } = panel({ env: { OMS_TRUST_PROXY: '127.0.0.1' } });
    for (const [i, zle] of [{ 'x-forwarded-proto': 'ftp' }, { 'x-forwarded-host': 'ktos@zly.example' },
      { 'x-forwarded-host': 'zly.example/sciezka' }].entries()) {
      const r = await wyslij(app, { ...zBiura(db), ...zle }, '/ustawienia/konta/nowe', { ...NOWA, login: `nowa${i}` });
      expect(r.statusCode, JSON.stringify(zle)).toBe(400);
      expect(r.body).toContain('Wysyłka mailem wymaga adresu panelu');
      expect(kontoPoLoginie(db, `nowa${i}`)).toBeNull();
    }
    expect(mailer.sendMail).not.toHaveBeenCalled();
    expect(liczbaLinkow(db)).toBe(0);
  });

  it('(f) nie-admin z ptaszkiem Ustawień i podstawionym Host → 403, nic nie wysłane, żaden link', async () => {
    const { db, app, mailer } = panel();
    const idEwa = zalozKonto(db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz' });
    ustawUprawnienia(db, idEwa, ['ustawienia']);
    const idOla = zalozKonto(db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'sprzedaz' });
    const zatrute = zBiura(db, 'ewa', 'napastnik.example');
    // sanity: konto przechodzi strażnika globalnego (ekran poczty mu działa) — inaczej 403 niżej nic by nie dowodziło
    expect((await get(app, EKRAN_POCZTY, zatrute)).statusCode).toBe(200);
    const nowe = await wyslij(app, zatrute);
    expect(nowe.statusCode).toBe(403);
    const reset = await wyslij(app, zatrute, `/ustawienia/konta/${idOla}/link`, { sposob: 'mail' });
    expect(reset.statusCode).toBe(403);
    expect(nowe.body + reset.body).not.toContain('napastnik.example/haslo');
    expect(kontoPoLoginie(db, 'nowa')).toBeNull();
    expect(mailer.sendMail).not.toHaveBeenCalled();
    expect(liczbaLinkow(db)).toBe(0);
  });

  it('„Pokaż link” bierze adres z tej samej funkcji: domyślny z uwagą, zapisany bez uwagi', async () => {
    const { db, app } = panel();
    const id = zalozKonto(db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'sprzedaz' });
    const r = await wyslij(app, zBiura(db), `/ustawienia/konta/${id}/link`, { sposob: 'pokaz' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`http://${BIURO}/haslo/`);
    expect(r.body).toContain('Adres wzięty z Twojej przeglądarki');
    zapiszKonfiguracjeIntegracji(db, 'adres_panelu', { ustawienia: { adres: Z_ZAPISU }, sekrety: {} });
    const r2 = await wyslij(app, zBiura(db), `/ustawienia/konta/${id}/link`, { sposob: 'pokaz' });
    expect(r2.body).toContain(`${Z_ZAPISU}/haslo/`);
    expect(r2.body).not.toContain('Adres wzięty z Twojej przeglądarki');
  });
});

describe('PRZ-094.10 ekran poczty — pole adresu nie jest wymagane', () => {
  const adresForm = (html) => /<form id="adres-panelu-formularz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';

  it('pole bez gwiazdki i bez required; podpowiedź pokazuje bieżący domyślny adres', async () => {
    const { db, app } = panel();
    const r = await get(app, EKRAN_POCZTY, zBiura(db));
    expect(r.statusCode).toBe(200);
    const f = adresForm(r.body);
    expect(f).toMatch(/<input id="adres-panelu" name="adres"/u);
    expect(f).not.toMatch(/<input id="adres-panelu"[^>]*required/u);
    expect(f).not.toContain('ust-wymagane');
    // Odbiór kierownika: szary adres domyślny w polu wyglądał jak wpisana wartość — w polu zostaje przykład.
    expect(f).toContain('placeholder="https://panel.twoja-firma.pl"');
    expect(f).toContain(`Puste — linki prowadzą pod adres, z którego korzystasz: <code>http://${BIURO}</code>`);
  });

  it('(g) zapis pustego pola usuwa zapisany adres — wraca domyślny', async () => {
    const { db, app, mailer } = panel();
    expect((await post(app, `${EKRAN_POCZTY}/adres`, zBiura(db), { adres: Z_ZAPISU })).statusCode).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(db, 'adres_panelu')?.ustawienia).toEqual({ adres: Z_ZAPISU });
    const pusty = await post(app, `${EKRAN_POCZTY}/adres`, zBiura(db), { adres: '   ' });
    expect(pusty.statusCode, pusty.body).toBe(303);
    expect(wczytajKonfiguracjeIntegracji(db, 'adres_panelu')).toBeNull();
    const ekran = await get(app, pusty.headers.location, zBiura(db));
    expect(ekran.body).toContain('Usunięto zapisany adres panelu.');
    expect(adresForm(ekran.body)).toMatch(/<input id="adres-panelu" name="adres" value=""/u);
    await wyslij(app, zBiura(db));
    expect(tekstMaila(mailer)).toContain(`http://${BIURO}/haslo/`);
  });

  it('OMS_ADRES_PANELU w pliku: pusty zapis też = 409, nic nie usunięte', async () => {
    const { db, app } = panel({ env: { OMS_ADRES_PANELU: Z_PLIKU } });
    zapiszKonfiguracjeIntegracji(db, 'adres_panelu', { ustawienia: { adres: Z_ZAPISU }, sekrety: {} });
    expect((await post(app, `${EKRAN_POCZTY}/adres`, zBiura(db), { adres: '' })).statusCode).toBe(409);
    expect(wczytajKonfiguracjeIntegracji(db, 'adres_panelu')?.ustawienia).toEqual({ adres: Z_ZAPISU });
  });
});
