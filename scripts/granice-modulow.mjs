import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';

const rozszerzenia = ['.js', '.ts', '.mjs', '.cjs'];
const celeCore = new Set(['moduly', 'oms', 'integracje']);

function plikiZrodlowe(katalog) {
  return readdirSync(katalog, { withFileTypes: true }).flatMap((wpis) => {
    const plik = path.join(katalog, wpis.name);
    if (wpis.isDirectory()) return plikiZrodlowe(plik);
    return rozszerzenia.includes(path.extname(plik)) ? [plik] : [];
  });
}

function rozwiaz(plik, specyfikator) {
  if (!specyfikator.startsWith('.')) return undefined;
  const cel = path.resolve(path.dirname(plik), specyfikator);
  const kandydaci = [
    cel,
    ...rozszerzenia.map((ext) => cel + ext),
    ...rozszerzenia.map((ext) => path.join(cel, 'index' + ext)),
  ];
  if (cel.endsWith('.js')) kandydaci.push(cel.slice(0, -3) + '.ts');
  return kandydaci.find((kandydat) => statSync(kandydat, { throwIfNoEntry: false })?.isFile());
}

function warstwa(plik) {
  return plik.includes('/') ? plik.split('/')[0] : 'root';
}

function modul(plik) {
  const [katalog, nazwa, podsciezka] = plik.split('/');
  return katalog === 'moduly' && podsciezka ? nazwa : undefined;
}

function odczytajImport(wezel) {
  if (ts.isImportDeclaration(wezel)) {
    return [wezel.moduleSpecifier, wezel.importClause?.isTypeOnly === true];
  }
  if (ts.isExportDeclaration(wezel)) {
    return [wezel.moduleSpecifier, wezel.isTypeOnly];
  }
  // `import('x').T` w typie i w JSDoc plików .js to zależność typowa, tak jak `import type`.
  if (ts.isImportTypeNode(wezel) && ts.isLiteralTypeNode(wezel.argument)) {
    return [wezel.argument.literal, true];
  }
  if (ts.isCallExpression(wezel)) {
    const wywolanie = wezel.expression;
    if (
      wywolanie.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(wywolanie) && wywolanie.text === 'require')
    ) {
      return [wezel.arguments[0], false];
    }
  }
  return [];
}

function nazwyZaleznosci(wezel) {
  if (ts.isStringLiteralLike(wezel)) return [wezel.text];
  if (ts.isArrayLiteralExpression(wezel)) return wezel.elements.flatMap(nazwyZaleznosci);
  if (ts.isSpreadElement(wezel) || ts.isParenthesizedExpression(wezel)) {
    return nazwyZaleznosci(wezel.expression);
  }
  if (ts.isConditionalExpression(wezel)) {
    return [...nazwyZaleznosci(wezel.whenTrue), ...nazwyZaleznosci(wezel.whenFalse)];
  }
  return [];
}

function odczytajSrc(repo) {
  const src = path.resolve(repo, 'src');
  const pelneSciezki = plikiZrodlowe(src).sort();
  const wzgledna = (plik) => path.relative(src, plik).split(path.sep).join('/');
  const pliki = pelneSciezki.map(wzgledna);
  // Graf zachowuje osobne wystąpienia importów, także gdy prowadzą do tego samego pliku.
  /** @type {[string, string, boolean][]} */
  const edges = [];
  /** @type {Map<string, Set<string>>} */
  const wymaga = new Map();
  for (const plik of pelneSciezki) {
    const z = wzgledna(plik);
    const nazwa = modul(z);
    const czyModul = nazwa && z === `moduly/${nazwa}/modul.ts`;
    const drzewo = ts.createSourceFile(plik, readFileSync(plik, 'utf8'), ts.ScriptTarget.Latest);
    function przejdz(wezel) {
      const [specyfikator, typ] = odczytajImport(wezel);
      if (specyfikator && ts.isStringLiteralLike(specyfikator)) {
        const cel = rozwiaz(plik, specyfikator.text);
        if (cel?.startsWith(src + path.sep)) edges.push([z, wzgledna(cel), typ]);
      }
      if (
        czyModul &&
        ts.isPropertyAssignment(wezel) &&
        (ts.isIdentifier(wezel.name) || ts.isStringLiteralLike(wezel.name)) &&
        wezel.name.text === 'wymaga'
      ) {
        wymaga.set(nazwa, new Set(nazwyZaleznosci(wezel.initializer)));
      }
      for (const komentarz of wezel.jsDoc ?? []) ts.forEachChild(komentarz, przejdz);
      ts.forEachChild(wezel, przejdz);
    }
    przejdz(drzewo);
  }
  return { graf: { pliki, edges }, wymaga };
}

function znajdzCykle({ pliki, edges }) {
  const sasiedzi = new Map(pliki.map((plik) => [plik, []]));
  for (const [z, doPliku, typ] of edges) {
    if (!typ) sasiedzi.get(z).push(doPliku);
  }
  const indeks = new Map();
  const niski = new Map();
  const stos = [];
  const naStosie = new Set();
  const cykle = [];
  function odwiedz(plik) {
    indeks.set(plik, indeks.size);
    niski.set(plik, indeks.get(plik));
    stos.push(plik);
    naStosie.add(plik);
    for (const sasiad of sasiedzi.get(plik) ?? []) {
      if (!indeks.has(sasiad)) {
        odwiedz(sasiad);
        niski.set(plik, Math.min(niski.get(plik), niski.get(sasiad)));
      } else if (naStosie.has(sasiad)) {
        niski.set(plik, Math.min(niski.get(plik), indeks.get(sasiad)));
      }
    }
    if (niski.get(plik) !== indeks.get(plik)) return;
    const skladowa = [];
    let ostatni;
    do {
      ostatni = stos.pop();
      naStosie.delete(ostatni);
      skladowa.push(ostatni);
    } while (ostatni !== plik);
    if (skladowa.length > 1) cykle.push(skladowa.sort());
  }
  for (const plik of pliki) {
    if (!indeks.has(plik)) odwiedz(plik);
  }
  return cykle.sort();
}

export function zbadajGranice(repo) {
  const { graf, wymaga } = odczytajSrc(repo);
  /** @type {Map<string, {podPrad: boolean, krawedzie: Set<string>}>} */
  const poza = new Map();
  /** @type {Map<string, Set<string>>} */
  const kierunki = new Map();
  const podPradWarstw = {
    'core -> moduly|oms|integracje': [],
    'oms -> moduly': [],
    'domena -> poza domena': [],
  };
  for (const [z, doPliku, typ] of graf.edges) {
    const krawedz = `${z} -> ${doPliku}`;
    const warstwaZ = warstwa(z);
    const warstwaDo = warstwa(doPliku);
    if (warstwaZ === 'core' && celeCore.has(warstwaDo)) {
      podPradWarstw['core -> moduly|oms|integracje'].push(krawedz);
    }
    if (warstwaZ === 'oms' && warstwaDo === 'moduly') {
      podPradWarstw['oms -> moduly'].push(krawedz);
    }
    if (warstwaZ === 'domena' && warstwaDo !== 'domena') {
      podPradWarstw['domena -> poza domena'].push(krawedz);
    }
    const A = modul(z);
    const B = modul(doPliku);
    if (!A || !B || A === B) continue;
    const kierunek = `${A} -> ${B}`;
    if (!kierunki.has(kierunek)) kierunki.set(kierunek, new Set());
    kierunki.get(kierunek).add(krawedz);
    if (wymaga.get(A)?.has(B)) continue;
    const para = kierunek + (typ ? ' (typ)' : '');
    if (!poza.has(para)) {
      poza.set(para, { podPrad: wymaga.get(B)?.has(A) ?? false, krawedzie: new Set() });
    }
    poza.get(para).krawedzie.add(krawedz);
  }
  for (const lista of Object.values(podPradWarstw)) lista.sort();
  // Limit pary modułów liczy unikalne połączenia plików w danym rodzaju importu.
  const pozaWymaga = Object.fromEntries(
    [...poza.keys()].sort().map((para) => {
      const { podPrad, krawedzie } = poza.get(para);
      return [para, { liczba: krawedzie.size, podPrad, krawedzie: [...krawedzie].sort() }];
    }),
  );
  /** @type {Record<string, string[]>} */
  const wzajemne = {};
  for (const kierunek of [...kierunki.keys()].sort()) {
    const [A, B] = kierunek.split(' -> ');
    const odwrotny = kierunki.get(`${B} -> ${A}`);
    if (A < B && odwrotny) {
      wzajemne[`${A} <-> ${B}`] = [...kierunki.get(kierunek), ...odwrotny].sort();
    }
  }
  return { pozaWymaga, wzajemne, podPradWarstw, cykle: znajdzCykle(graf) };
}

function zapiszJson(dane, wyjscie) {
  const tekst = JSON.stringify(dane, null, 2) + '\n';
  if (wyjscie) writeFileSync(wyjscie, tekst);
  else process.stdout.write(tekst);
}

function uruchom() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      graf: { type: 'string' },
      wyjscie: { type: 'string' },
      'zapisz-wyjatki': { type: 'boolean' },
    },
  });
  const repo = values.graf ?? positionals[0] ?? '.';
  if (values.graf) {
    zapiszJson(odczytajSrc(repo).graf, values.wyjscie);
    return;
  }
  const raport = zbadajGranice(repo);
  const { pozaWymaga, wzajemne, podPradWarstw, cykle } = raport;
  if (values['zapisz-wyjatki']) {
    zapiszJson(
      {
        pozaWymaga: Object.fromEntries(Object.entries(pozaWymaga).map(([para, dane]) => [para, dane.liczba])),
        wzajemne: Object.keys(wzajemne),
        podPradWarstw: Object.fromEntries(
          Object.entries(podPradWarstw).map(([warstwy, lista]) => {
            const limity = {};
            for (const krawedz of lista) limity[krawedz] = (limity[krawedz] ?? 0) + 1;
            return [warstwy, limity];
          }),
        ),
        cykle,
      },
      values.wyjscie ?? path.resolve(repo, 'tests/core/granice-modulow-wyjatki.json'),
    );
  } else if (values.json) {
    zapiszJson(raport, values.wyjscie);
  } else {
    const pary = Object.values(pozaWymaga);
    const liczba = pary.reduce((suma, para) => suma + para.liczba, 0);
    console.log(
      `Poza wymaga: ${pary.length} par / ${liczba} krawędzi, ${pary.filter((para) => para.podPrad).length} par pod prąd`,
    );
    console.log(`Pary wzajemne modułów: ${Object.keys(wzajemne).length}`);
    console.log(`Cykle plików: ${cykle.length}`);
    for (const [warstwy, lista] of Object.entries(podPradWarstw)) console.log(`${warstwy}: ${lista.length}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) uruchom();
