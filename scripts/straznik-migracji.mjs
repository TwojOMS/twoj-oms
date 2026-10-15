import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zakazaneInstrukcjeMigracji } from '../src/core/baza.ts';
const bledy = [];
const katalogi = readdirSync('src/moduly', { withFileTypes: true }).filter((d) => d.isDirectory());
for (const d of katalogi) {
  const kat = join('src/moduly', d.name, 'migracje');
  let pliki = [];
  try { pliki = readdirSync(kat); } catch (e) {
    if (e.code === 'ENOENT') continue;
    throw e;
  }
  for (const p of pliki.filter((x) => /^\d{4}-/.test(x)
    && !(d.name === 'rdzen' && x === '0001-baseline.sql'))) {
    const sciezka = join(kat, p);
    const sql = readFileSync(sciezka, 'utf8');
    for (const blad of zakazaneInstrukcjeMigracji(sql)) {
      const linia = sql.slice(0, blad.pozycja).split('\n').length;
      bledy.push(`${sciezka}:${linia}: migracja nieaddytywna (${blad.operacja})`);
    }
  }
}
for (const b of bledy) console.log(b);
process.exit(bledy.length ? 1 : 0);
