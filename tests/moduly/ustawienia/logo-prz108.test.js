import { afterAll, afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako, get, post } from '../../pomoc/konta-prz068.js';
import { wczytajKonfiguracjeIntegracji } from '../../../src/oms/db/konfiguracja-integracji.js';
import { nazwaCiasteczkaOms } from '../../../src/core/bezpieczenstwo/sesja.js';

const EKRAN = '/ustawienia/firma';
const ZAPIS = `${EKRAN}/logo`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64');
const katalog = mkdtempSync(join(tmpdir(), 'oms-logo-test-'));
let p;
afterEach(async () => { await p?.app.close(); p?.db.close(); p = null; });
afterAll(() => rmSync(katalog, { recursive: true, force: true }));
async function panel(extra = {}) {
  p = await zbudujOms({ env: { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_KANALY: '[]', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog, ...extra } });
  zalozKonto(p.db, { login: 'admin', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'czytelnik').id, ['ustawienia']);
  p.admin = naglowkiKonta(p.db, 'admin', extra.OMS_TRYB === 'proba');
  return p;
}
function naglowkiKonta(db, login, proba = false) {
  return { cookie: jako(db, login).cookie.replace('sesja_oms=', `${nazwaCiasteczkaOms(proba)}=`) };
}
function upload(app, konto, bajty = PNG, alt = 'Pracownia Przykładowa', nazwa = 'znak.png') {
  const granica = 'oms-logo-test';
  const payload = Buffer.concat([Buffer.from(`--${granica}\r\nContent-Disposition: form-data; name="alt"\r\n\r\n${alt}\r\n--${granica}\r\nContent-Disposition: form-data; name="logo"; filename="${nazwa}"\r\nContent-Type: application/octet-stream\r\n\r\n`), bajty, Buffer.from(`\r\n--${granica}--\r\n`)]);
  return app.inject({ method: 'POST', url: ZAPIS, headers: { ...konto, origin: 'http://localhost', 'content-type': `multipart/form-data; boundary=${granica}` }, payload });
}
const adresy = html => ({ belka: html.match(/class="pas-logo" src="([^"]+)"/)?.[1], ikona: html.match(/rel="icon"[^>]*href="([^"]+)"/)?.[1] });

it('PNG zapisuje się z autorem; przeładowanie zmienia wersję belki i ikony bez restartu; usunięcie przywraca paczkę', async () => {
  const p = await panel();
  const przed = adresy((await get(p.app, EKRAN, p.admin)).body);
  expect((await upload(p.app, p.admin, PNG, 'Znak "<b>', 'znak.txt')).statusCode).toBe(303);
  const zapis = wczytajKonfiguracjeIntegracji(p.db, 'logo');
  expect(zapis).toMatchObject({ kontoLogin: 'admin', ustawienia: { png: PNG.toString('base64'), alt: 'Znak "<b>' } });
  expect(Date.parse(zapis.zmienionoAt)).toBeGreaterThan(0);
  const html = (await get(p.app, EKRAN, p.admin)).body;
  expect(html).toContain('alt="Znak &#34;&lt;b&gt;"');
  expect(html).toContain('enctype="multipart/form-data"');
  const po = adresy(html);
  for (const nazwa of ['belka', 'ikona']) {
    expect(po[nazwa]).toMatch(/\?v=[a-f0-9]{10}$/);
    expect(po[nazwa]).not.toBe(przed[nazwa]);
    expect((await p.app.inject(po[nazwa])).rawPayload).toEqual(PNG);
  }
  expect((await p.app.inject('/favicon.ico')).headers.location).toBe(po.ikona);
  expect((await post(p.app, `${ZAPIS}/usun`, p.admin)).statusCode).toBe(303);
  expect(wczytajKonfiguracjeIntegracji(p.db, 'logo')).toBeNull();
  expect(adresy((await get(p.app, EKRAN, p.admin)).body)).toEqual(przed);
  for (const rozmiar of [32, 192]) expect((await p.app.inject(`/public/favicon-${rozmiar}.png`)).rawPayload)
    .toEqual(readFileSync(new URL(`../../../src/public/favicon-${rozmiar}.png`, import.meta.url)));
});
it.each([
  ['SVG', Buffer.from('<svg onload="alert(1)"></svg>'), 'Plik nie jest obrazem PNG'],
  ['nadmiar bajtów', Buffer.concat([PNG, Buffer.alloc(256 * 1024)]), 'Plik większy niż 256 KB'],
])('odrzuca błędny plik: %s', async (_nazwa, bajty, komunikat) => {
  const p = await panel();
  const r = await upload(p.app, p.admin, bajty);
  expect(r.statusCode).toBe(400);
  expect(r.body).toContain(komunikat);
  expect(wczytajKonfiguracjeIntegracji(p.db, 'logo')).toBeNull();
});
it('limit jest włącznie: dokładnie 256 KB jest dozwolone', async () => {
  const p = await panel();
  expect((await upload(p.app, p.admin, Buffer.concat([PNG, Buffer.alloc(256 * 1024 - PNG.length)]))).statusCode).toBe(303);
});
it('plik konfiguracji wygrywa z bazą: zapis i usunięcie = 409, bajty i alt nadal z pliku', async () => {
  const plik = join(katalog, 'logo.png');
  const logo = readFileSync(new URL('../../../src/public/favicon-192.png', import.meta.url));
  writeFileSync(plik, logo);
  const p = await panel({ OMS_LOGO_PLIK: plik, OMS_LOGO_ALT: 'Z pliku' });
  const html = (await get(p.app, EKRAN, p.admin)).body;
  expect(html).toContain('Logo ustawione w pliku konfiguracji');
  expect(html).not.toContain(`action="${ZAPIS}"`);
  expect((await upload(p.app, p.admin)).statusCode).toBe(409);
  expect((await post(p.app, `${ZAPIS}/usun`, p.admin)).statusCode).toBe(409);
  for (const url of Object.values(adresy(html))) expect((await p.app.inject(url)).rawPayload).toEqual(logo);
  expect(html).toContain('alt="Z pliku"');
});
it('PRZ-108.03b: pole pliku leży w strefie przeciągania z etykietą, skrypt ma adres z wersją, bez skryptu formularz zostaje zwykły', async () => {
  const p = await panel();
  const html = (await get(p.app, EKRAN, p.admin)).body;
  const strefa = html.match(/<div class="logo-strefa"[^>]*data-logo-strefa[^>]*>([\s\S]*?)<\/form>/);
  expect(strefa, 'strefa z atrybutem data-logo-strefa w formularzu logo').not.toBeNull();
  expect(strefa[0]).toContain('role="group"');
  expect(strefa[0]).toContain('Przeciągnij plik PNG tutaj albo wybierz z dysku');
  // to samo pole, które wysyła formularz: name="logo", accept PNG, wymagane — strefa niczego nie dubluje
  expect(strefa[1]).toMatch(/<input id="logo-plik" type="file" name="logo" accept="image\/png" required/);
  expect(strefa[1]).toContain('data-logo-stan');
  expect(strefa[1]).toContain('data-logo-podglad');
  expect(html).toMatch(/<script type="module" src="\/public\/logo-przeciaganie\.js\?v=[a-f0-9]{10}"><\/script>/);
  expect((await p.app.inject(html.match(/src="(\/public\/logo-przeciaganie\.js\?v=[a-f0-9]{10})"/)[1])).statusCode).toBe(200);
});
it('PRZ-108.03b: konto bez admina nie dostaje strefy ani skryptu przeciągania', async () => {
  const p = await panel();
  const html = (await get(p.app, EKRAN, jako(p.db, 'czytelnik'))).body;
  expect(html).not.toContain('data-logo-strefa');
  expect(html).not.toMatch(/<script[^>]*logo-przeciaganie/);
});
it('konto z dostępem do Ustawień bez admina: upload i usunięcie = 403', async () => {
  const p = await panel();
  const konto = jako(p.db, 'czytelnik');
  expect((await upload(p.app, konto)).statusCode).toBe(403);
  expect((await post(p.app, `${ZAPIS}/usun`, konto)).statusCode).toBe(403);
  expect((await get(p.app, EKRAN, konto)).body).not.toContain(`action="${ZAPIS}"`);
});
it('gość demo nie zapisze nawet z flagą admina: wspólna blokada POST daje 403', async () => {
  const p = await panel({ OMS_TRYB: 'proba', OMS_DEMO_LOGIN: 'admin', OMS_DEMO_HASLO: 'fixture' });
  const r = await upload(p.app, p.admin);
  expect(r.statusCode).toBe(403);
  expect(r.body).toContain('W wersji demonstracyjnej ustawienia można tylko obejrzeć');
  expect((await post(p.app, `${ZAPIS}/usun`, p.admin)).statusCode).toBe(403);
  expect(wczytajKonfiguracjeIntegracji(p.db, 'logo')).toBeNull();
});
it('zapis przetrwa ponowne zbudowanie aplikacji, a env przykrywa go bez zmiany wpisu', async () => {
  const plik = join(katalog, 'pierwszenstwo.png');
  const envLogo = readFileSync(new URL('../../../src/public/favicon-192.png', import.meta.url));
  writeFileSync(plik, envLogo);
  let a = await panel();
  expect((await upload(a.app, a.admin)).statusCode).toBe(303);
  const zapis = wczytajKonfiguracjeIntegracji(a.db, 'logo');
  await a.app.close();
  const db = a.db;
  p = await zbudujOms({ db, env: { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_KANALY: '[]', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog } });
  expect((await p.app.inject('/public/favicon-32.png')).rawPayload).toEqual(PNG);
  await p.app.close();
  p = await zbudujOms({ db, env: { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_KANALY: '[]', OMS_SPRZEDAWCA_NIP: '1234563218',
    OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog, OMS_LOGO_PLIK: plik, OMS_LOGO_ALT: 'Z pliku' } });
  expect((await p.app.inject('/public/favicon-32.png')).rawPayload).toEqual(envLogo);
  expect((await upload(p.app, jako(db, 'admin'))).statusCode).toBe(409);
  expect(wczytajKonfiguracjeIntegracji(db, 'logo')).toEqual(zapis);
});
