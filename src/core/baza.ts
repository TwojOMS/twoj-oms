import type { DatabaseSync as BazaSqlite } from 'node:sqlite';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ModulOms } from './kontrakty.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type WynikMigracji = { modul: string; numer: number; nazwa: string; tryb: 'wykonana' | 'oznaczona' };

export function otworzBaze(sciezka: string): BazaSqlite {
  if (sciezka !== ':memory:') mkdirSync(dirname(sciezka), { recursive: true });
  const db = new DatabaseSync(sciezka);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 20000');
  db.exec(`CREATE TABLE IF NOT EXISTS migracje (
    modul TEXT NOT NULL, numer INTEGER NOT NULL, nazwa TEXT NOT NULL, zastosowana_at TEXT NOT NULL,
    PRIMARY KEY (modul, numer))`);
  return db;
}

export function wykonajMigracje(db: BazaSqlite, moduly: readonly ModulOms[], teraz: () => Date = () => new Date()): WynikMigracji[] {
  const byla = db.prepare('SELECT 1 FROM migracje WHERE modul = ? AND numer = ?');
  const zapisz = db.prepare('INSERT INTO migracje (modul, numer, nazwa, zastosowana_at) VALUES (?, ?, ?, ?)');
  const wynik: WynikMigracji[] = [];
  for (const m of moduly) {
    for (const mig of [...m.migracje].sort((a, b) => a.numer - b.numer)) {
      if (byla.get(m.nazwa, mig.numer)) continue;
      db.exec('BEGIN IMMEDIATE');
      let tryb: WynikMigracji['tryb'] = 'wykonana';
      try {
        const kontroluj = !(m.nazwa === 'rdzen' && mig.numer === 1);
        if (!kontroluj && kolumnyBazy(db).size) tryb = 'oznaczona';
        const przed = kontroluj ? schematBazy(db) : [];
        const kolumnyPrzed = kontroluj ? kolumnyBazy(db) : new Map<string, Kolumna[]>();
        const exec = db.exec;
        const prepare = db.prepare;
        const sprawdz = (sql: string) => {
          if (zakazaneInstrukcjeMigracji(sql).length) throw new Error('Migracja nieaddytywna: niedozwolona instrukcja SQL');
        };
        if (kontroluj) {
          db.exec = (sql) => { sprawdz(sql); return exec.call(db, sql); };
          db.prepare = (sql) => { sprawdz(sql); return prepare.call(db, sql); };
        }
        try { mig.wykonaj(db); }
        finally { db.exec = exec; db.prepare = prepare; }
        if (kontroluj) {
          const po = new Set(schematBazy(db));
          const usuniete = przed.filter((wpis) => !po.has(wpis));
          const wyzwalacze = db.prepare(`SELECT name, tbl_name, 'main' AS schemat FROM sqlite_master WHERE type = 'trigger'
            UNION ALL SELECT name, tbl_name, 'temp' AS schemat FROM sqlite_temp_master WHERE type = 'trigger'`).all() as { name: string; tbl_name: string; schemat: string }[];
          const noweOgraniczenia = [...po].filter((wpis) => !przed.includes(wpis) && (
            [...kolumnyPrzed.keys()].some((t) => wpis.startsWith(`${t} CHECK `) || wpis.startsWith(`${t} FK `)
              || (wpis.startsWith(`${t} indeks `) && wpis.includes(' u=1 ')))
            || wyzwalacze.some((w) => (w.tbl_name === 'migracje' || kolumnyPrzed.has(w.tbl_name))
              && wpis.startsWith(`${w.schemat === 'temp' ? 'temp ' : ''}trigger ${w.name} `))
          ));
          const bezDomyslnej: string[] = [];
          for (const [tabela, kolumny] of kolumnyBazy(db)) {
            const stare = kolumnyPrzed.get(tabela);
            if (!stare) continue;
            for (const k of kolumny) {
              if (!stare.some((s) => s.name === k.name) && k.notnull && k.dflt_value === null) {
                bezDomyslnej.push(`${tabela}.${k.name}`);
              }
            }
          }
          if (usuniete.length || bezDomyslnej.length || noweOgraniczenia.length) {
            throw new Error(`Migracja nieaddytywna. Usunięte lub zmienione: ${usuniete.join('; ') || '—'}; NOT NULL bez DEFAULT: ${bezDomyslnej.join('; ') || '—'}; nowe ograniczenia: ${noweOgraniczenia.join('; ') || '—'}`);
          }
        }
        zapisz.run(m.nazwa, mig.numer, mig.nazwa, teraz().toISOString());
        db.exec('COMMIT');
      } catch (e) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw new Error(`Migracja ${m.nazwa}/${mig.numer} „${mig.nazwa}" nie powiodła się: ${(e as Error).message}`);
      }
      wynik.push({ modul: m.nazwa, numer: mig.numer, nazwa: mig.nazwa, tryb });
    }
  }
  return wynik;
}

type Kolumna = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number };
type Indeks = { name: string; unique: number; origin: string; partial: number };
type KolumnaIndeksu = { seqno: number; name: string | null; desc: number; coll: string; key: number };
type KluczObcy = { id: number; seq: number; table: string; from: string; to: string | null; on_update: string; on_delete: string; match: string };
type TokenSql = { slowo: string; kanon: string; pozycja: number };

const cytuj = (nazwa: string): string => `"${nazwa.replaceAll('"', '""')}"`;
const TOKEN_SQL = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_][a-z_0-9$]*|(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[^\s]/gi;

function tokenySql(sql: string): TokenSql[] {
  return [...sql.matchAll(TOKEN_SQL)]
    .filter((m) => !m[0].startsWith('--') && !m[0].startsWith('/*'))
    .map((m) => {
      const t = m[0];
      const pozycja = m.index;
      if (t.startsWith("'")) return { slowo: '', kanon: `s:${t}`, pozycja };
      if (t.startsWith('"') || t.startsWith('`') || t.startsWith('[')) {
        const odkodowany = t.slice(1, -1).replaceAll(t[0] + t[0], t[0]);
        return { slowo: '', kanon: `i:${odkodowany.toUpperCase()}`, pozycja };
      }
      if (/^[a-z_]/i.test(t)) return { slowo: t.toUpperCase(), kanon: `i:${t.toUpperCase()}`, pozycja };
      return { slowo: '', kanon: t, pozycja };
    });
}

/** Wspólna kontrola plików SQL i instrukcji wykonywanych przez migracje. */
export function zakazaneInstrukcjeMigracji(sql: string): { pozycja: number; operacja: string }[] {
  const bledy: { pozycja: number; operacja: string }[] = [];
  let instrukcja: TokenSql[] = [];
  const sprawdz = () => {
    const slowa = instrukcja.map((t) => t.slowo);
    const alter = slowa[0] === 'ALTER' && slowa[1] === 'TABLE';
    const transakcja = ['BEGIN', 'COMMIT', 'ROLLBACK', 'END'].includes(slowa[0]);
    const writableSchema = slowa[0] === 'PRAGMA'
      && instrukcja.some((t) => t.kanon === 'i:WRITABLE_SCHEMA' || t.kanon.toUpperCase() === "S:'WRITABLE_SCHEMA'");
    if (transakcja || writableSchema) bledy.push({ pozycja: instrukcja[0].pozycja, operacja: slowa[0] });
    for (let i = 0; i < instrukcja.length; i++) {
      const usuwanie = slowa[i] === 'DROP' && (alter || ['TABLE', 'COLUMN', 'INDEX', 'VIEW', 'TRIGGER'].includes(slowa[i + 1]));
      const przemianowanie = slowa[i] === 'RENAME';
      const dodawanie = alter && slowa[i] === 'ADD';
      const bezDomyslnej = dodawanie && !slowa.slice(i + 1).includes('DEFAULT')
        && slowa.slice(i + 1).some((s, n, reszta) => s === 'NOT' && reszta[n + 1] === 'NULL');
      if (usuwanie || przemianowanie || bezDomyslnej) {
        bledy.push({ pozycja: instrukcja[i].pozycja, operacja: slowa[i] });
      }
    }
    instrukcja = [];
  };
  let poziomWyzwalacza = 0;
  for (const token of tokenySql(sql)) {
    if (instrukcja.some((t) => t.slowo === 'TRIGGER') && ['BEGIN', 'CASE'].includes(token.slowo)) poziomWyzwalacza++;
    if (token.slowo === 'END' && poziomWyzwalacza) poziomWyzwalacza--;
    if (token.kanon === ';' && !poziomWyzwalacza) sprawdz();
    else instrukcja.push(token);
  }
  sprawdz();
  return bledy;
}

function kanonSql(sql: string): string {
  const tokeny = tokenySql(sql);
  while (tokeny.at(-1)?.kanon === ';') tokeny.pop();
  return tokeny.map((t) => t.kanon).join(' ');
}

function wyrazenia(tokeny: TokenSql[], slowo: string): string[] {
  const wynik: string[] = [];
  for (let i = 0; i < tokeny.length - 1; i++) {
    if (tokeny[i].slowo !== slowo || tokeny[i + 1].kanon !== '(') continue;
    let poziom = 1;
    let j = i + 2;
    for (; j < tokeny.length && poziom; j++) {
      if (tokeny[j].kanon === '(') poziom++;
      if (tokeny[j].kanon === ')') poziom--;
    }
    wynik.push(tokeny.slice(i + 2, j - 1).map((t) => t.kanon).join(' '));
    i = j - 1;
  }
  return wynik.sort();
}

function deklaracjeKolumn(tokeny: TokenSql[]): Map<string, TokenSql[]> {
  const wynik = new Map<string, TokenSql[]>();
  let poziom = 1;
  let fragment: TokenSql[] = [];
  const zapisz = () => {
    if (fragment[0]?.kanon.startsWith('i:')
      && !['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'].includes(fragment[0].slowo)) {
      wynik.set(fragment[0].kanon.slice(2), fragment);
    }
    fragment = [];
  };
  for (let i = tokeny.findIndex((t) => t.kanon === '(') + 1; i < tokeny.length; i++) {
    const t = tokeny[i];
    if (t.kanon === '(') poziom++;
    if (t.kanon === ')') poziom--;
    if (!poziom) { zapisz(); break; }
    if (t.kanon === ',' && poziom === 1) zapisz();
    else fragment.push(t);
  }
  return wynik;
}

function kolumnyBazy(db: BazaSqlite): Map<string, Kolumna[]> {
  const tabele = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' AND name <> 'migracje' ORDER BY name`).all() as { name: string }[];
  return new Map(tabele.map(({ name }) => [name, db.prepare(`PRAGMA table_xinfo(${cytuj(name)})`).all() as Kolumna[]]));
}

/** Strukturalny odcisk kolumn, ograniczeń, indeksów, opcji tabel i pozostałych obiektów, także wyzwalaczy TEMP. Bez danych i tabeli migracje. */
export function schematBazy(db: BazaSqlite): string[] {
  const tabele = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%' AND name <> 'migracje' ORDER BY name`).all() as { name: string; sql: string }[];
  const opcje = db.prepare('PRAGMA table_list').all() as { schema: string; name: string; wr: number; strict: number }[];
  const odcisk: string[] = [];
  for (const { name: t, sql } of tabele) {
    const tokeny = tokenySql(sql);
    const deklaracje = deklaracjeKolumn(tokeny);
    const opcja = opcje.find((o) => o.schema === 'main' && o.name === t)!;
    odcisk.push(`${t} tabela wr=${opcja.wr} strict=${opcja.strict}`);
    for (const k of db.prepare(`PRAGMA table_xinfo(${cytuj(t)})`).all() as Kolumna[]) {
      const deklaracja = deklaracje.get(k.name.toUpperCase()) ?? [];
      const kolacja = deklaracja.findIndex((d) => d.slowo === 'COLLATE');
      const coll = kolacja < 0 ? 'i:BINARY' : deklaracja[kolacja + 1].kanon;
      const auto = deklaracja.some((d) => d.slowo === 'AUTOINCREMENT');
      odcisk.push(`${t}.${k.name} ${k.type} nn=${k.notnull} d=${k.dflt_value ?? ''} pk=${k.pk} h=${k.hidden} auto=${Number(auto)} coll=${coll} as=${wyrazenia(deklaracja, 'AS').join(';')}`);
    }
    for (const check of wyrazenia(tokeny, 'CHECK')) odcisk.push(`${t} CHECK ${check}`);
    const grupy = new Map<number, KluczObcy[]>();
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${cytuj(t)})`).all() as KluczObcy[]) {
      const grupa = grupy.get(fk.id) ?? [];
      grupa.push(fk);
      grupy.set(fk.id, grupa);
    }
    for (const grupa of grupy.values()) {
      const klucz = grupa.sort((a, b) => a.seq - b.seq).map(({ id, seq, ...reszta }) => reszta);
      odcisk.push(`${t} FK ${JSON.stringify(klucz)}`);
    }
    for (const i of db.prepare(`PRAGMA index_list(${cytuj(t)})`).all() as Indeks[]) {
      const kolumny = (db.prepare(`PRAGMA index_xinfo(${cytuj(i.name)})`).all() as KolumnaIndeksu[])
        .filter((k) => k.key).map(({ seqno, name, desc, coll }) => ({ seqno, name, desc, coll }));
      const definicja = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(i.name) as { sql: string | null } | undefined;
      const nazwa = i.origin === 'c' ? i.name : `auto:${i.origin}`;
      odcisk.push(`${t} indeks ${nazwa} u=${i.unique} partial=${i.partial} ${JSON.stringify(kolumny)} sql=${definicja?.sql ? kanonSql(definicja.sql) : ''}`);
    }
  }
  const pozostale = db.prepare(`SELECT type, name, sql, 'main' AS schemat FROM sqlite_master
    WHERE type IN ('view', 'trigger') AND name NOT LIKE 'sqlite_%'
    UNION ALL SELECT type, name, sql, 'temp' AS schemat FROM sqlite_temp_master
    WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%'`).all() as { type: string; name: string; sql: string; schemat: string }[];
  for (const obiekt of pozostale) odcisk.push(`${obiekt.schemat === 'temp' ? 'temp ' : ''}${obiekt.type} ${obiekt.name} ${kanonSql(obiekt.sql)}`);
  return odcisk.sort();
}
