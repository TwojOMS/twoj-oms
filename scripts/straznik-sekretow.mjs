// Strażnik poświadczeń w bazie: kolumny z sekretami (`sekrety_json`, `access_token`, `refresh_token`, `sekret_sesji`)
// w SQL-u i surowe `SELECT *` z tabel poświadczeń wolno pisać tylko w plikach z listy — reszta kodu idzie przez warstwy
// dostępu, które szyfrują zapis i odszyfrowują odczyt. `ustawSejfDomyslny` (sejf bez klucza z env) jest zakazany
// w src/, scripts/ i deploy/ poza definicją — ustawia go wyłącznie plik przygotowawczy testów.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOZWOLONE_SQL = {
  'src/oms/db/konfiguracja-integracji.js': 'warstwa dostępu sekrety_json',
  'src/oms/db/tokeny.js': 'warstwa dostępu tokeny_kanalu',
  'src/oms/ksef/sesja.js': 'warstwa dostępu tokeny_ksef',
  'src/core/bezpieczenstwo/sekret-sesji.js': 'warstwa dostępu sekret_sesji',
  'src/core/bezpieczenstwo/konwersja-sekretow.js': 'przegląd, konwersja i odszyfrowanie formatu',
  'src/oms/db/reset-demo.js': 'reset piaskownicy: import zachowanych wierszy (szyfrogram bajt w bajt, jawne szyfrowane)',
  'src/moduly/rdzen/migracje/0001-baseline.sql': 'schemat',
  'src/moduly/rdzen/migracje/0006-konfiguracja-integracji.ts': 'schemat',
  'scripts/sekrety.mjs': 'narzędzie poświadczeń (porzucenie, stan)',
};

const KOLUMNY = /\b(sekrety_json|access_token|refresh_token|sekret_sesji)\b/;
const SQL = /\b(SELECT|INSERT|UPDATE|DELETE|SET|FROM|WHERE|CREATE\s+TABLE|ALTER\s+TABLE)\b/;
const SUROWY_ODCZYT = /SELECT\s+(?:\w+\.)?\*\s+FROM\s+(tokeny_kanalu|tokeny_ksef|konfiguracja_integracji|sekret_sesji)\b/i;
// Zapytanie w literale `…` na wiele linii: nazwa kolumny i słowo SQL mogą leżeć w różnych liniach.
const LITERAL = /`[^`]*`/g;
const SEJF_DOMYSLNY = /\bustawSejfDomyslny\s*\(/;
const DEFINICJA_SEJFU = 'src/core/bezpieczenstwo/sejf-sekretow.js';

function pliki(katalog, wynik = []) {
  for (const w of fs.readdirSync(katalog, { withFileTypes: true })) {
    const p = path.join(katalog, w.name);
    if (w.isDirectory()) { if (w.name !== 'node_modules') pliki(p, wynik); }
    else if (/\.(m?js|ts|sql|sh|ejs)$/.test(w.name)) wynik.push(p);
  }
  return wynik;
}

export function naruszenia(korzen) {
  const wynik = [];
  for (const k of ['src', 'scripts', 'deploy']) {
    if (!fs.existsSync(path.join(korzen, k))) continue;
    for (const p of pliki(path.join(korzen, k))) {
      const wzgl = path.relative(korzen, p).split(path.sep).join('/');
      // Skrypty mutacji i sam strażnik mają te nazwy we wzorcach podmian.
      if (/^scripts\/(mutacje-|straznik-sekretow)/.test(wzgl)) continue;
      const tresc = fs.readFileSync(p, 'utf8');
      const linie = tresc.split(/\r?\n/);
      if (!DOZWOLONE_SQL[wzgl]) {
        for (const m of tresc.matchAll(LITERAL)) {
          if (!m[0].includes('\n') || !KOLUMNY.test(m[0]) || !SQL.test(m[0])) continue;
          wynik.push(`${wzgl}:${tresc.slice(0, m.index).split('\n').length}: SQL na kolumnie z poświadczeniami poza warstwą dostępu (zapytanie wieloliniowe)`);
        }
      }
      linie.forEach((l, i) => {
        if (!DOZWOLONE_SQL[wzgl] && ((KOLUMNY.test(l) && SQL.test(l)) || SUROWY_ODCZYT.test(l))) {
          wynik.push(`${wzgl}:${i + 1}: SQL na kolumnie z poświadczeniami poza warstwą dostępu`);
        }
        if (SEJF_DOMYSLNY.test(l) && !(wzgl === DEFINICJA_SEJFU && /export function ustawSejfDomyslny/.test(l))) {
          wynik.push(`${wzgl}:${i + 1}: ustawSejfDomyslny poza plikiem przygotowawczym testów`);
        }
      });
    }
  }
  return wynik;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const korzen = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const n = naruszenia(korzen);
  for (const x of n) console.error(x);
  console.log(`straznik-sekretow: ${n.length} naruszeń`);
  process.exitCode = n.length ? 1 : 0;
}
