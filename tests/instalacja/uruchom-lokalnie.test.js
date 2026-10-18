// PRZ-093: OMS lokalnie na laptopie wykonawcy (skill .claude/skills/run-oms) — scripts/uruchom-lokalnie.mjs
// start → panel z atrapami na 127.0.0.1:<port>, świeża baza demo w katalogu tymczasowym, konto lokalne;
// stop → proces zabity, port wolny, katalog skasowany. Test woła skrypt tak jak agent: osobnym procesem.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKRYPT = path.join(ROOT, 'scripts', 'uruchom-lokalnie.mjs');
const katalogi = [];

function skrypt(...argumenty) {
  const r = spawnSync(process.execPath, [SKRYPT, ...argumenty], { cwd: ROOT, encoding: 'utf8', timeout: 150000 });
  const linie = (r.stdout ?? '').trim().split('\n').filter(Boolean);
  let wynik = null;
  try { wynik = JSON.parse(linie.at(-1) ?? ''); } catch { /* wynik zostaje null — asercja pokaże stdout */ }
  return { kod: r.status, wynik, stdout: r.stdout, stderr: r.stderr };
}
const wolnyPort = () => new Promise((ok, zle) => {
  const s = net.createServer();
  s.once('error', zle);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => ok(port)); });
});
const portZajety = (port) => new Promise((ok) => {
  const g = net.connect({ port, host: '127.0.0.1' });
  g.once('connect', () => { g.destroy(); ok(true); });
  g.once('error', () => ok(false));
});
const zyje = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const nowyKatalog = () => { const k = path.join(os.tmpdir(), `oms-lokalnie-test-${process.pid}-${katalogi.length}`); katalogi.push(k); return k; };

// Sprzątanie ZAWSZE, także gdy test padł w połowie: `stop --sila` (nie wymaga odpowiedzi /health), a gdyby i to
// zawiodło — zabicie PID-u wprost z pliku stanu. Dopiero potem kasujemy katalog. Bez tego osierocony serwer
// trzymał port i trzeba go było zabijać ręcznie.
afterAll(() => {
  for (const k of katalogi) {
    let pid = null;
    try { pid = JSON.parse(fs.readFileSync(path.join(k, 'stan.json'), 'utf8')).pid; } catch { /* brak stanu = nic nie wstało */ }
    skrypt('stop', '--sila', '--katalog', k);
    if (pid && zyje(pid)) { try { process.kill(pid); } catch { /* już nie żyje */ } }
    fs.rmSync(k, { recursive: true, force: true });
  }
}, 120000);

const FORM = 'application/x-www-form-urlencoded';
const ciasteczkoSesji = (odpowiedz) => odpowiedz.headers.get('set-cookie')?.match(/sesja_oms_proba=[^;]+/)?.[0];

describe('scripts/uruchom-lokalnie.mjs — OMS na laptopie wykonawcy', () => {
  it('start na wskazanym porcie: /health odpowiada, konto lokalne loguje się, Zamówienia mają dane demo; stop zwalnia port', async () => {
    const katalog = nowyKatalog();
    const port = await wolnyPort();
    const start = skrypt('start', '--port', String(port), '--katalog', katalog);
    expect(start.kod, start.stderr + start.stdout).toBe(0);
    const w = start.wynik;
    expect(w).toMatchObject({ status: 'dziala', port, adres: `http://127.0.0.1:${port}`, katalog });
    expect(zyje(w.pid)).toBe(true);
    // Baza i logi WYŁĄCZNIE w katalogu tymczasowym — nic w kopii roboczej repo.
    expect(fs.existsSync(path.join(katalog, 'oms.sqlite'))).toBe(true);
    expect(path.resolve(w.log).startsWith(path.resolve(katalog))).toBe(true);

    const zdrowie = await fetch(`${w.adres}/health`);
    expect(zdrowie.status).toBeLessThan(500);

    const konto = JSON.parse(fs.readFileSync(w.plikKonta, 'utf8'));
    expect(konto.login).toBe(w.login);
    const login = await fetch(`${w.adres}/login`, { method: 'POST', redirect: 'manual',
      headers: { origin: w.adres, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ uzytkownik: konto.login, haslo: konto.haslo, powrot: '/' }) });
    expect(login.status).toBe(302);
    const cookie = login.headers.get('set-cookie')?.match(/sesja_oms_proba=[^;]+/)?.[0];
    expect(cookie, 'ciasteczko sesji trybu próby').toBeTruthy();
    // Lista zamówień to strona główna `/`.
    const zamowienia = await fetch(`${w.adres}/`, { redirect: 'manual', headers: { cookie } });
    expect(zamowienia.status).toBe(200);
    const html = await zamowienia.text();
    expect(html).toMatch(/<title>Zamówienia/);
    // Dane z generatora demo, nie pusta lista: najnowsze zamówienie z bazy stoi na ekranie.
    const db = new DatabaseSync(path.join(katalog, 'oms.sqlite'), { readOnly: true });
    let najnowsze;
    try { najnowsze = db.prepare('SELECT numer FROM zamowienia ORDER BY utworzone_at DESC LIMIT 1').get()?.numer; }
    finally { db.close(); }
    expect(najnowsze).toBeTruthy();
    expect(html).toContain(String(najnowsze));
    // Złe hasło nie wpuszcza (konto naprawdę ma hasło z pliku, a nie „cokolwiek”).
    const zle = await fetch(`${w.adres}/login`, { method: 'POST', redirect: 'manual',
      headers: { origin: w.adres, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ uzytkownik: konto.login, haslo: 'zle-haslo', powrot: '/' }) });
    expect(zle.headers.get('set-cookie') ?? '').not.toMatch(/sesja_oms_proba=[^;]{10,}/);

    // Drugi start w tym samym katalogu nie stawia drugiego procesu — oddaje działający.
    const znow = skrypt('start', '--port', String(port), '--katalog', katalog);
    expect(znow.kod).toBe(0);
    expect(znow.wynik).toMatchObject({ status: 'juz-dziala', pid: w.pid, port });

    const stop = skrypt('stop', '--katalog', katalog);
    expect(stop.kod, stop.stderr).toBe(0);
    expect(stop.wynik).toMatchObject({ status: 'zatrzymany', pid: w.pid });
    expect(zyje(w.pid)).toBe(false);
    expect(await portZajety(port)).toBe(false);
    expect(fs.existsSync(katalog)).toBe(false);
  }, 180000);

  it('zaloguj: jednorazowy link loguje bez hasła w wyjściu; drugi użytek i wygasły link nie wpuszczają', async () => {
    const katalog = nowyKatalog();
    const port = await wolnyPort();
    const start = skrypt('start', '--port', String(port), '--katalog', katalog);
    expect(start.kod, start.stderr + start.stdout).toBe(0);
    const w = start.wynik;
    const haslo = JSON.parse(fs.readFileSync(w.plikKonta, 'utf8')).haslo;
    expect(haslo.length).toBeGreaterThan(10);
    // Hasła nie ma ani w wyniku `start` (to ta sama powłoka agenta).
    // Porównanie na wartości logicznej: przy porażce komunikat asercji nie wypisze hasła.
    expect((start.stdout + start.stderr).includes(haslo), "hasło w wyjściu start").toBe(false);

    const wejscie = skrypt('zaloguj', '--katalog', katalog);
    expect(wejscie.kod, wejscie.stderr + wejscie.stdout).toBe(0);
    // Wyjście polecenia — całe, nie tylko ostatnia linia — nie zawiera hasła ani samego ciasteczka sesji.
    expect((wejscie.stdout + wejscie.stderr).includes(haslo), "hasło w wyjściu zaloguj").toBe(false);
    expect(wejscie.stdout + wejscie.stderr).not.toMatch(/sesja_oms/);
    expect(wejscie.wynik).toMatchObject({ status: 'gotowe', jednorazowy: true });
    const link = wejscie.wynik.link;
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/wejscie\/[A-Za-z0-9_-]{20,}$/);

    // Bez ciasteczka lista Zamówień (strona główna `/`) się nie otwiera — przekierowanie na logowanie.
    const bez = await fetch(`${w.adres}/`, { redirect: 'manual' });
    expect([302, 401]).toContain(bez.status);

    // Pierwszy użytek: 302 z ciasteczkiem sesji, z którym `/` daje 200 (a lista ma dane demo).
    const raz = await fetch(link, { redirect: 'manual' });
    expect(raz.status).toBe(302);
    const cookie = ciasteczkoSesji(raz);
    expect(cookie, 'ciasteczko sesji trybu próby').toBeTruthy();
    expect(new URL(raz.headers.get('location'), link).origin).toBe(w.adres);
    const zamowienia = await fetch(`${w.adres}/`, { redirect: 'manual', headers: { cookie } });
    expect(zamowienia.status).toBe(200);
    expect(await zamowienia.text()).toMatch(/<title>Zamówienia/);

    // Drugi użytek tego samego linku: bez ciasteczka.
    const dwa = await fetch(link, { redirect: 'manual' });
    expect(dwa.status).toBeGreaterThanOrEqual(400);
    expect(dwa.headers.get('set-cookie')).toBeNull();
    // Zmyślony token — to samo.
    const zly = await fetch(link.replace(/\/[^/]+$/, '/zmyslony-token-zmyslony-token'), { redirect: 'manual' });
    expect(zly.status).toBeGreaterThanOrEqual(400);
    expect(zly.headers.get('set-cookie')).toBeNull();

    // Link wygasa: krótki czas życia (--wazny-sek), po nim nie loguje, choć nie był użyty.
    const krotki = skrypt('zaloguj', '--katalog', katalog, '--wazny-sek', '1');
    expect(krotki.kod, krotki.stderr).toBe(0);
    await new Promise((ok) => setTimeout(ok, 2500));
    const po = await fetch(krotki.wynik.link, { redirect: 'manual' });
    expect(po.status).toBeGreaterThanOrEqual(400);
    expect(po.headers.get('set-cookie')).toBeNull();

    // Nowy link po wygaśnięciu starego działa (jeden aktywny link naraz).
    const nowy = skrypt('zaloguj', '--katalog', katalog);
    const uzyty = await fetch(nowy.wynik.link, { redirect: 'manual' });
    expect(uzyty.status).toBe(302);
    expect(ciasteczkoSesji(uzyty)).toBeTruthy();

    expect(skrypt('stop', '--katalog', katalog).kod).toBe(0);
  }, 240000);

  it('zaloguj bez działającego serwera: odmowa z czytelnym komunikatem, bez linku', () => {
    const r = skrypt('zaloguj', '--katalog', nowyKatalog());
    expect(r.kod).not.toBe(0);
    expect(r.stderr).toMatch(/serwer nie działa — najpierw: .*start/);
    expect(r.stdout).not.toMatch(/wejscie/);
  });

  it('zajęty port: odmowa przed generatorem, bez procesu i bez bazy', async () => {
    const katalog = nowyKatalog();
    const blokada = net.createServer();
    await new Promise((ok) => blokada.listen(0, '127.0.0.1', ok));
    const port = blokada.address().port;
    try {
      const start = skrypt('start', '--port', String(port), '--katalog', katalog);
      expect(start.kod).not.toBe(0);
      expect(start.stderr).toMatch(new RegExp(`port ${port} zajęty`));
      expect(fs.existsSync(path.join(katalog, 'oms.sqlite'))).toBe(false);
    } finally { await new Promise((ok) => blokada.close(ok)); }
  }, 60000);

  it('stop bez działającego serwera kończy się czysto (kod 0, status „nie-dziala”)', () => {
    const stop = skrypt('stop', '--katalog', nowyKatalog());
    expect(stop.kod).toBe(0);
    expect(stop.wynik).toMatchObject({ status: 'nie-dziala' });
  });
});
