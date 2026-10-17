// TRZY STANY POSTEPU — i to jest CALY mechanizm przeciw falszywej zieleni na tym ekranie.
//
// ⚠️⚠️ ZERO I „NIE WIEM" NIE MOGA WYGLADAC TAK SAMO. „0 / 5 produktow" znaczyloby naraz
// „nikt nic nie dodal" i „zrodlo stoi od szesciu dni". Na tej podstawie zapada rozmowa
// z czlowiekiem, wiec pomylka nie konczy sie na brzydkim kaflu.
//
// ⚠️ ETAP 1 NIE MA ZADNEGO AUTOMATU, wiec na produkcji widac WYLACZNIE stan `znany`.
// Stany `nieswiezy` i `nieznany` sa martwe az do Etapu 2 — i wlasnie dlatego maja komplet
// testow na sztucznym `pomiar`. Bez nich pierwszy refaktor „uprosci" dwie martwe galezie,
// a dowiemy sie o tym dopiero wtedy, gdy pierwszy prawdziwy automat zacznie klamac.
//
// CZYSTA FUNKCJA: zero bazy, zero rejestru, zero zegara systemowego. `teraz` przychodzi
// z zewnatrz, wiec test nie potrzebuje ani sztucznego zegara, ani stawiania serwera.

const GODZINA_MS = 3600 * 1000;

const NIEZNANY = (celIle) => ({
  stan: 'nieznany', ile: null, celIle, zrodloAt: null, procent: null, zrobione: null,
});

/**
 * @param {object} a
 * @param {number|null} a.celIle liczba docelowa; `null` = zadanie tak/nie
 * @param {{ile: number, zrodloAt: string|null}|null} a.pomiar wynik `services/cele-pomiar.js`
 * @param {number|null} a.progSwiezosciH prog z rejestru miernikow
 * @param {string} a.teraz ISO
 * @returns {{stan: 'znany'|'nieswiezy'|'nieznany', ile: number|null, celIle: number|null,
 *            zrodloAt: string|null, procent: number|null, zrobione: boolean|null}}
 */
export function postepCelu({ celIle, pomiar, progSwiezosciH, teraz }) {
  const celIleN = typeof celIle === 'number' ? celIle : null;

  // ⚠️ PIERWSZY WARUNEK, NIE OSTATNI. Gdyby brak pomiaru wpadal do galezi liczacej,
  // `pomiar?.ile ?? 0` dalby zero — czyli dokladnie to klamstwo, ktoremu ten modul zapobiega.
  if (!pomiar || typeof pomiar.ile !== 'number') return NIEZNANY(celIleN);

  // Miernik, ktory deklaruje prog swiezosci, ale nie oddaje znacznika zrodla, NIE UMIE
  // powiedziec, jak stara jest jego liczba. Nie da sie wtedy stwierdzic, czy jest swieza —
  // wiec nie udajemy, ze jest. To ZEPSUTY miernik, nie swiezy.
  if (progSwiezosciH !== null && pomiar.zrodloAt === null) return NIEZNANY(celIleN);

  let stan = 'znany';
  if (progSwiezosciH !== null) {
    const wiekH = (Date.parse(teraz) - Date.parse(pomiar.zrodloAt)) / GODZINA_MS;
    // Ostro wieksze: „dokladnie na progu" jest jeszcze swieze. Prog to granica, po ktorej
    // przestajemy ufac, a nie moment, w ktorym przestajemy.
    if (wiekH > progSwiezosciH) stan = 'nieswiezy';
  }

  return {
    stan,
    ile: pomiar.ile,
    celIle: celIleN,
    zrodloAt: pomiar.zrodloAt,
    // ⚠️ PRZYCINAMY WYLACZNIE PASEK, nie liczbe. „9 / 5" ma sie czytac jako nadwykonanie —
    // przyciecie `ile` do 5 skasowaloby informacje, ktora jest dobra wiadomoscia.
    procent: celIleN === null ? null : Math.min(100, Math.round((pomiar.ile / celIleN) * 100)),
    // Zadanie tak/nie. `null` dla licznika — licznik nie jest „zrobiony", tylko postepuje.
    zrobione: celIleN === null ? pomiar.ile > 0 : null,
  };
}
