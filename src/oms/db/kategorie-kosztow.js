import { bladOperatora } from '../../domena/bledy.js';
import { znormalizujNip } from '../../domena/gus.js';

// Kategoria kosztu dobierana PO NIP-IE sprzedawcy — nigdy po nazwie. KSeF przysyla nazwy
// w roznych wariantach zapisu, a NIP jest jeden (ta sama zasada, co w repo `raporty`).
//
// ⚠️ NIP NORMALIZUJE SIE PO OBU STRONACH — przy zapisie i przy odczycie (recenzja, D3).
// `nip` jest tu KLUCZEM GLOWNYM, wiec '525-267-47-98' i '5252674798' zalozylyby DWA wiersze
// dla jednego podatnika, a chybiony odczyt nie wyglada na rozjazd zapisu, tylko na „ten NIP
// nie ma jeszcze kategorii" — czyli na brak decyzji operatora, ktora dawno zapadla. TA SAMA
// funkcja, co przy GUS-ie (`znormalizujNip` w domain/gus.js), i to samo miejsce ma normalizowac
// `koszty.sprzedawca_nip` (domain/koszt-metadane.js) — inaczej zlaczenie po NIP-ie nie trafia.
//
// ⚠️ U4 (druga runda recenzji): `znormalizujNip` sam sobie nie waliduje dlugosci — sprzedawca
// zagraniczny (np. NIP unijny 'DE123456789') dostaje tu klucz '123456789', czyli napis
// WYGLADAJACY jak dziesieciocyfrowy polski NIP, ktorym nie jest. Ten klucz sluzy WYLACZNIE
// grupowaniu kosztow po sprzedawcy — ekran operatora nie ma prawa go czytac jako walidowany
// polski NIP (np. proponowac go do wyszukania w GUS-ie).
//
// ⚠️ TYP JEST WARTOSCIA MASZYNOWA, BEZ DIAKRYTYKOW: 'zmienny' | 'staly' | 'drobne' — pilnuje
// tego `CHECK` w schema.sql. NAZWA kategorii to co innego: czyta ja operator i ma pelna
// polszczyzne. Gdyby ten sam typ trafial do bazy raz jako 'stały', a raz jako 'staly',
// rozpadlby sie na dwie grupy przy liczeniu progu rentownosci — po cichu.

// Stan poczatkowy przeniesiony z raportu zarzadczego (repo `raporty`).
//
// ⚠️⚠️ WGRYWAMY PRZEZ `INSERT OR IGNORE`, bo ta migracja chodzi przy KAZDYM starcie
// kontenera: `INSERT OR REPLACE` cofalby wlascicielowi kazda jego zmiane kategorii przy
// najblizszym restarcie — po cichu i bez sladu, a restart zdarza sie przy kazdym wdrozeniu.
// To ta sama zasada, co przy `zapiszKoszt`: migracja idempotentna ma dokladac to, czego
// brakuje, i nie dotykac niczego wiecej.
const STARTOWE = [
];

// ⚠️⚠️ KATEGORIE, KTORE NIE MAJA JESZCZE ANI JEDNEGO DOSTAWCY — i to jest caly powod, dla
// ktorego slownik kategorii istnieje osobno od tabeli przypisan (patrz schema.sql).
//
// Lista wyboru na ekranie brala sie z `DISTINCT` po tabeli PRZYPISAN, wiec kategoria bez
// przypisanego NIP-u nie miala jak sie na niej pojawic — a bez pojawienia sie nie miala jak
// zostac wybrana, czyli nie mogla powstac NIGDY. „Sprzet" (drukarki, telefony, maszyny)
// i „Reklama" nie maja z gory znanego dostawcy i wpadaly dokladnie w te dziure.
const BEZ_PRZYPISANIA = [
  ['Prowizje sprzedażowe', 'zmienny'],
  ['Kurierzy', 'zmienny'],
  ['Opakowania', 'zmienny'],
  ['Płatności online', 'zmienny'],
  ['Księgowość', 'staly'],
  ['Oprogramowanie', 'staly'],
  ['Telefon', 'staly'],
  ['Hosting i domeny', 'staly'],
  ['Materiały do produkcji', 'zmienny'],
  ['Sprzęt', 'staly'],
  ['Reklama', 'zmienny'],
];

// ⚠️ JEDNORAZOWA ZMIANA NAZWY, A NIE PILNOWANIE NAZWY PRZY KAZDYM STARCIE — i ta roznica jest
// tu cala trescia (znacznik w `migracje_jednorazowe`, uzasadnienie w schema.sql).
//
// Sama poprawka napisu w tablicy STARTOWE nie rusza wiersza, ktory JUZ LEZY w bazie
// produkcyjnej: wgranie idzie przez `INSERT OR IGNORE`, wiec OVH zostawaloby w „Hosting"
// na zawsze. Migracja ponizej przenosi wiec CALA KATEGORIE (kazdy NIP, ktory w niej stoi —
// nie tylko OVH), bo przemianowana zostala kategoria, a nie przypisanie jednego dostawcy.
//
// DWIE OSLONY, KAZDA NA INNY PRZYPADEK:
//   • WARUNEK `kategoria = 'Hosting'` — operator, ktory przypial OVH GDZIE INDZIEJ (wlasna
//     kategoria „Serwery"), nie dostaje swojej decyzji cofnietej: tamten wiersz nie ma juz
//     starej nazwy, wiec migracja go nie widzi.
//   • ZNACZNIK WYKONANIA — operator, ktory SWIADOMIE wroci do nazwy „Hosting", tez jej nie
//     traci. Bez znacznika ta migracja chodzilaby przy KAZDYM starcie kontenera i kasowala
//     mu te decyzje przy najblizszym wdrozeniu, po cichu. To ta sama granica, co przy
//     `INSERT OR IGNORE` wyzej: migracja doklada to, czego brakuje, i nie rzadzi tym,
//     co czlowiek postanowil pozniej.
const MIGRACJA_HOSTING = 'kategorie-kosztow/hosting-i-domeny';
const STARA_NAZWA_HOSTINGU = 'Hosting';
const NOWA_NAZWA_HOSTINGU = 'Hosting i domeny';

function przemianujHosting(db, teraz) {
  const juz = db.prepare('SELECT 1 AS x FROM migracje_jednorazowe WHERE nazwa = ?')
    .get(MIGRACJA_HOSTING);
  if (juz) return;
  db.prepare('UPDATE kategorie_kosztow SET kategoria = ?, zmienione_at = ? WHERE kategoria = ?')
    .run(NOWA_NAZWA_HOSTINGU, teraz, STARA_NAZWA_HOSTINGU);
  // Slownik moze miec stara nazwe wylacznie wtedy, gdy powstal z przypisan istniejacej bazy
  // — kasujemy ja, zeby na liscie wyboru nie stanely OBIE nazwy tej samej kategorii.
  db.prepare('DELETE FROM slownik_kategorii_kosztow WHERE kategoria = ?').run(STARA_NAZWA_HOSTINGU);
  db.prepare('INSERT OR IGNORE INTO migracje_jednorazowe (nazwa, wykonana_at) VALUES (?,?)')
    .run(MIGRACJA_HOSTING, teraz);
}

export function wgrajKategorieStartowe(db) {
  const przypisanie = db.prepare(
    'INSERT OR IGNORE INTO kategorie_kosztow (nip, kategoria, typ, zmienione_at) VALUES (?,?,?,?)',
  );
  const teraz = new Date().toISOString();
  for (const [nip, kategoria, typ] of STARTOWE) przypisanie.run(nip, kategoria, typ, teraz);
  // ⚠️ SLOWNIK DOSTAJE KOMPLET: kategorie startowe RAZEM z tymi bez przypisania. Wgranie
  // wylacznie „bezdomnych" zostawialoby slownik niepelnym opisem stanu — a wtedy pierwsza
  // kategoria skasowana z przypisan (bo operator przepial dostawce) znikalaby z listy wyboru.
  for (const [, kategoria, typ] of STARTOWE) doSlownika(db, kategoria, typ, teraz);
  for (const [kategoria, typ] of BEZ_PRZYPISANIA) doSlownika(db, kategoria, typ, teraz);
  przemianujHosting(db, teraz);
}

// ⚠️ `INSERT OR IGNORE`, nigdy `REPLACE` — z tego samego powodu, co przy wgraniu startowym:
// wpisanie recznie kategorii, ktora w slowniku juz stoi, nie ma prawa przestawic jej TYPU.
// Typ decyduje o progu rentownosci w raporcie zarzadczym, wiec cicha zmiana z 'staly' na
// 'zmienny' przy okazji przypiecia jednego dostawcy byla by zmiana liczby, nie porzadkiem.
function doSlownika(db, kategoria, typ, kiedy = new Date().toISOString()) {
  const nazwa = String(kategoria ?? '').trim();
  if (!nazwa) return;
  db.prepare(
    'INSERT OR IGNORE INTO slownik_kategorii_kosztow (kategoria, typ, dodana_at) VALUES (?,?,?)',
  ).run(nazwa, typ, kiedy);
}

// ⚠️ U2 (druga runda recenzji): `znormalizujNip` sama nigdy nie oddaje NULL-a — dla braku
// NIP-u, smiecia bez cyfr albo `null`/`undefined` oddaje PUSTY NAPIS. Osoba wolajaca MUSI
// wiec zamienic pusty wynik na `null` sama — dokladnie tak, jak robi to
// `naWiersz` w domain/koszt-metadane.js (`znormalizujNip(...) || null`). Bez tej oslony
// pusty napis wchodzilby jako KLUCZ GLOWNY tabeli i sklejalby ze soba WSZYSTKICH sprzedawcow
// bez NIP-u — ta sama dziura, ktora `naWiersz` juz zamyka, tylko po drugiej stronie granicy.
const nipDoKlucza = (nip) => znormalizujNip(nip) || null;

// NULL znaczy „tego NIP-u nikt jeszcze nie przypisal" i ma byc WIDOCZNE na ekranie jako
// brak, a nie podmienione domyslna kategoria. Zgadnieta kategoria wchodzi do sumy okresu
// i nikt jej juz nie odrozni od przypisanej swiadomie.
export function kategoriaDlaNip(db, nip) {
  const znormalizowany = nipDoKlucza(nip);
  // Brak NIP-u nie ma czego szukac — pusty napis bylby KLUCZEM i trafilby w cudza kategorie.
  if (znormalizowany === null) return null;
  const w = db.prepare('SELECT kategoria, typ FROM kategorie_kosztow WHERE nip = ?')
    .get(znormalizowany);
  return w ? { kategoria: w.kategoria, typ: w.typ } : null;
}

// Przypiecie dziala dla WSZYSTKICH faktur tego NIP-u — takze juz lezacych w bazie — bo
// kategoria nie jest kopiowana do wiersza kosztu, tylko dobierana przy odczycie. Operator
// przypina raz, a nie przy kazdej fakturze od tego samego kontrahenta.
export function przypnijKategorie(db, nip, kategoria, typ) {
  const znormalizowany = nipDoKlucza(nip);
  // Kategoria dobiera sie PO NIP-IE — bez niego nie ma do czego przypiac, a wpisanie
  // pustego napisu zalozyloby wspolny wiersz dla wszystkich sprzedawcow bez NIP-u.
  if (znormalizowany === null) {
    throw bladOperatora(`Nie mozna przypisac kategorii bez NIP-u sprzedawcy (podano: "${nip}").`);
  }
  const kiedy = new Date().toISOString();
  db.prepare(`
    INSERT INTO kategorie_kosztow (nip, kategoria, typ, zmienione_at) VALUES (?,?,?,?)
    ON CONFLICT(nip) DO UPDATE SET kategoria = excluded.kategoria, typ = excluded.typ,
      zmienione_at = excluded.zmienione_at
  `).run(znormalizowany, kategoria, typ, kiedy);
  // ⚠️ WLASNA KATEGORIA OPERATORA WCHODZI DO SLOWNIKA. Pole na ekranie zostaje tekstowe —
  // nowa kategoria ma dac sie zalozyc bez wchodzenia do bazy — ale wpisana raz musi zostac
  // na liscie takze wtedy, gdy operator przepnie pozniej tego dostawce gdzie indziej.
  // Bez tego wlasna kategoria znika w chwili, w ktorej traci ostatni NIP, i trzeba ja
  // wpisywac z pamieci po raz drugi (dokladnie ta dziura, ktora slownik zamyka).
  doSlownika(db, kategoria, typ, kiedy);
}

// ⚠️⚠️ SUMA SLOWNIKA I PRZYPISAN, a nie samo `DISTINCT` po przypisaniach (2026-08-13).
//
// Zrodla sa dwa, bo odpowiadaja na dwa rozne pytania i zadne samo nie wystarcza:
//   • SLOWNIK niesie kategorie, ktore JESZCZE NIE MAJA dostawcy („Sprzet", „Reklama") — bez
//     niego nie da sie ich wybrac, a wiec i zalozyc: to byla dziura, dla ktorej slownik powstal;
//   • PRZYPISANIA niosa wszystko, co ktos JUZ przypial — takze na bazie produkcyjnej sprzed
//     powstania slownika, gdzie kategoria operatora zyje wylacznie w tej tabeli. Pominiecie
//     ich znaczyloby, ze wdrozenie tej zmiany KASUJE z listy istniejace kategorie.
//
// `UNION` (nie `UNION ALL`) skleja pary powtorzone w obu zrodlach. Tozsamoscia zostaje PARA
// (kategoria, typ) — ta sama nazwa z innym typem inaczej wchodzi do progu rentownosci, wiec
// jest osobna podpowiedzia, tak samo jak przed rozdzieleniem tabel.
export const wszystkieKategorie = (db) => db.prepare(`
  SELECT kategoria, typ FROM slownik_kategorii_kosztow
  UNION
  SELECT kategoria, typ FROM kategorie_kosztow
  ORDER BY kategoria
`).all();

// TYP KATEGORII PO NAZWIE — dla ekranu, ktory pyta o kategorie i NIE PYTA o typ (dopisanie
// firmy spoza KSeF, db/firmy-reczne.js). Kategoria typ juz zna, wiec pytanie o niego drugi raz
// byloby polem, ktore pozwala tej samej kategorii miec tu inny typ niz w rozbiciu miesiaca.
//
// ⚠️ TE SAME DWA ZRODLA, CO WYZEJ, i w tej samej kolejnosci: slownik przed przypisaniami.
// Lista wyboru na ekranie pochodzi z `wszystkieKategorie`, wiec sprawdzenie musi widziec
// DOKLADNIE ten sam zbior — inaczej istnialaby kategoria, ktora da sie wybrac i nie da sie
// zapisac. NULL znaczy „takiej kategorii panel nie zna" i jest odmowa, a nie zacheta do
// zgadniecia typu: zgadniety wchodzi do progu rentownosci nie do odroznienia od wybranego.
export function typKategorii(db, kategoria) {
  const nazwa = String(kategoria ?? '').trim();
  if (!nazwa) return null;
  return db.prepare(`
    SELECT typ FROM (
      SELECT kategoria, typ FROM slownik_kategorii_kosztow
      UNION
      SELECT kategoria, typ FROM kategorie_kosztow
    ) WHERE kategoria = ? LIMIT 1
  `).get(nazwa)?.typ ?? null;
}
