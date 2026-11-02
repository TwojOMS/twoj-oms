import { odczytajKopie } from '../services/kopie.ts';
import { nawigacjaUstawien } from '../nawigacja.js';

/** @param {any} app @param {{konfiguracja?:()=>any,katalog?:string,zewnetrzna?:string,teraz?:()=>Date,nadzor?:(()=>any)|null}} [opcje] */
export function registerKopieRoutes(app, { konfiguracja = () => ({}), katalog = '', zewnetrzna = '', teraz = () => new Date(), nadzor = null } = {}) {
  const widok = (req, reply) => reply.view('ustawienia-kopie.ejs', {
    title: 'Kopie zapasowe', nawigacja: nawigacjaUstawien(req, reply),
    kopie: odczytajKopie({ katalog, zewnetrzna, ...konfiguracja(), teraz: teraz(), nadzor }),
    historia: req.url.split('?')[0] === '/ustawienia/kopie/historia',
  });
  app.get('/ustawienia/kopie', widok);
  app.get('/ustawienia/kopie/historia', widok);
}
