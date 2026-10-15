// PRZ-083: cykl resetu demo publicznego w JEDNYM procesie. Do PRZ-083 reset kończył proces i czekał na restart
// kontenera (46 s przerwy, pomiar 15.10). Teraz:
//   1. `wyprzedzenieMs` przed terminem — następna baza w procesie potomnym (baza.mjs → nastepna.mjs), panel działa dalej;
//   2. w terminie — bezpiecznik izolacji (jak przy starcie kontenera), zamknięcie aplikacji, podmiana plików, nowa
//      aplikacja z następnym terminem w DEMO_RESET_PLANOWY (pasek demo liczy do niego i po nim poznaje nową instancję);
//   3. następna baza nie powstała (albo nie zdążyła w `czekajMaxMs` po terminie) — stary tor: skasuj bazę, wyjdź 0,
//      restart kontenera wygeneruje ją w start.mjs. Spóźniony generator = kilka sekund starych danych więcej, nie przerwa.
// Wszystkie skutki uboczne wstrzykiwane — test (tests/instalacja/demo-reset-prz083.test.js) gra cykl na atrapach
// i na prawdziwym panelu.

/** Dzień danych demo = dzień TERMINU resetu w Warszawie (reset o północy przygotowuje się jeszcze „wczoraj”). */
export function dzienResetu(termin) {
  return termin.toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
}

const PRZYGOTUJ_PRZED_MS = 5 * 60_000;
const CZEKAJ_NA_GENERATOR_MS = 3 * 60_000;

export function cyklResetu({
  env, msDo, uruchom, przygotuj, sprawdzIzolacje, podmien, usunBaze, wyjdz,
  log = console.log, teraz = () => new Date(), wyprzedzenieMs = PRZYGOTUJ_PRZED_MS, czekajMaxMs = CZEKAJ_NA_GENERATOR_MS,
}) {
  let aplikacja = null;
  let termin = null;
  let przygotowanie = null;
  let zegary = [];
  let zatrzymany = false;

  const wyczyscZegary = () => { for (const z of zegary) clearTimeout(z); zegary = []; };
  const zaplanuj = (fn, ms) => { zegary.push(setTimeout(() => { void fn(); }, Math.max(0, ms))); };

  const przygotujRaz = () => {
    przygotowanie ??= Promise.resolve().then(() => przygotuj(dzienResetu(termin))).catch((e) => {
      log(`demo: przygotowanie następnej bazy padło — ${e?.message ?? e}`);
      return false;
    });
    return przygotowanie;
  };

  async function start() {
    const za = msDo(teraz());
    termin = new Date(teraz().getTime() + za);
    przygotowanie = null;
    env.DEMO_RESET_PLANOWY = termin.toISOString();
    aplikacja = await uruchom(env);
    log(`demo: najbliższy reset ${termin.toISOString()} (za ${Math.round(za / 1000)} s), następna baza ${Math.round(Math.max(0, za - wyprzedzenieMs) / 1000)} s przed nim`);
    zaplanuj(przygotujRaz, za - wyprzedzenieMs);
    zaplanuj(reset, za);
  }

  async function reset() {
    if (zatrzymany) return;
    wyczyscZegary();
    const t0 = Date.now();
    const limit = new Promise((r) => { zegary.push(setTimeout(() => r('limit'), czekajMaxMs)); });
    const gotowa = await Promise.race([przygotujRaz(), limit]);
    if (zatrzymany) return;
    if (gotowa !== true) {
      log(`demo: reset ${new Date().toISOString()} bez następnej bazy (${gotowa === 'limit' ? 'generator nie zdążył' : 'generator padł'}) — kasuję bazę, kontener wstanie od nowa`);
      await zamknij();
      usunBaze();
      wyjdz(0);
      return;
    }
    try {
      await sprawdzIzolacje();
    } catch (e) {
      log(`demo: bezpiecznik izolacji przed podmianą — ${e?.message ?? e}`);
      await zamknij();
      wyjdz(1);
      return;
    }
    const dzis = dzienResetu(termin);
    const tZamkniecia = Date.now();
    await zamknij();
    try {
      podmien(dzis);
      await start();
    } catch (e) {
      // Kontener wstanie od nowa: start.mjs weźmie bazę, która leży (nową albo — gdy podmiana odmówiła — starą).
      log(`demo: podmiana albo start po niej padły — ${e?.stack ?? e}`);
      await zamknij().catch(() => {});
      wyjdz(1);
      return;
    }
    log(`demo: reset ${new Date().toISOString()} — dane na ${dzis}, panel niedostępny ${Date.now() - tZamkniecia} ms (czekanie na generator ${tZamkniecia - t0} ms)`);
  }

  async function zamknij() {
    const a = aplikacja;
    aplikacja = null;
    await a?.zamknij();
  }

  return {
    start,
    zamknij,
    zatrzymaj: () => { zatrzymany = true; wyczyscZegary(); },
    termin: () => termin,
  };
}
