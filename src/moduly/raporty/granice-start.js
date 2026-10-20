import { wczytajRaporty } from './konfiguracja.ts';
import { inicjalizujGraniceBezHistorii, pierwszeDniOms } from '../../domena/sprzedaz-okresu.js';
import { granice } from '../../oms/db/historia-sprzedazy.js';

const dzien = (d) => d.toISOString().slice(0, 10);
const dzienPrzed = (rrrrmmdd) => dzien(new Date(Date.parse(`${rrrrmmdd}T00:00:00Z`) - 86_400_000));
const DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Skąd przychodzą zamówienia kanału raportowego. Kanał klienta — z własnej definicji; INDYWIDUALNE —
 * z każdego sklepu Woo (znacznik liczony z surowego zamówienia sklepu, z datą sklepu); RECZNE, B2B,
 * DROPSHIPPING i kanał tagu klienta (tagGdd) — z panelu, z datą chwili założenia (dziś > wczoraj), więc bez źródeł.
 */
function zrodlaKanalu(kanal, zrodla) {
  if (kanal === 'INDYWIDUALNE') return zrodla.filter(z => z.typ === 'woo');
  return zrodla.filter(z => z.raport === kanal);
}

/**
 * Wczoraj albo dzień przed najwcześniejszym OD źródeł; kanały z historią wymagają pomiaru.
 * `automat` — PRZ-102.14: granicę przy starcie wolno założyć tylko, gdy KAŻDE źródło kanału ma poprawne
 * `<P>_OD` i komplet kluczy (brakujaceKluczeKanalu — reguła „kanał skonfigurowany” z /health). Bez OD
 * sklep pobiera całą historię, a niepełny kanał — od daty, której jeszcze nie znamy; granica „wczoraj”
 * przed pierwszym pobraniem cicho wycięłaby te zamówienia z raportu.
 */
export function planGranicDlaRaportow(config, teraz = new Date()) {
  const { klasyfikacja } = config.regulySprzedazy;
  const historyczne = new Set(klasyfikacja.konta.values());
  const wczoraj = dzienPrzed(dzien(teraz));
  const plan = [];
  const pominiete = [];
  for (const kanal of [...klasyfikacja.raporty].sort()) {
    if (historyczne.has(kanal)) { pominiete.push(kanal); continue; }
    const zrodla = zrodlaKanalu(kanal, config.zrodlaKanalow);
    let doDnia = wczoraj;
    const braki = [];
    for (const z of zrodla) {
      const odPoprawne = DATA.test(z.od);
      if (odPoprawne && dzienPrzed(z.od) < doDnia) doDnia = dzienPrzed(z.od);
      const klucze = z.braki.filter(n => n !== `${z.prefiks}_OD`);
      if (!odPoprawne) braki.push(`brak ${z.prefiks}_OD`);
      if (klucze.length) braki.push(`niepełna konfiguracja (brak ${klucze.join(', ')})`);
    }
    plan.push({ kanal, doDnia, automat: !braki.length, powod: braki.join(', ') });
  }
  return { plan, pominiete, klasyfikacja };
}

export function planGranic(env, teraz = new Date()) {
  return planGranicDlaRaportow(wczytajRaporty(env), teraz);
}

/**
 * Automat startu panelu. Istniejące granice zostają; kanał bez OD albo z niepełną konfiguracją
 * nie dostaje zapisu, tylko linię w logu. Odmowa jednego kanału nie zatrzymuje pozostałych.
 * @param {(tekst: string) => void} log
 */
export function zalozGraniceDlaRaportow(db, config, teraz = new Date(), log = () => {}) {
  const { plan, pominiete, klasyfikacja } = planGranicDlaRaportow(config, teraz);
  const istniejace = granice(db);
  const zalozone = [];
  const doRecznego = [];
  const odmowy = [];
  for (const { kanal, doDnia, automat, powod } of plan) {
    if (istniejace.has(kanal)) continue;
    if (!automat) {
      doRecznego.push(kanal);
      log(`raporty: kanał ${kanal}: granica do założenia ręcznie (\`--granice\`) po pierwszym pobraniu zamówień — ${powod}`);
      continue;
    }
    try { inicjalizujGraniceBezHistorii(db, kanal, doDnia, klasyfikacja); }
    catch (e) {
      odmowy.push(kanal);
      log(`raporty: granice raportów — nie udało się założyć ${kanal}=${doDnia}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    zalozone.push(`${kanal}=${doDnia}`);
    log(`raporty: granice raportów — założono ${kanal}=${doDnia}`);
  }
  return { zalozone, pominiete, doRecznego, odmowy };
}

/**
 * Ręczne `--granice` (operator, po pierwszym pobraniu zamówień): każdy kanał bez granicy, także bez OD.
 * Dzień jak w automacie, ale nie później niż dzień przed najwcześniejszym zamówieniem OMS kanału —
 * sklep bez OD ma już w bazie zamówienia sprzed „wczoraj”. Odmowa przerywa (skrypt kończy się błędem).
 */
export function zalozGranice(db, env, teraz = new Date()) {
  const { plan, pominiete, klasyfikacja } = planGranic(env, teraz);
  const istniejace = granice(db);
  const brakujace = plan.filter(p => !istniejace.has(p.kanal));
  const zPlanu = new Map(brakujace.map(p => [p.kanal, p.doDnia]));
  const pierwsze = brakujace.length ? pierwszeDniOms(db, klasyfikacja, kanal => zPlanu.get(kanal) ?? null) : new Map();
  const zalozone = [];
  for (const { kanal, doDnia: planowany } of brakujace) {
    const pierwszy = pierwsze.get(kanal);
    const doDnia = pierwszy && dzienPrzed(pierwszy) < planowany ? dzienPrzed(pierwszy) : planowany;
    try { inicjalizujGraniceBezHistorii(db, kanal, doDnia, klasyfikacja); }
    catch (e) { throw new Error(`PRODUKCJA_GRANICA_ODMOWA ${kanal} ${doDnia}: ${e instanceof Error ? e.message : e}`); }
    zalozone.push(`${kanal}=${doDnia}`);
  }
  return { zalozone, pominiete };
}
