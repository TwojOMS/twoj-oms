#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PLIKI_INSTALACJI, odczytajEnv, opcje, oczyscPowod, coDalejLokalnie } from './instalacja-wspolne.mjs';
// Dynamicznie, PO kontroli wersji z instalacja-wspolne.mjs (PRZ-093.03): statyczny import node:sqlite albo .ts
// wywraca skrypt na Node 20 jeszcze przed ewaluacją pierwszego modułu, bez słowa o wersji.
const { DatabaseSync } = await import('node:sqlite');
const { uruchomOms } = await import('../src/main.ts');
let etap = 'start';
const sekrety = [];

function wymagany(plik) { if (!fs.existsSync(plik)) throw new Error('INSTALACJA_BRAK_PRZYGOTOWANIA'); }
function cookie(odpowiedz) {
  const surowe = [odpowiedz.headers['set-cookie'] ?? ''].flat().join('; ');
  const dopasowanie = surowe.match(/sesja_oms(?:_proba)?=[^;]+/);
  if (!dopasowanie) throw new Error('INSTALACJA_BRAK_SESJI');
  return dopasowanie[0];
}
async function formularz(url, pola, headers = {}) {
  return zadanie(url, { method: 'POST', headers: { origin: new URL(url).origin, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(pola).toString() });
}
function zadanie(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      res.resume();
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.once('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('INSTALACJA_HTTP_TIMEOUT')));
    if (body !== null) req.end(body); else req.end();
  });
}
async function uruchom(env, port) { return uruchomOms({ ...env, OMS_PORT: String(port) }, '127.0.0.1'); }
function sprawdzBaze(plik) {
  const db = new DatabaseSync(plik, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('INSTALACJA_BAZA_NIESPOJNA');
  } finally { db.close(); }
}

async function main() {
  const { katalog, port } = opcje(process.argv.slice(2));
  const znacznik = path.join(katalog, PLIKI_INSTALACJI.znacznik);
  const plikEnv = path.join(katalog, PLIKI_INSTALACJI.proba);
  wymagany(znacznik); wymagany(plikEnv);
  const env = odczytajEnv(plikEnv);
  sekrety.push(env.OMS_PASS);
  const dbPath = env.OMS_DB_PATH;
  if (!dbPath || path.resolve(dbPath) !== path.join(katalog, PLIKI_INSTALACJI.baza)) throw new Error('INSTALACJA_NIEZGODNY_KATALOG');
  if (env.OMS_TRYB !== 'proba' || env.OMS_KANALY !== '[]' || env.OMS_PORT !== String(port)
    || path.resolve(env.OMS_PROFORMY_KATALOG ?? '') !== path.join(katalog, 'proformy')
    || path.resolve(env.OMS_ETYKIETY_KATALOG ?? '') !== path.join(katalog, 'etykiety')) throw new Error('INSTALACJA_NIEZGODNY_KATALOG');
  if ([dbPath, `${dbPath}-wal`, `${dbPath}-shm`, ...[PLIKI_INSTALACJI.kopia, PLIKI_INSTALACJI.daneAdmina, PLIKI_INSTALACJI.odtworzenie].map(plik => path.join(katalog, plik))].some(fs.existsSync)) throw new Error('INSTALACJA_ODMOWA_NADPISANIA');
  const url = `http://127.0.0.1:${port}`;
  const hasloAdmina = (await import('node:crypto')).randomBytes(24).toString('base64url');
  sekrety.push(hasloAdmina);
  etap = 'pierwszy-start'; let pierwsze = await uruchom(env, port);
  try {
    etap = 'health'; const health = await zadanie(`${url}/health`);
    if (health.status !== 200) throw new Error('INSTALACJA_HEALTH_ODMOWA');
    etap = 'login-serwisowy'; const wejscie = await formularz(`${url}/login`, { uzytkownik: env.OMS_USER, haslo: env.OMS_PASS, powrot: '/ustawienia/konta' });
    if (wejscie.status !== 302) throw new Error('INSTALACJA_LOGIN_SERWISOWY_ODMOWA');
    etap = 'admin'; const dodanie = await formularz(`${url}/ustawienia/konta/nowe`, { login: 'administrator-proby', imie: 'Administrator próby', haslo: hasloAdmina, rola: 'administrator' }, { cookie: cookie(wejscie) });
    if (dodanie.status !== 302) throw new Error('INSTALACJA_ADMIN_ODMOWA');
    fs.writeFileSync(path.join(katalog, PLIKI_INSTALACJI.daneAdmina), `login=administrator-proby\nhaslo=${hasloAdmina}\n`, { mode: 0o600, flag: 'wx' });
  } finally { await pierwsze.zamknij(); }
  etap = 'restart'; pierwsze = await uruchom(env, port);
  try {
    etap = 'degradacja'; const serwisowe = await formularz(`${url}/login`, { uzytkownik: env.OMS_USER, haslo: env.OMS_PASS, powrot: '/' });
    if (serwisowe.status !== 401) throw new Error('INSTALACJA_DEGRADACJA_KONTA');
    etap = 'login-admina'; const admin = await formularz(`${url}/login`, { uzytkownik: 'administrator-proby', haslo: hasloAdmina, powrot: '/ustawienia/konta' });
    if (admin.status !== 302) throw new Error('INSTALACJA_LOGIN_ADMINA_ODMOWA');
    etap = 'konto-admina'; const konto = await zadanie(`${url}/ustawienia/konta`, { headers: { cookie: cookie(admin) } });
    if (konto.status !== 200) throw new Error('INSTALACJA_ADMIN_NIETRWALY');
    const kopia = path.join(katalog, PLIKI_INSTALACJI.kopia);
    if (fs.existsSync(kopia)) throw new Error('INSTALACJA_ODMOWA_NADPISANIA');
    const db = new DatabaseSync(dbPath);
    try { db.exec(`VACUUM INTO '${kopia.replaceAll("'", "''")}'`); } finally { db.close(); }
  } finally { await pierwsze.zamknij(); }
  const kopia = path.join(katalog, PLIKI_INSTALACJI.kopia);
  sprawdzBaze(kopia);
  const katalogOdtworzenia = path.join(katalog, PLIKI_INSTALACJI.odtworzenie);
  if (fs.existsSync(katalogOdtworzenia)) throw new Error('INSTALACJA_ODMOWA_NADPISANIA');
  fs.mkdirSync(katalogOdtworzenia);
  const odtworzonaBaza = path.join(katalogOdtworzenia, PLIKI_INSTALACJI.baza);
  fs.copyFileSync(kopia, odtworzonaBaza, fs.constants.COPYFILE_EXCL);
  const envOdtworzenia = { ...env, OMS_DB_PATH: odtworzonaBaza };
  etap = 'start-odtworzenia'; pierwsze = await uruchom(envOdtworzenia, port);
  try {
    etap = 'login-odtworzenia'; const admin = await formularz(`${url}/login`, { uzytkownik: 'administrator-proby', haslo: hasloAdmina, powrot: '/ustawienia/konta' });
    if (admin.status !== 302) throw new Error('INSTALACJA_RESTORE_LOGIN_ODMOWA');
  } finally { await pierwsze.zamknij(); }
  sprawdzBaze(odtworzonaBaza);
  for (const linia of coDalejLokalnie({ katalog, port })) console.log(linia);
  console.log(JSON.stringify({ status: 'proba-zakonczona', katalog, port, kontoProby: path.join(katalog, PLIKI_INSTALACJI.daneAdmina), health: 'HTTP/DB gotowe; integracje niepodlaczone' }));
}

// PRZ-093.03: kod etapu zostaje, dochodzi powód (np. „listen EADDRINUSE … 127.0.0.1:39151”). Hasła serwisowe
// i administratora są w `sekrety` — maskowane, gdyby trafiły do cudzego komunikatu.
main().catch((e) => {
  console.error(e instanceof Error && /^INSTALACJA_/.test(e.message) ? e.message
    : `INSTALACJA_PROBA_${etap.toUpperCase().replaceAll('-', '_')}: ${oczyscPowod(e instanceof Error ? e.message : e, sekrety)}`);
  process.exitCode = 1;
});
