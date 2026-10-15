import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { openOmsDb } from '../src/oms/db/db.ts';
import { polaczenia, zapiszPolaczenie } from '../src/oms/db/reklamy.js';
import { createMagazynSekretow } from '../src/moduly/marketing/uslugi/reklamy-sekrety.js';

export async function polaczReklamy({ db, magazyn, typ, kontoId, kanal, sekretPlik }) {
  if (!['ga4', 'meta'].includes(typ) || !kontoId || !kanal || !sekretPlik) {
    throw new Error('Podaj typ ga4/meta, konto, kanał i ścieżkę pliku sekretu.');
  }
  const tresc = await readFile(sekretPlik, 'utf8');
  if (typ === 'ga4') {
    let klucz;
    try { klucz = JSON.parse(tresc); } catch { throw new Error('Niepoprawny plik klucza GA4.'); }
    if (!klucz.client_email || !klucz.private_key) throw new Error('Plik nie jest kluczem konta usługowego GA4.');
  }
  const obecne = polaczenia(db).find((p) => p.typ === typ && p.kontoId === kontoId);
  const poprzedniId = obecne?.sekretRef?.startsWith(`${typ}:`)
    ? obecne.sekretRef.slice(typ.length + 1) : null;
  const sekretRef = await magazyn.zapisz({ typ, polaczenieId: poprzedniId ?? randomUUID(), tresc: tresc.trim() });
  if (obecne) {
    db.prepare('UPDATE reklamy_polaczenia SET kanal = ?, sekret_ref = ? WHERE id = ?')
      .run(kanal, sekretRef, obecne.id);
    return { id: obecne.id, stan: 'zaktualizowano' };
  }
  const p = zapiszPolaczenie(db, { typ, kontoId, kanal, sekretRef });
  return { id: p.id, stan: 'dodano' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pola = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const m = /^--(typ|konto|kanal|sekret-plik)=(.+)$/.exec(arg);
    if (!m) throw new Error('Oczekiwano --typ, --konto, --kanal i --sekret-plik.');
    return [m[1], m[2]];
  }));
  const db = openOmsDb(process.env.OMS_DB_PATH || '/data-oms/oms.sqlite');
  try {
    const magazyn = createMagazynSekretow({ katalog: process.env.OMS_REKLAMY_SEKRETY_DIR || '/data-oms/reklamy-sekrety' });
    const wynik = await polaczReklamy({ db, magazyn, typ: pola.typ, kontoId: pola.konto,
      kanal: pola.kanal, sekretPlik: pola['sekret-plik'] });
    process.stdout.write(`Połączenie #${wynik.id}: ${wynik.stan}.\n`);
  } finally {
    db.close();
  }
}
