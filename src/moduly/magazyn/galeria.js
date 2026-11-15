import multipart from '@fastify/multipart';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { constants, copyFileSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { zapiszZdjecie, LIMIT } from './services/zdjecia-pliki.js';
import { stronaOdmowy } from '../../core/web/odmowa.js';
import { ustawZnacznikAi } from './services/znacznik-ai.js';

const zdjecia = (db, id) => db.prepare('SELECT * FROM zdjecia_kart WHERE karta_id = ? ORDER BY kolejnosc, id').all(id);

// Twarde dowiązanie jest niepodzielne; system plików bez dowiązań (SMB, część montowań Dockera) dostaje kopię,
// która tak samo odmawia nadpisania (EEXIST).
function publikuj(zrodlo, cel) {
  try { linkSync(zrodlo, cel); }
  catch (e) {
    if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'].includes(e.code)) throw e;
    copyFileSync(zrodlo, cel, constants.COPYFILE_EXCL);
  }
}
export function daneGalerii(db, kartaId) {
  return zdjecia(db, kartaId).map(z => ({ ...z,
    adres: z.plik ? `/magazyn/zdjecia/${encodeURIComponent(z.plik)}`
      : (typeof z.adres_zrodlowy === 'string' && /^https?:\/\//i.test(z.adres_zrodlowy) ? z.adres_zrodlowy : null),
    etykieta: z.zrodlo.startsWith('allegro:') ? 'z Allegro' : z.zrodlo.startsWith('woo:') ? 'ze sklepu' : z.zrodlo === 'api' ? 'przez API' : 'wgrane',
  }));
}
function oznaczReczne(db, id) {
  db.prepare(`INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at)
    VALUES (?, 'zdjecia', 'reczne', 1, ?) ON CONFLICT (karta_id, pole) DO UPDATE SET
    zrodlo = 'reczne', reczne = 1, zmieniono_at = excluded.zmieniono_at`).run(id, new Date().toISOString());
}
function transakcja(db, wykonaj) {
  db.exec('BEGIN IMMEDIATE');
  try { const wynik = wykonaj(); db.exec('COMMIT'); return wynik; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// CSRF i uprawnienie magazyn zapewniają wspólne haki panelu, także w zakresie multipart.
export function registerGaleriaMagazynu(app, { db, katalog }) {
  const odmowa = (req, reply, kod, tekst) => stronaOdmowy(reply, kod, tekst, {
    tytul: 'Nie zmieniono zdjęć', wroc: `/magazyn/${encodeURIComponent(req.params.id)}#zdjecia-karty`, napisWroc: 'Wróć do zdjęć',
  });
  const powrot = (req, reply) => reply.code(303).redirect(`/magazyn/${encodeURIComponent(req.params.id)}#zdjecia-karty`);
  const kartaIstnieje = id => Boolean(db.prepare('SELECT id FROM karty_produktow WHERE id = ?').get(id));
  const znajdzZdjecie = (kartaId, zdjecieId) => db.prepare('SELECT * FROM zdjecia_kart WHERE id = ? AND karta_id = ?').get(zdjecieId, kartaId);

  app.post('/magazyn/:id/zdjecia/kolejnosc', async (req, reply) => {
    const { zdjecieId, kierunek } = req.body ?? {};
    if (!znajdzZdjecie(req.params.id, zdjecieId ?? null)) return odmowa(req, reply, 404, 'Nie ma takiego zdjęcia na tej karcie.');
    if (!['lewo', 'prawo'].includes(kierunek)) return odmowa(req, reply, 400, 'Wybierz przesunięcie w lewo albo w prawo.');
    transakcja(db, () => {
      const lista = zdjecia(db, req.params.id);
      const i = lista.findIndex(z => String(z.id) === String(zdjecieId));
      const j = i + (kierunek === 'lewo' ? -1 : 1);
      if (i < 0 || j < 0 || j >= lista.length) return;
      [lista[i], lista[j]] = [lista[j], lista[i]];
      // Normalizacja rozstrzyga też zastane remisy i luki w numeracji.
      lista.forEach((z, n) => db.prepare('UPDATE zdjecia_kart SET kolejnosc = ? WHERE id = ? AND karta_id = ?').run(n, z.id, req.params.id));
      oznaczReczne(db, req.params.id);
    });
    return powrot(req, reply);
  });
  app.post('/magazyn/:id/zdjecia/:zdjecieId/usun', async (req, reply) => {
    if (!znajdzZdjecie(req.params.id, req.params.zdjecieId)) return odmowa(req, reply, 404, 'Nie ma takiego zdjęcia na tej karcie.');
    transakcja(db, () => {
      db.prepare('DELETE FROM zdjecia_kart WHERE id = ? AND karta_id = ?').run(req.params.zdjecieId, req.params.id);
      oznaczReczne(db, req.params.id);
    });
    return powrot(req, reply);
  });
  app.post('/magazyn/:id/zdjecia/:zdjecieId/ai', async (req, reply) => {
    const z = znajdzZdjecie(req.params.id, req.params.zdjecieId);
    if (!z) return odmowa(req, reply, 404, 'Nie ma takiego zdjęcia na tej karcie.');
    if (z.wyslane_at) return odmowa(req, reply, 409, 'Nie można zmienić znacznika AI zdjęcia wysłanego do kanału.');
    const wartosc = req.body?.ai;
    if (wartosc !== undefined && wartosc !== '1') return odmowa(req, reply, 400, 'Wybierz poprawny znacznik AI zdjęcia.');
    ustawZnacznikAi(db, { kartaId: req.params.id, zdjecieId: req.params.zdjecieId, ai: wartosc === '1' ? 1 : 0 });
    return powrot(req, reply);
  });
  app.register(async scoped => {
    // Jedno dodatkowe miejsce pozwala nazwać plik przekraczający limit 20.
    // Formularz ma tylko pole ai; CSRF sprawdzany jest przez Origin/Referer.
    await scoped.register(multipart, { limits: { files: 21, fileSize: LIMIT + 1, fields: 1, parts: 22 } });
    scoped.post('/magazyn/:id/zdjecia/wgraj', async (req, reply) => {
      if (!kartaIstnieje(req.params.id)) return odmowa(req, reply, 404, 'Nie ma takiej karty produktu.');
      let ai = 0, nazwa = '', roboczy, odpowiedz;
      const paczka = [], utworzone = [];
      const blad = tekst => Object.assign(new Error(tekst), { odmowa: true });
      const limit = plik => blad(`${plik}: Karta może mieć najwyżej 20 zdjęć. Usuń zdjęcie, aby wgrać kolejne.`);
      try {
        let ilePlikow = 0;
        for await (const part of req.parts()) {
          if (part.type === 'field') {
            if (part.fieldname !== 'ai' || !['0', '1'].includes(part.value)) throw blad('Wybierz poprawny znacznik AI zdjęcia.');
            ai = part.value === '1' ? 1 : 0;
            continue;
          }
          nazwa = part.filename || 'Zdjęcie';
          if (part.type !== 'file' || part.fieldname !== 'zdjecie') throw blad(`${nazwa}: Wybierz pliki zdjęć w polu zdjecie.`);
          if (++ilePlikow > 20) throw limit(nazwa);
          const bufor = await part.toBuffer();
          if (part.file.truncated || bufor.length > LIMIT) throw blad(`${nazwa}: Limit zdjęcia: 10 MB.`);
          const sha = createHash('sha256').update(bufor).digest('hex');
          if (!roboczy) {
            await mkdir(katalog, { recursive: true });
            roboczy = await mkdtemp(join(katalog, '.paczka-'));
          }
          // Walidacja zawartości i zapis wyłącznie w katalogu roboczym.
          const z = await zapiszZdjecie(bufor, { katalog: roboczy });
          if (!paczka.some(p => p.sha256 === sha)) paczka.push({ ...z, nazwa });
        }
        if (!paczka.length) throw blad('Wybierz plik zdjęcia.');
        const nowe = lista => paczka.filter(p => !lista.some(z => z.sha256 === p.sha256));
        const sprawdzLimit = (lista, pliki) => {
          if (lista.length + pliki.length > 20) throw limit(pliki[Math.max(0, 20 - lista.length)].nazwa);
        };
        const listaPrzed = zdjecia(db, req.params.id);
        sprawdzLimit(listaPrzed, nowe(listaPrzed));
        // Po asynchronicznym przygotowaniu ponownie liczymy w transakcji.
        // Publikacja plików jest synchroniczna: nie oddajemy sterowania między nią a COMMIT.
        transakcja(db, () => {
          const lista = zdjecia(db, req.params.id), pliki = nowe(lista);
          sprawdzLimit(lista, pliki);
          let n = lista.reduce((max, z) => Math.max(max, z.kolejnosc + 1), 0);
          for (const z of pliki) {
            const cel = join(katalog, z.plik);
            try { publikuj(join(roboczy, z.plik), cel); utworzone.push(cel); }
            catch (e) { if (e.code !== 'EEXIST') throw e; }
            db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, plik, sha256, typ, rozmiar, szerokosc, wysokosc, utworzono_at, ai, ai_reczne)
              VALUES (?, ?, 'reczne', ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(req.params.id, n++, z.plik, z.sha256, z.typ, z.rozmiar, z.szerokosc, z.wysokosc, new Date().toISOString(), ai);
          }
          if (pliki.length) oznaczReczne(db, req.params.id);
        });
      } catch (e) {
        for (const cel of utworzone) { try { unlinkSync(cel); } catch { /* sprzątanie nie zasłania błędu */ } }
        const zNazwa = m => (nazwa ? `${nazwa}: ${m}` : m);
        if (e.odmowa) odpowiedz = [400, e.message];
        else if (e.code === 'FST_REQ_FILE_TOO_LARGE') odpowiedz = [400, zNazwa('Limit zdjęcia: 10 MB.')];
        else if (/^(Niedozwolon|Limit zdjęcia)/.test(e.message)) odpowiedz = [400, zNazwa(e.message)];
        else if (e.code?.startsWith('FST_')) odpowiedz = [400, zNazwa('Wybierz pliki JPEG, PNG lub WebP.')];
        else {
          req.log.error({ err: e }, 'Nie udało się zapisać zdjęcia karty.');
          odpowiedz = [500, 'Nie udało się zapisać zdjęcia. Spróbuj ponownie.'];
        }
      } finally {
        if (roboczy) await rm(roboczy, { recursive: true, force: true });
      }
      if (odpowiedz) return odmowa(req, reply, ...odpowiedz);
      return powrot(req, reply);
    });
  });
}
