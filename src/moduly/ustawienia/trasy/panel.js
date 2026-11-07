import {
  motywZNaglowka, przeciwnyMotyw, ciasteczkoMotywu, bezpiecznyPowrot,
} from '../../../domena/motyw.js';
import { menuZwinieteZNaglowka, ciasteczkoMenu } from '../../../domena/menu-boczne.js';

// Trasy wspólnej ramy panelu. Ustawienia mają osobny moduł.
export function registerPanelRoutes(app) {
  app.post('/menu-boczne', async (req, reply) => {
    return reply
      .header('Set-Cookie', ciasteczkoMenu(!menuZwinieteZNaglowka(req.headers.cookie)))
      .code(303)
      .redirect(bezpiecznyPowrot(req.body?.powrot));
  });
  app.post('/motyw', async (req, reply) => {
    const nowy = przeciwnyMotyw(motywZNaglowka(req.headers.cookie));
    return reply
      .header('Set-Cookie', ciasteczkoMotywu(nowy))
      .redirect(bezpiecznyPowrot(req.body?.powrot));
  });
}
