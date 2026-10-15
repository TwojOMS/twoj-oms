import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { zalozCel, dopiszZdarzenie } from '../../../src/oms/db/cele.js';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };

let db;
let kolejneKonto = 0;
beforeEach(() => { db = openOmsDb(':memory:'); kolejneKonto = 0; });

const konto = (imie) => {
  kolejneKonto += 1;
  const info = db.prepare(
    'INSERT INTO konta (login, imie, hash_hasla, rola, czynne, admin, utworzone_at)'
    + " VALUES (?,?,'x','sprzedaz',1,0,'2026-09-01T00:00:00Z')",
  ).run(`login${kolejneKonto}`, imie);
  return Number(info.lastInsertRowid);
};

const wejdz = async (url) => {
  const app = buildOmsServer({ db, config });
  const odp = await app.inject({ method: 'GET', url, headers: naglowek });
  await app.close();
  return odp;
};

// ⚠️ ASERCJE MUSZA PATRZEC NA TRESC STRONY, NIE NA CALY DOKUMENT. `layout-oms.ejs` wkleja
// w <head> caly arkusz styli, a w nim stoja nazwy klas zakladki (`.cele-pasek`) i rozne
// liczby w komentarzach. Test szukajacy „cele-pasek" albo „0 / 5" w `odp.body` trafialby
// w ARKUSZ STYLI i byl zielony (albo czerwony) z powodu, ktory nie ma nic wspolnego
// z tym, co widzi czlowiek. Ta pulapka zapalila sie tu na zywo 13.09.
// ⚠️ Kotwica to `</head>`, a NIE pierwsze wystapienie nazwy klasy. Pierwsze „glowa-ekranu"
// w dokumencie pada w ARKUSZU STYLI (`.glowa-ekranu { display: flex; … }`), wiec kotwiczenie
// na nazwie klasy zostawialoby w „tresci" caly CSS — i asercja `not.toContain` dalej
// trafialaby w styl. Ta pomylka zapalila sie tu dwa razy pod rzad 13.09.
const tresc = (body) => body.slice(body.indexOf('</head>') + 7);
const kafle = (body) => tresc(body).split('pas-lista')[0];
const lista = (body) => tresc(body).split('pas-lista')[1] ?? '';

const nowy = (n = {}) => zalozCel(db, {
  nazwa: 'Nowe wzory', kontoId: null, rytm: 'tydzien', celIle: 5,
  miernik: 'reczny', odDnia: null, doDnia: null, ...n,
});

// Dzien warszawski — ten sam, ktorego uzywa trasa. Zdarzenie zapisane na „dzis" musi wpasc
// w biezacy tydzien, inaczej test bylby zielony albo czerwony zaleznie od godziny przebiegu.
const dzis = () => dzienWarszawa(new Date().toISOString());

describe('GET /cele — szkielet ekranu', () => {
  it('odpowiada 200 i ma oba pasy', async () => {
    const odp = await wejdz('/cele');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('pas-kafle');
    expect(odp.body).toContain('pas-lista');
  });
});

describe('GET /cele — UKLAD SEKCJI (niezmiennik 4.88b)', () => {
  // ⚠️⚠️ `section.panel` MA `padding: 0` — margines daje `div.panel-cialo` (`padding: .9rem`).
  // Pierwsza wersja tej zakladki wstawiala `h2` i tabele WPROST w sekcje, wiec naglowki
  // i wiersze dotykaly ramki. Zgloszone przez właściciela tymi samymi slowami, co dzien wczesniej
  // przy STATYSTYKACH: „w polach nie ma marginesow" — druga zakladka z rzedu, mimo ze
  // niezmiennik juz stal w PRZEWODNIKU.
  //
  // ⚠️ Suita byla w pelni ZIELONA, kiedy ekran byl zepsuty: odpowiadal 200 i niosl wszystkie
  // liczby, bo zaden test nie sprawdzal warstwy MIEDZY panelem a komorka.

  it('kazda sekcja ma glowe i cialo', async () => {
    const odp = await wejdz('/cele');
    const sekcje = (tresc(odp.body).match(/<section class="panel/g) ?? []).length;
    const glowy = (tresc(odp.body).match(/class="panel-glowa"/g) ?? []).length;
    const ciala = (tresc(odp.body).match(/class="panel-cialo"/g) ?? []).length;
    expect(sekcje).toBeGreaterThan(0);
    expect(glowy).toBe(sekcje);
    expect(ciala).toBe(sekcje);
  });

  it('tabela stoi WEWNATRZ ciala panelu, nie przed nim', async () => {
    // ⚠️ Sama obecnosc klasy nie wystarcza — tabela postawiona PRZED `div.panel-cialo`
    // tez by ja miala na stronie, a dalej dotykalaby ramki.
    const dol = lista((await wejdz('/cele')).body);
    expect(dol.indexOf('panel-cialo')).toBeGreaterThan(-1);
    expect(dol.indexOf('panel-cialo')).toBeLessThan(dol.indexOf('<table'));
  });

  it('kafle stoja WEWNATRZ ciala panelu', async () => {
    nowy({ nazwa: 'Widoczny' });
    const gora = kafle((await wejdz('/cele')).body);
    // ⚠️ Najpierw obecnosc, POTEM kolejnosc. Samo `indexOf(a) < indexOf(b)` przechodzi
    // trywialnie, gdy `a` w ogole nie ma (−1 jest mniejsze od wszystkiego) — ta asercja
    // przechodzila na zielono na ZEPSUTYM ekranie, zanim ja poprawilem.
    expect(gora).toContain('panel-cialo');
    expect(gora.indexOf('panel-cialo')).toBeLessThan(gora.indexOf('kafelki'));
  });
});

describe('GET /cele — pas gorny (kafle)', () => {
  it('licznik pokazuje postep jako „N / M"', async () => {
    const id = nowy();
    dopiszZdarzenie(db, { celId: id, dzien: dzis(), ile: 2, kontoId: null });
    const odp = await wejdz('/cele');
    expect(kafle(odp.body)).toMatch(/2\s*\/\s*5/);
  });

  it('cel z NIEZNANYM miernikiem pokazuje kreske, NIE zero', async () => {
    // ⚠️ NAJWAZNIEJSZA ASERCJA EKRANU. To jest ochrona przed falszywa zielenia widziana
    // z poziomu HTML-a: gdyby widok renderowal `ile ?? 0`, ten test przeszedlby na zero
    // i nikt by sie nie dowiedzial, ze miernik padl.
    nowy({ nazwa: 'Zepsuty', miernik: 'nie-ma-takiego', celIle: 5 });
    const odp = await wejdz('/cele');
    expect(kafle(odp.body)).toContain('stan-nieznany');
    expect(kafle(odp.body)).toMatch(/—\s*\/\s*5/);
    // I zeby nie bylo watpliwosci: nigdzie w TRESCI strony nie pada „0 / 5".
    expect(tresc(odp.body)).not.toMatch(/0\s*\/\s*5/);
  });

  it('licznik reczny niesie date ostatniego wpisu — albo „nigdy"', async () => {
    // Licznik reczny mierzy KLIKANIE, nie prace. „Ostatni wpis" jest jedynym sygnalem,
    // jaki da sie na to nalozyc.
    nowy({ nazwa: 'Bez wpisow' });
    const odp = await wejdz('/cele');
    expect(kafle(odp.body)).toContain('ostatni wpis');
    expect(kafle(odp.body)).toContain('nigdy');
  });

  it('zadanie tak/nie NIE ma paska postepu', async () => {
    nowy({ nazwa: 'Kampania Google', celIle: null, rytm: 'jednorazowy', doDnia: '2026-09-30' });
    const odp = await wejdz('/cele');
    const gora = kafle(odp.body);
    expect(gora).toContain('Kampania Google');
    expect(gora).toContain('kafel--zadanie');
    expect(gora).not.toContain('cele-pasek');
  });

  it('zadanie z TERMINEM pokazuje ten termin, a nie „bez terminu"', async () => {
    // ⚠️ REGRESJA ZLAPANA NA DEMO (13.09): cel jednorazowy ma zwykle sam `do_dnia` — nikt
    // nie wpisuje daty poczatku dla „uruchomic kampanie we wrzesniu". Etykieta skladana
    // tylko wtedy, gdy sa OBIE daty, mowila wiec „bez terminu" celowi, ktory termin MA.
    // To dokladnie przyklad, od ktorego właściciel zaczal zgloszenie.
    nowy({
      nazwa: 'Kampania Google', celIle: null, rytm: 'jednorazowy',
      odDnia: null, doDnia: '2026-09-30',
    });
    const odp = await wejdz('/cele');
    expect(kafle(odp.body)).toContain('2026-09-30');
    expect(kafle(odp.body)).not.toContain('bez terminu');
  });

  it('cel bez ZADNEJ daty dalej mowi „bez terminu"', async () => {
    nowy({ nazwa: 'Kiedyś', celIle: null, rytm: 'jednorazowy', odDnia: null, doDnia: null });
    const odp = await wejdz('/cele');
    expect(kafle(odp.body)).toContain('bez terminu');
  });

  it('wygaszony cel jest na liscie, ale NIE na kaflach', async () => {
    const id = nowy({ nazwa: 'Stary cel' });
    db.prepare('UPDATE cele SET czynny = 0 WHERE id = ?').run(id);
    const odp = await wejdz('/cele');
    const gora = kafle(odp.body); const dol = lista(odp.body);
    expect(gora).not.toContain('Stary cel');
    expect(dol).toContain('Stary cel');
  });
});

describe('GET /cele — pas dolny (lista)', () => {
  it('pusta lista ma wiersz pustego stanu z colspan rownym liczbie kolumn', async () => {
    // ⚠️ PUSTA LISTA TO STAN PIERWSZEGO DNIA PO WDROZENIU — czyli jedyny ekran, ktory
    // właściciel zobaczy NAJPIERW. Rozjechany colspan widac wylacznie tutaj i przezylby kazdy
    // „normalny" dowod wdrozenia. Zaden inny test w tym repo tego nie pilnuje.
    const odp = await wejdz('/cele');
    expect(odp.body).toContain('colspan="6"');
    expect(odp.body).toContain('Nie ma jeszcze żadnego celu');
  });

  it('colspan zgadza sie z FAKTYCZNA liczba naglowkow, nie z liczba wpisana z pamieci', async () => {
    // Ta asercja lapie rozjazd przy DOLOZENIU kolumny: ktos dopisze <th> i zapomni podbic
    // colspan. Liczymy naglowki w HTML-u zamiast wierzyc stalej.
    const odp = await wejdz('/cele');
    const naglowki = (lista(odp.body).match(/<th[ >]/g) ?? []).length;
    const colspan = Number(lista(odp.body).match(/colspan="(\d+)"/)[1]);
    expect(colspan).toBe(naglowki);
  });
});

describe('GET /cele — filtr osoby', () => {
  it('?kto= zaweza kafle do jednej osoby', async () => {
    const ewa = konto('Ewa');
    nowy({ nazwa: 'Cel Agi', kontoId: ewa });
    nowy({ nazwa: 'Cel wspolny', kontoId: null });
    const odp = await wejdz(`/cele?kto=${ewa}`);
    expect(odp.body).toContain('Cel Agi');
    expect(odp.body).not.toContain('Cel wspolny');
  });

  it('smiec w ?kto= daje widok WSZYSTKICH, nie pusta liste', async () => {
    // Pusta lista wygladalaby jak „nie ma celow" — czyli jak stan firmy, a nie jak zly adres.
    nowy({ nazwa: 'Cel wspolny' });
    const odp = await wejdz('/cele?kto=drop-table');
    expect(odp.statusCode).toBe(200);
    expect(odp.body).toContain('Cel wspolny');
  });
});
