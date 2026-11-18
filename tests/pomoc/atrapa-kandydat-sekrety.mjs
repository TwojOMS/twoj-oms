// Atrapa startu kandydata z szyfrowaniem poświadczeń dla tests/instalacja/atrapa-dockera.mjs:
// klucz z pliku klucz.env (u klienta compose podaje go jako env_file), konwersja bazy tym samym kodem co start OMS-u.
// Brak albo zły plik klucza, odmowa konwersji = kod 1 (OMS nie wstaje).
//   node atrapa-kandydat-sekrety.mjs <baza.sqlite> <klucz.env>
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { kluczZPliku } from '../../scripts/sekrety.mjs';
import { utworzSejf } from '../../src/core/bezpieczenstwo/sejf-sekretow.js';
import { konwertujSekrety } from '../../src/core/bezpieczenstwo/konwersja-sekretow.js';

const [baza, plikKlucza] = process.argv.slice(2);
const bajty = fs.existsSync(plikKlucza) ? kluczZPliku(plikKlucza) : null;
if (!bajty) {
  console.error('atrapa kandydata: brak klucza poświadczeń');
  process.exit(1);
}
const db = new DatabaseSync(baza);
try {
  konwertujSekrety(db, utworzSejf(bajty));
} catch (e) {
  console.error(`atrapa kandydata: ${e.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
