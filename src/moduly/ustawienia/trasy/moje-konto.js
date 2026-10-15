// PRZ-069: Moje konto — imię, zmiana hasła z obecnym hasłem. E-mail i rolę zmienia tylko administrator.
// Trasy /konto, /konto/imie, /konto/haslo stoją w DLA_KAZDEGO (src/domena/ekrany.js) — bez ptaszka.
import { kontoPoLoginie, zmienHaslo } from '../../../core/bezpieczenstwo/konta.js';
import { zgodneHaslo } from '../../../domena/hasla.js';
import { utworzHamulec, LIMIT_PROB } from '../../../core/bezpieczenstwo/hamulec.js';
import { podpisz, ciasteczkoSesji, NAZWA_CIASTECZKA_OMS } from '../../../core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../core/bezpieczenstwo/sekret-sesji.js';
import { polaczenieBezpieczne } from '../../../core/bezpieczenstwo/logowanie-wspolne.js';
import { opisRoliKonta } from '../role.js';
import { emailKonta, czyZaproszone } from '../konta-dostep.js';
import { uniewaznijLinkiKonta } from '../linki-hasla.js';

export const MIN_DLUGOSC_HASLA = 12;
export const MAKS_IMIENIA = 60;
const KOMUNIKATY = { imie: 'Zapisano imię.', haslo: 'Zmieniono hasło. Inne urządzenia zostały wylogowane.' };

export function modelKonta(db, id) {
  const w = db.prepare('SELECT id, login, imie, czynne, hash_hasla FROM konta WHERE id = ?').get(id);
  if (!w) return null;
  return {
    id: w.id, login: w.login, imie: w.imie, czynne: w.czynne === 1, zaproszone: czyZaproszone(w.hash_hasla),
    email: emailKonta(db, w.id), rola: opisRoliKonta(db, w.id),
  };
}

// PRZ-075: `loginDemo` — wspólne konto gościa demo publicznego (core/demo.ts). Jego hasło stoi na ekranie
// logowania; gdyby gość mógł je zmienić, demo byłoby zamknięte dla wszystkich aż do nocnego resetu.
/** @param {any} app @param {{ db: any, teraz?: () => Date, loginDemo?: string | null, nazwaCiasteczka?: string }} opcje */
export function registerMojeKontoRoutes(app, { db, teraz = () => new Date(), loginDemo = null, nazwaCiasteczka = NAZWA_CIASTECZKA_OMS }) {
  const hamulec = utworzHamulec();
  const widok = (req, reply, extra = {}) => reply.view('konto.ejs', {
    title: 'Moje konto', serwisowe: false, wlasne: true, adminWidok: false, link: null, role: [],
    konto: modelKonta(db, req.konto.id), zapisano: KOMUNIKATY[req.query?.zapisano] ?? null, blad: null, ...extra,
  });
  const serwisowe = (req, reply, kod = 200) => reply.code(kod).view('konto.ejs', {
    title: 'Moje konto', serwisowe: true, wlasne: false, adminWidok: false, konto: null, link: null, role: [], zapisano: null, blad: null,
  });
  const zKontem = (req) => typeof req.konto?.id === 'number' && !req.konto.serwisowe;
  const demo = (req) => loginDemo !== null && req.konto?.login === loginDemo;
  const odmowaDemo = (req, reply) => widok(req, reply.code(403), { blad: 'Konto demo jest wspólne — zmiana imienia i hasła jest wyłączona.' });

  app.get('/konto', async (req, reply) => (zKontem(req) ? widok(req, reply) : serwisowe(req, reply)));

  app.post('/konto/imie', async (req, reply) => {
    if (!zKontem(req)) return serwisowe(req, reply, 403);
    if (demo(req)) return odmowaDemo(req, reply);
    const imie =String(req.body?.imie ?? '').trim();
    if (imie.length < 1 || imie.length > MAKS_IMIENIA) {
      return widok(req, reply.code(400), { blad: `Imię musi mieć od 1 do ${MAKS_IMIENIA} znaków.` });
    }
    db.prepare('UPDATE konta SET imie = ? WHERE id = ?').run(imie, req.konto.id);
    return reply.redirect('/konto?zapisano=imie');
  });

  app.post('/konto/haslo', async (req, reply) => {
    if (!zKontem(req)) return serwisowe(req, reply, 403);
    if (demo(req)) return odmowaDemo(req, reply);
    const klucz =`konto:${req.konto.id}`;
    const stan = hamulec.sprawdz(klucz);
    if (!stan.wolno) return widok(req, reply.code(429), { blad: `Za dużo prób — spróbuj za ${Math.ceil(stan.zostaloMs / 1000)} s.` });
    const obecne = String(req.body?.obecne ?? '');
    const nowe = String(req.body?.nowe ?? '');
    const nowe2 = String(req.body?.nowe2 ?? '');
    const zapis = db.prepare('SELECT hash_hasla FROM konta WHERE id = ?').get(req.konto.id)?.hash_hasla;
    if (!zgodneHaslo(obecne, zapis)) {
      const proby = hamulec.odnotujBlad(klucz);
      return widok(req, reply.code(proby >= LIMIT_PROB ? 429 : 400), { blad: 'Obecne hasło jest nieprawidłowe.' });
    }
    hamulec.wyczysc(klucz);
    if (nowe.length < MIN_DLUGOSC_HASLA) return widok(req, reply.code(400), { blad: `Nowe hasło musi mieć co najmniej ${MIN_DLUGOSC_HASLA} znaków.` });
    if (nowe !== nowe2) return widok(req, reply.code(400), { blad: 'Nowe hasło wpisane dwa razy różni się.' });
    if (nowe === obecne) return widok(req, reply.code(400), { blad: 'Nowe hasło musi różnić się od obecnego.' });
    zmienHaslo(db, req.konto.id, nowe);
    // Recenzja D8 r1, P3-1: nieużyty link do hasła (np. reset zlecony adminowi) nie może potem nadpisać nowego hasła.
    uniewaznijLinkiKonta(db, req.konto.id, teraz);
    // Nowa wersja hasła wylogowuje wszystkie sesje — bieżąca dostaje od razu nowe ciasteczko (spec §4.4).
    const konto = kontoPoLoginie(db, req.konto.login);
    return reply
      .header('Set-Cookie', ciasteczkoSesji(nazwaCiasteczka, podpisz(konto.login, wczytajSekret(db), Date.now(), konto.wersja_hasla),
        { bezpieczne: polaczenieBezpieczne(req) }))
      .redirect('/konto?zapisano=haslo');
  });
}
