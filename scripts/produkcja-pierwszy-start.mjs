#!/usr/bin/env node
// PRZ-062: pierwszy start PRODUKCJI w kontenerze klienta. Uruchamia go `aktualizuj.sh produkcja`
// (docker exec oms node scripts/produkcja-pierwszy-start.mjs) na świeżej, pustej bazie, gdy OMS już
// odpowiada na /health. Robi dwie rzeczy, których próba nie przenosi (baza próby zostaje w archiwum):
//   1. jawne granice raportu sprzedaży dla każdego kanału raportowego (instalacja bez historii) —
//      bez nich /raporty odmawia (400) przy pierwszym zamówieniu kanału;
//   2. pierwsze konto administratora przez panel (jak instalacja-proba.mjs) — potem konto serwisowe
//      z oms.env przestaje logować (degradacja), więc hasło z pliku konfiguracji nie jest już wejściem.
// Na stdout WYŁĄCZNIE dane konta (login=, haslo=) — aktualizator zapisuje je do pliku 0600, nie na ekran.
// Kody i opis — na stderr, bez wartości konfiguracji.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as sciezkaBezwzgledna } from 'node:path';
import { pathToFileURL } from 'node:url';
import { efektywnyTryb } from '../src/core/tryb.ts';
import { zalozGranice } from '../src/moduly/raporty/granice-start.js';
export { planGranic, zalozGranice } from '../src/moduly/raporty/granice-start.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
export const LOGIN_ADMINA = 'administrator';

function zadanie(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.once('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('PRODUKCJA_HTTP_TIMEOUT')));
    if (body !== null) req.end(body); else req.end();
  });
}
const formularz = (url, pola, headers = {}) => zadanie(url, { method: 'POST', body: new URLSearchParams(pola).toString(),
  headers: { origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded', ...headers } });
function ciastko(odp) {
  const m = [odp.headers['set-cookie'] ?? ''].flat().join('; ').match(/sesja_oms(?:_proba)?=[^;]+/);
  if (!m) throw new Error('PRODUKCJA_BRAK_SESJI');
  return m[0];
}

/** Pierwszy administrator przez panel; konto serwisowe z oms.env po nim nie loguje (sprawdzane). */
export async function zalozAdministratora(url, env) {
  const haslo = randomBytes(24).toString('base64url');
  const serwis = await formularz(`${url}/login`, { uzytkownik: env.OMS_USER, haslo: env.OMS_PASS, powrot: '/ustawienia/konta' });
  if (serwis.status !== 302) throw new Error('PRODUKCJA_LOGIN_SERWISOWY_ODMOWA');
  const nowe = await formularz(`${url}/ustawienia/konta/nowe`, { login: LOGIN_ADMINA, imie: 'Administrator', haslo, rola: 'administrator' }, { cookie: ciastko(serwis) });
  if (nowe.status !== 302) throw new Error('PRODUKCJA_ADMIN_ODMOWA');
  const poAdminie = await formularz(`${url}/login`, { uzytkownik: env.OMS_USER, haslo: env.OMS_PASS, powrot: '/' });
  if (poAdminie.status !== 401) throw new Error('PRODUKCJA_KONTO_SERWISOWE_NADAL_LOGUJE');
  const admin = await formularz(`${url}/login`, { uzytkownik: LOGIN_ADMINA, haslo, powrot: '/' });
  if (admin.status !== 302) throw new Error('PRODUKCJA_LOGIN_ADMINA_ODMOWA');
  return haslo;
}

async function main() {
  const env = process.env;
  if (efektywnyTryb(env) !== 'produkcja') throw new Error('PRODUKCJA_TO_NIE_PRODUKCJA');
  if (!env.OMS_DB_PATH) throw new Error('PRODUKCJA_BRAK_BAZY');
  if (process.argv.includes('--granice')) {
    // Kanał dopisany po przejściu (instrukcja, sekcja 9): ta sama reguła dnia co przy przejściu —
    // dzień przed <P>_OD albo wczoraj — zamiast daty liczonej w głowie (recenzja D8 r1, P2-1).
    // OMS działa obok i pisze do tej samej bazy: czekamy do 10 s na blokadę zamiast „database is locked”.
    const baza = new DatabaseSync(env.OMS_DB_PATH, { timeout: 10_000 });
    try { process.stdout.write(JSON.stringify({ status: 'granice', ...zalozGranice(baza, env) }) + '\n'); }
    finally { baza.close(); }
    return;
  }
  const db = new DatabaseSync(env.OMS_DB_PATH);
  let wynik;
  try {
    const ile = (tabela) => db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n;
    // Świeża baza: bez zamówień, historii i kont. Inaczej to nie jest przejście, tylko czyjaś praca.
    if (ile('konta') > 0) throw new Error('PRODUKCJA_KONTO_JUZ_ISTNIEJE');
    if (ile('zamowienia') > 0 || ile('sprzedaz_historyczna') > 0) throw new Error('PRODUKCJA_BAZA_NIE_JEST_NOWA');
    wynik = zalozGranice(db, env);
  } finally { db.close(); }
  const haslo = await zalozAdministratora(`http://127.0.0.1:${env.OMS_PORT || 3001}`, env);
  process.stdout.write(`login=${LOGIN_ADMINA}\nhaslo=${haslo}\n`);
  process.stderr.write(JSON.stringify({ status: 'produkcja-pierwszy-start', konto: LOGIN_ADMINA, granice: wynik.zalozone,
    graniceDoPomiaru: wynik.pominiete }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(sciezkaBezwzgledna(process.argv[1])).href) {
  main().catch((e) => {
    process.stderr.write((e instanceof Error && /^PRODUKCJA_/.test(e.message) ? e.message : `PRODUKCJA_PIERWSZY_START_ODMOWA: ${e instanceof Error ? e.message : e}`) + '\n');
    process.exitCode = 1;
  });
}
