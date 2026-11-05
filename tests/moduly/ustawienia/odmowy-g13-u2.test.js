// PRZ-152.G13u2: odmowy ustawień (magazyn, poczta, podpis maili, logo) w układzie OMS zamiast gołego tekstu.
// Status i tekst bez zmian; strona HTML z paskiem uwagi i przyciskiem powrotu. Dane zmyślone.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, post } from '../../pomoc/konta-prz068.js';
import { nazwaCiasteczkaOms } from '../../../src/core/bezpieczenstwo/sesja.js';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { createModulWiadomosci } from '../../../src/moduly/wiadomosci/modul.ts';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { modulMarketing } from '../../../src/moduly/marketing/modul.ts';
import { modulZdrowie } from '../../../src/moduly/zdrowie/modul.ts';

const ENV_SMTP = { SMTP_HOST: 'smtp.pracownia.example.test', SMTP_USER: 'sklep@pracownia.example.test', SMTP_PASS: 'zmyslone-g13' };
const POCZTA = '/ustawienia/integracje/poczta';
const PODPIS = '/ustawienia/komunikacja/podpis';
const katalog = mkdtempSync(join(tmpdir(), 'oms-g13u2-'));
afterAll(() => rmSync(katalog, { recursive: true, force: true }));

let p;
afterEach(async () => { await p?.app.close(); p?.db.close(); p = null; });

function sprawdz(r, status, tekst, { tytul, wroc, napis }) {
  expect(r.statusCode).toBe(status);
  expect(r.headers['content-type']).toMatch(/^text\/html/);
  expect(r.body).toMatch(/<html/);
  expect(r.body).toContain(`<p class="pasek-uwaga" role="alert">${tekst}</p>`);
  expect(r.body).toContain(`<h1>${tytul}</h1>`);
  expect(r.body).toContain(`<a class="btn" href="${wroc}">${napis}</a>`);
}

async function panelPoczty(env = {}, { wiadomosci = true } = {}) {
  const moduly = [modulRdzen, modulWeb, modulKanaly, createModulFaktury(),
    ...(wiadomosci ? [createModulWiadomosci()] : []),
    createModulZamowienia({ zWiadomosciami: wiadomosci }), createModulWysylka(), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie];
  p = nowyPanel({ moduly, env });
  await p.app.ready();
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  p.admin = jako(p.db, 'adam');
  return p;
}

describe('magazyn', () => {
  it('zła wartość przełącznika: 400 w układzie OMS, powrót na ekran magazynu', async () => {
    await panelPoczty();
    const r = await post(p.app, '/ustawienia/magazyn/stany', p.admin, { wlacz: 'tak' });
    sprawdz(r, 400, 'Pole „wlacz” musi mieć wartość 1 albo 0.', { tytul: 'Nie udało się zmienić stanów magazynowych', wroc: '/ustawienia/magazyn', napis: 'Wróć do ustawień magazynu' });
  });
});

describe('poczta', () => {
  it('SMTP z pliku: zapis serwera = 409 w układzie OMS', async () => {
    await panelPoczty(ENV_SMTP);
    const r = await post(p.app, POCZTA, p.admin, { host: 'x.example.test', port: '587' });
    sprawdz(r, 409, 'Serwer poczty (SMTP_…) jest ustawiony w pliku konfiguracji (oms.env) — tam go zmień. Formularz niczego nie zapisał.',
      { tytul: 'Nie zapisano ustawień poczty', wroc: POCZTA, napis: 'Wróć do ustawień poczty' });
  });
  it('adres panelu z pliku: zapis adresu = 409', async () => {
    await panelPoczty({ OMS_ADRES_PANELU: 'https://panel.example.test' });
    const r = await post(p.app, `${POCZTA}/adres`, p.admin, { adres: 'https://inny.example.test' });
    sprawdz(r, 409, 'Adres panelu (OMS_ADRES_PANELU) jest ustawiony w pliku konfiguracji (oms.env) — tam go zmień. Formularz niczego nie zapisał.',
      { tytul: 'Nie zapisano ustawień poczty', wroc: POCZTA, napis: 'Wróć do ustawień poczty' });
  });
  it('podpis bez modułu wiadomości: 404', async () => {
    await panelPoczty(ENV_SMTP, { wiadomosci: false });
    const r = await post(p.app, `${POCZTA}/podpis`, p.admin, { marka: 'X' });
    sprawdz(r, 404, 'Podpis maili wymaga modułu wiadomości.', { tytul: 'Nie zapisano podpisu maili', wroc: `${PODPIS}#podpis-maili`, napis: 'Wróć do podpisu maili' });
  });
  it('podpis z pliku: 409 z nazwami pól', async () => {
    await panelPoczty({ ...ENV_SMTP, OMS_MAIL_MARKA: 'Lampy z Pliku', OMS_MAIL_STOPKA: 'Stopka z pliku' });
    const r = await post(p.app, `${POCZTA}/podpis`, p.admin, { marka: 'X', stopka: 'Y' });
    sprawdz(r, 409, 'Marka (OMS_MAIL_MARKA) i Stopka (OMS_MAIL_STOPKA): ustawione w pliku konfiguracji (oms.env) — tam je zmień. Formularz niczego nie zapisał.',
      { tytul: 'Nie zapisano podpisu maili', wroc: `${PODPIS}#podpis-maili`, napis: 'Wróć do podpisu maili' });
  });
});

describe('logo', () => {
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1sAAAAASUVORK5CYII=', 'base64');
  const WROC = { tytul: 'Nie zapisano logo', wroc: '/ustawienia/firma#logo', napis: 'Wróć do ustawień firmy' };
  async function panelLogo(extra = {}) {
    p = await zbudujOms({ env: { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_KANALY: '[]', OMS_SPRZEDAWCA_NIP: '1234563218',
      OMS_PROFORMY_KATALOG: katalog, OMS_ETYKIETY_KATALOG: katalog, ...extra } });
    zalozKonto(p.db, { login: 'admin', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
    zalozKonto(p.db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'h', rola: 'sprzedaz' });
    ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'czytelnik').id, ['ustawienia']);
    const konto = (login) => ({ cookie: jako(p.db, login).cookie.replace('sesja_oms=', `${nazwaCiasteczkaOms(false)}=`) });
    p.konta = { admin: konto('admin'), czytelnik: konto('czytelnik') };
    return p;
  }
  const wyslij = (konto, czesci, url = '/ustawienia/firma/logo') => {
    const g = 'g13u2';
    const payload = Buffer.concat([...czesci.map((c) => Buffer.concat([Buffer.from(`--${g}\r\n${c.naglowek}\r\n\r\n`), Buffer.isBuffer(c.tresc) ? c.tresc : Buffer.from(c.tresc), Buffer.from('\r\n')])), Buffer.from(`--${g}--\r\n`)]);
    return p.app.inject({ method: 'POST', url, headers: { ...konto, origin: 'http://localhost', 'content-type': `multipart/form-data; boundary=${g}` }, payload });
  };
  const plik = (tresc = PNG, pole = 'logo') => ({ naglowek: `Content-Disposition: form-data; name="${pole}"; filename="z.png"\r\nContent-Type: application/octet-stream`, tresc });
  const alt = (tresc) => ({ naglowek: 'Content-Disposition: form-data; name="alt"', tresc });

  it('nie-administrator: 403', async () => {
    await panelLogo();
    sprawdz(await wyslij(p.konta.czytelnik, [plik()]), 403, 'Logo zmienia tylko administrator. Formularz niczego nie zapisał.', WROC);
  });
  it('usuwanie przez nie-administratora: 403', async () => {
    await panelLogo();
    sprawdz(await wyslij(p.konta.czytelnik, [], '/ustawienia/firma/logo/usun'), 403, 'Logo zmienia tylko administrator. Formularz niczego nie zapisał.', WROC);
  });
  it('logo z pliku: 409', async () => {
    writeFileSync(join(katalog, 'z-pliku.png'), PNG);
    await panelLogo({ OMS_LOGO_PLIK: join(katalog, 'z-pliku.png') });
    sprawdz(await wyslij(p.konta.admin, [plik()]), 409, 'Logo ustawione w pliku konfiguracji (OMS_LOGO_PLIK w oms.env) — tam je zmień. Formularz niczego nie zapisał.', WROC);
  });
  it('za duży plik: 400', async () => {
    await panelLogo();
    sprawdz(await wyslij(p.konta.admin, [plik(Buffer.concat([PNG, Buffer.alloc(256 * 1024)]))]), 400, 'Plik większy niż 256 KB', WROC);
  });
  it('zła nazwa pola pliku: 400', async () => {
    await panelLogo();
    sprawdz(await wyslij(p.konta.admin, [plik(PNG, 'inne')]), 400, 'Wybierz plik logo.', WROC);
  });
  it('za długi alt: 400', async () => {
    await panelLogo();
    sprawdz(await wyslij(p.konta.admin, [alt('a'.repeat(201))]), 400, 'Tekst alternatywny może mieć do 200 znaków.', WROC);
  });
  it('plik nie jest PNG: 400', async () => {
    await panelLogo();
    sprawdz(await wyslij(p.konta.admin, [plik(Buffer.from('<svg></svg>'))]), 400, 'Plik nie jest obrazem PNG', WROC);
  });
  it('nieczytelny formularz: 400', async () => {
    await panelLogo();
    const r = await p.app.inject({ method: 'POST', url: '/ustawienia/firma/logo', headers: { ...p.konta.admin, origin: 'http://localhost', 'content-type': 'multipart/form-data; boundary=g13u2' }, payload: '--g13u2\r\nContent-Disposition: form-data; name="logo"; filename="z.png"\r\n\r\nurwane' });
    sprawdz(r, 400, 'Nie udało się odczytać formularza logo. Wybierz jeden plik PNG i spróbuj ponownie.', WROC);
  });
});
