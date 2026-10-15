#!/usr/bin/env node
// Nocna kopia bazy panelu. Uruchamiana przez kontener-satelite (deploy/nas/backup-loop.sh).
// VACUUM INTO daje spojny plik przy dzialajacej usludze - inaczej niz `cp`, ktore
// w trybie WAL kopiuje niemal pusta baze (ta pomylka wyprodukowala juz piec
// bezwartosciowych kopii tej bazy).
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { wybierzDoSkasowania } from './backup-rotation.mjs';

const DB_PATH = process.env.DB_PATH || '/data/panel.sqlite';
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/data/uploads';
const BACKUP_DIR = process.env.BACKUP_DIR || '/backups';
const KEEP = Number(process.env.BACKUP_KEEP || 14);
// Kopie robia dwie uslugi (panel indywidualny, OMS) do dwoch katalogow. Prefiks jest
// tym, po czym rotacja poznaje SWOJE pliki - patrz backup-rotation.mjs.
const PREFIKS = process.env.BACKUP_PREFIX || 'panel';

const dzien = new Date().toISOString().slice(0, 10);
const cel = path.join(BACKUP_DIR, `${PREFIKS}-${dzien}.sqlite`);

fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (fs.existsSync(cel)) fs.rmSync(cel);

// BACKUP_DIR musi byc wolumenem LOKALNYM. Proba zapisu kopii na udzial SMB
// konczy sie "database is locked" - SQLite nie zrobi tam swojego blokowania.
// (Zweryfikowane 2026-07-29: ten sam VACUUM INTO na /tmp przechodzi, na CIFS pada.)
const db = new DatabaseSync(DB_PATH);
// Panel pisze do bazy w tle. Bez busy_timeout kopia przegrywa wyscig i pada od razu.
db.exec('PRAGMA busy_timeout=20000');
db.exec(`VACUUM INTO '${cel.replace(/'/g, "''")}'`);
db.close();

const rozmiar = fs.statSync(cel).size;
if (rozmiar < 1024) {
  throw new Error(`kopia ${cel} ma ${rozmiar} B - to nie jest zdrowa baza`);
}

// Pliki obok bazy raz w tygodniu (niedziela) - zalaczniki panelu albo etykiety OMS-u;
// zmieniaja sie rzadko. Nazwa archiwum idzie z nazwy katalogu, zeby przy dwoch uslugach
// piszacych do wlasnych katalogow nie powstaly dwa rozne archiwa o tej samej nazwie.
if (new Date().getUTCDay() === 0 && fs.existsSync(UPLOAD_DIR)) {
  const czego = path.basename(UPLOAD_DIR);
  const arch = path.join(BACKUP_DIR, `${czego}-${dzien}.tgz`);
  execFileSync('tar', ['czf', arch, '-C', path.dirname(UPLOAD_DIR), czego]);
  console.log(`${czego} -> ${arch}`);
}

const doKasacji = wybierzDoSkasowania(fs.readdirSync(BACKUP_DIR), KEEP, PREFIKS);
for (const n of doKasacji) fs.rmSync(path.join(BACKUP_DIR, n));

console.log(`kopia ${cel} (${rozmiar} B), skasowano ${doKasacji.length} starych`);
