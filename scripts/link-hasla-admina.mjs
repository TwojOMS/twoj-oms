#!/usr/bin/env node
// Odzyskanie dostępu przez właściciela serwera. Bez migracji, zmiany hasła i wysyłki poczty.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { kontoPoLoginie, dopiszLogowanie } from '../src/core/bezpieczenstwo/konta.js';
import { wydajLink } from '../src/moduly/ustawienia/linki-hasla.js';
import { adresPaneluZEnv, adresPaneluZZapisu } from '../src/moduly/ustawienia/adres-panelu.ts';
import { wczytajKonfiguracjeIntegracji } from '../src/oms/db/konfiguracja-integracji.js';

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1) throw new Error('Użycie: node scripts/link-hasla-admina.mjs [LOGIN]');
  const plik = process.env.OMS_DB_PATH;
  if (!plik || !existsSync(plik)) throw new Error('Brak istniejącej bazy OMS — sprawdź OMS_DB_PATH w kontenerze.');
  const db = new DatabaseSync(plik, { timeout: 10_000 });
  try {
    if (args.length === 0) {
      const admini = db.prepare('SELECT login FROM konta WHERE admin = 1 AND czynne = 1 ORDER BY login').all();
      // PRZ-109.12 (recenzja): lista tylko kont, dla których link da się wydać; pusta lista to odmowa, nie cisza.
      if (!admini.length) throw new Error('Brak włączonych kont administratora — link nie ma komu wydać.');
      for (const konto of admini) {
        process.stdout.write(`${konto.login}\n`);
      }
      return;
    }
    const konto = kontoPoLoginie(db, args[0]);
    if (!konto) throw new Error('Nie ma takiego konta.');
    if (!konto.czynne) throw new Error('Konto jest wyłączone — nie można wydać linku.');
    if (!konto.admin) throw new Error('Konto nie jest administratorem — użyj panelu do zarządzania kontami.');
    const adres = adresPaneluZEnv(process.env.OMS_ADRES_PANELU)
      ?? adresPaneluZZapisu(wczytajKonfiguracjeIntegracji(db, 'adres_panelu'));
    // Cel jak przy „Pokaż link” w panelu (trasy/konta.js): konto zaproszone (bez zapisu scrypt) dostaje zaproszenie.
    const zaproszone = !String(db.prepare('SELECT hash_hasla FROM konta WHERE id = ?').get(konto.id)?.hash_hasla ?? '').startsWith('scrypt$');
    const { token } = wydajLink(db, { kontoId: konto.id, cel: zaproszone ? 'zaproszenie' : 'reset', teraz: () => new Date(), zastapPoprzednie: true });
    // Ten sam dziennik co ustawienie hasła z linku. Bez tokenu; operator nie jest kontem panelu.
    dopiszLogowanie(db, { login: konto.login, usluga: 'oms', ip: 'konsola serwera', wynik: 'link-hasla-z-konsoli' });
    process.stderr.write('Link jest jednorazowy, ważny 48 godzin. Poprzednie linki tego konta są nieważne.\n');
    if (!adres) process.stderr.write('Ścieżkę poniżej doklej do adresu panelu.\n');
    process.stdout.write(`${adres ?? ''}/haslo/${token}\n`);
  } finally { db.close(); }
}

try { main(); }
catch (e) {
  // Tylko własne komunikaty i walidacja adresu; błędy SQLite mogą zawierać dane z bazy.
  const komunikat = e instanceof Error && (e.message.startsWith('OMS_ADRES_PANELU:')
    || /^(Użycie:|Brak istniejącej bazy|Brak włączonych kont|Nie ma takiego konta|Konto )/.test(e.message))
    ? e.message : 'Nie udało się wydać linku — sprawdź dostęp do bazy i wersję OMS.';
  process.stderr.write(`${komunikat}\n`);
  process.exitCode = 1;
}
