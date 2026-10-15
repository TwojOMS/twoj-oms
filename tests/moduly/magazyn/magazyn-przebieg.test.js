import { describe, it, expect, vi } from 'vitest';
import { createMagazynPrzebieg } from '../../../src/moduly/magazyn/services/magazyn-przebieg.js';

// PRZEBIEG ODCZYTU URUCHAMIANY PRZYCISKIEM.
//
// ⚠️ Cala tresc tej uslugi to JEDNO zdanie: przycisk ma wystartowac odczyt i wrocic, a nie
// czekac. Pelny przebieg to setki zadan do Woo plus ~46 do Allegro przy limicie 10 s/zadanie
// — w czasie zycia zadania HTTP sie nie miesci. Stan przebiegu zyje w PAMIECI PROCESU:
// to jeden przycisk dla jednego operatora, wiec tabela w bazie bylaby druga prawda
// do rozjechania i migracja do utrzymania.

// Obietnica, ktorej mozna dokonczyc z zewnatrz — bez niej nie da sie sprawdzic, ze
// `start` wraca PRZED koncem odczytu.
function wstrzymana() {
  let dokoncz; let wywroc;
  const obietnica = new Promise((ok, zle) => { dokoncz = ok; wywroc = zle; });
  return { obietnica, dokoncz, wywroc };
}

const db = { to: 'atrapa bazy' };

describe('createMagazynPrzebieg', () => {
  it('start WRACA, zanim odczyt sie skonczy, i melduje, ze przebieg trwa', async () => {
    const { obietnica, dokoncz } = wstrzymana();
    const odswiez = vi.fn(() => obietnica);
    const przebieg = createMagazynPrzebieg({ db, odswiez });

    const wynik = przebieg.start();

    expect(wynik.wystartowal).toBe(true);
    expect(przebieg.stan().trwa).toBe(true);
    expect(odswiez.mock.calls).toHaveLength(1);
    // Odczyt dostaje TE SAME zaleznosci, ktore usluga trzyma — bez `db` nie ma czego zapisac.
    expect(odswiez.mock.calls[0][0]).toMatchObject({ db });

    dokoncz({ kanaly: [] });
    await vi.waitFor(() => expect(przebieg.stan().trwa).toBe(false));
  });

  it('drugie klikniecie W TRAKCIE przebiegu NIE startuje drugiego odczytu', async () => {
    const { obietnica, dokoncz } = wstrzymana();
    const odswiez = vi.fn(() => obietnica);
    const przebieg = createMagazynPrzebieg({ db, odswiez });

    przebieg.start();
    const drugi = przebieg.start();

    // ⚠️ Dwa rownolegle przebiegi to dwa razy setki zadan do sklepu i dwa znaczniki
    // `odczytane_at` — ten z wczesniejszym stemplem oznaczylby jako zniknięte to,
    // co drugi wlasnie zapisal.
    expect(drugi.wystartowal).toBe(false);
    expect(odswiez.mock.calls).toHaveLength(1);

    dokoncz({ kanaly: [] });
    await obietnica;
  });

  it('...ale PO zakonczeniu startuje normalnie (straznik milczy, gdy nic nie trwa)', async () => {
    let numer = 0;
    const odswiez = vi.fn(async () => ({ kanaly: [{ kanal: 'pro', zapisane: numer += 1, znikniete: 0, blad: null }] }));
    const przebieg = createMagazynPrzebieg({ db, odswiez });

    przebieg.start();
    await vi.waitFor(() => expect(przebieg.stan().trwa).toBe(false));
    const drugi = przebieg.start();

    expect(drugi.wystartowal).toBe(true);
    expect(odswiez.mock.calls).toHaveLength(2);
  });

  it('wynik kanalow (zapisane, znikniete, blad) zostaje w stanie do pokazania na ekranie', async () => {
    const kanaly = [
      { kanal: 'pro', zapisane: 104, znikniete: 2, blad: null },
      { kanal: 'szkicownia', zapisane: 0, znikniete: 0, blad: 'Kanał szkicownia: odczyt oddał 0 pozycji' },
    ];
    const przebieg = createMagazynPrzebieg({ db, odswiez: async () => ({ kanaly }) });

    przebieg.start();
    await vi.waitFor(() => expect(przebieg.stan().trwa).toBe(false));

    expect(przebieg.stan().kanaly).toEqual(kanaly);
    expect(przebieg.stan().skonczony_at).not.toBeNull();
  });

  it('awaria CALEGO przebiegu laduje w stanie, a nie w niezlapanej obietnicy', async () => {
    const przebieg = createMagazynPrzebieg({
      db,
      odswiez: async () => { throw new Error('„nie-chwila" nie jest chwilą'); },
    });

    przebieg.start();
    await vi.waitFor(() => expect(przebieg.stan().trwa).toBe(false));

    // ⚠️ Bez tego zlapania przebieg konczylby sie odrzucona obietnica bez wlasciciela
    // (proces potrafi na to paść), a ekran nie mialby o czym powiedziec.
    expect(przebieg.stan().blad).toContain('nie jest chwilą');
    expect(przebieg.stan().trwa).toBe(false);
  });

  it('udany przebieg NIE zostawia bledu po poprzednim (straznik milczy)', async () => {
    let padnij = true;
    const przebieg = createMagazynPrzebieg({
      db,
      odswiez: async () => {
        if (padnij) throw new Error('pierwszy raz padlo');
        return { kanaly: [{ kanal: 'pro', zapisane: 1, znikniete: 0, blad: null }] };
      },
    });

    przebieg.start();
    await vi.waitFor(() => expect(przebieg.stan().blad).toContain('pierwszy raz padlo'));
    padnij = false;
    przebieg.start();
    await vi.waitFor(() => expect(przebieg.stan().trwa).toBe(false));

    expect(przebieg.stan().blad).toBeNull();
    expect(przebieg.stan().kanaly).toHaveLength(1);
  });

  it('postep odczytu idzie do stanu, zeby ekran mial co pokazac', async () => {
    const { obietnica, dokoncz } = wstrzymana();
    let zglos;
    const przebieg = createMagazynPrzebieg({
      db,
      odswiez: ({ postep }) => { zglos = postep; return obietnica; },
    });

    przebieg.start();
    zglos({ kanal: 'szkicownia', zrobione: 120, zTego: 668 });
    expect(przebieg.stan().postep).toEqual({ kanal: 'szkicownia', zrobione: 120, zTego: 668 });

    dokoncz({ kanaly: [] });
    await vi.waitFor(() => expect(przebieg.stan().trwa).toBe(false));
    // Po zakonczeniu postep juz o niczym nie mowi — liczby przebiegu niesie `kanaly`.
    expect(przebieg.stan().postep).toBeNull();
  });

  it('stan oddany na zewnatrz jest KOPIA — ekran nie ma jak przestawic przebiegu', async () => {
    const przebieg = createMagazynPrzebieg({
      db, odswiez: async () => ({ kanaly: [{ kanal: 'pro', zapisane: 1, znikniete: 0, blad: null }] }),
    });
    przebieg.start();
    await vi.waitFor(() => expect(przebieg.stan().trwa).toBe(false));

    const stan = przebieg.stan();
    stan.trwa = true;
    stan.kanaly.length = 0;

    expect(przebieg.stan().trwa).toBe(false);
    expect(przebieg.stan().kanaly).toHaveLength(1);
  });

  it('klienci sklepow i Allegro ida do odczytu tak, jak je zbudowal bootstrap', async () => {
    const sklepy = { pro: { pobierzWszystkieProdukty: () => [] } };
    const allegro = { allegro_szkicownia: { pobierzOferty: () => [] } };
    const odswiez = vi.fn(async () => ({ kanaly: [] }));
    const przebieg = createMagazynPrzebieg({ db, sklepy, allegro, odswiez });

    przebieg.start();
    await vi.waitFor(() => expect(przebieg.stan().trwa).toBe(false));

    // ⚠️ Mapa klientow Allegro NIE MOZE powstawac tutaj: druga instancja klienta na ten sam
    // kanal to druga para tokenow i dwa niezalezne odswiezenia JEDNORAZOWEGO refresh tokenu.
    expect(odswiez.mock.calls).toHaveLength(1);
    expect(odswiez.mock.calls[0][0].sklepy).toBe(sklepy);
    expect(odswiez.mock.calls[0][0].allegro).toBe(allegro);
  });
});
