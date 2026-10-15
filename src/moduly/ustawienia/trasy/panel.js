import {
  motywZNaglowka, przeciwnyMotyw, ciasteczkoMotywu, bezpiecznyPowrot,
} from '../../../domena/motyw.js';

// Trasy wspólnej ramy panelu. Ustawienia mają osobny moduł.
export function registerPanelRoutes(app) {
  app.post('/motyw', async (req, reply) => {
    const nowy = przeciwnyMotyw(motywZNaglowka(req.headers.cookie));
    return reply
      .header('Set-Cookie', ciasteczkoMotywu(nowy))
      .redirect(bezpiecznyPowrot(req.body?.powrot));
  });
}
