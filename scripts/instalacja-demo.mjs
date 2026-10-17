#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { opcje, PLIKI_INSTALACJI } from './instalacja-wspolne.mjs';

function bezDowiazan(katalog) {
  const root = path.parse(katalog).root;
  let current = root;
  for (const part of katalog.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || !stat.isDirectory()
      || fs.realpathSync(current).toLowerCase() !== path.resolve(current).toLowerCase()) {
      throw Error('INSTALACJA_DEMO_SCIEZKA_ODMOWA');
    }
  }
}
function odmowNadpisania(katalog) {
  bezDowiazan(katalog);
  if (fs.existsSync(katalog) && fs.readdirSync(katalog).length) throw Error('INSTALACJA_ODMOWA_NADPISANIA');
}
function etap(name, katalog, port) {
  bezDowiazan(katalog);
  const script = fileURLToPath(new URL(`./instalacja-${name}.mjs`, import.meta.url));
  const result = spawnSync(process.execPath, [script, '--katalog', katalog, '--port', String(port)], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: {}, encoding: 'utf8', timeout: 60000,
  });
  if (result.status !== 0) throw Error('INSTALACJA_DEMO_' + name.toUpperCase() + '_ODMOWA');
}
// Daty względem chwili instalacji (PRZ-089): ze sztywnym 2026-01-01…03 pierwszy ekran nowicjusza po pół roku
// pokazywał „po terminie o 204 dni rob.”. Zamówienie N złożone N godzin temu, wpłata 10 min później.
const godzinTemu = (teraz, h, min = 0) => new Date(teraz - h * 3600_000 + min * 60_000).toISOString();
async function wygeneruj(db, teraz = Date.now()) {
  const { zapiszZamowienie, zapiszFaktyStatusu } = await import('../src/oms/db/zamowienia.js');
  for (let number = 1; number <= 3; number++) {
    const code = String(number).padStart(3, '0');
    const id = zapiszZamowienie(db, 'demo', {
      zrodlo_id: number, numer: `DEMO-${code}`,
      klient: { first_name: `Osoba demonstracyjna ${number}`, last_name: 'Dane syntetyczne', email: `demo-${code}@email.invalid`, phone: '' },
      dostawa: { first_name: `Osoba demonstracyjna ${number}`, last_name: 'Dane syntetyczne', address_1: 'Ulica Przykładowa 1', city: 'Miasto demonstracyjne', postcode: '00-000', country: 'PL' },
      metoda_wysylki: 'odbior_osobisty', metoda_wysylki_nazwa: 'Odbiór osobisty — demo',
      kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '24.60',
      koszt_dostawy_brutto: '0.00', koszt_dostawy_netto: '0.00', status_woo: 'processing',
      oplacone_at: number === 1 ? null : godzinTemu(teraz, number, 10), anulowane: 0,
      utworzone_at: godzinTemu(teraz, number), uwagi: 'DEMO — wszystkie dane wygenerowane syntetycznie; bez integracji.',
      pozycje: [{ nazwa: `Produkt demonstracyjny ${number}`, sku: `DEMO-SKU-${code}`, ilosc: 1, cena_brutto: '24.60', cena_netto: '20.00', brutto_linii: '24.60', netto_linii: '20.00', vat: 23 }],
    }, { demo: true });
    if (number === 2) zapiszFaktyStatusu(db, id, { w_realizacji_at: godzinTemu(teraz, number, 20) });
  }
}
async function main() {
  const { katalog, port } = opcje(process.argv.slice(2));
  odmowNadpisania(katalog);
  fs.mkdirSync(katalog, { recursive: true });
  odmowNadpisania(katalog);
  etap('przygotuj', katalog, port);
  etap('proba', katalog, port);
  bezDowiazan(katalog);
  const backup = path.join(katalog, 'backup-demo.sqlite');
  const restore = path.join(katalog, 'odtworzenie-demo');
  if (fs.existsSync(backup) || fs.existsSync(restore)) throw Error('INSTALACJA_ODMOWA_NADPISANIA');
  const { DatabaseSync } = await import('node:sqlite');
  const database = path.join(katalog, PLIKI_INSTALACJI.baza);
  const stat = fs.lstatSync(database);
  if (!stat.isFile() || stat.isSymbolicLink()
    || fs.realpathSync(database).toLowerCase() !== path.resolve(database).toLowerCase()) {
    throw Error('INSTALACJA_DEMO_SCIEZKA_ODMOWA');
  }
  const db = new DatabaseSync(database);
  try {
    await wygeneruj(db);
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('INSTALACJA_DEMO_INTEGRITY_ODMOWA');
    db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
  } finally { db.close(); }
  fs.mkdirSync(restore);
  fs.copyFileSync(backup, path.join(restore, PLIKI_INSTALACJI.baza), fs.constants.COPYFILE_EXCL);
  for (const file of [backup, path.join(restore, PLIKI_INSTALACJI.baza)]) {
    const copy = new DatabaseSync(file, { readOnly: true });
    try { if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('INSTALACJA_DEMO_INTEGRITY_ODMOWA'); }
    finally { copy.close(); }
  }
  console.log(JSON.stringify({ status: 'demo-zakonczone', katalog, port, kopiaDemo: backup, odtworzenieDemo: restore, dane: '3 zamówienia syntetyczne; integracje niepodłączone' }));
}
main().catch(error => {
  console.error(error instanceof Error && /^INSTALACJA_/.test(error.message) ? error.message : 'INSTALACJA_DEMO_ODMOWA');
  process.exitCode = 1;
});
