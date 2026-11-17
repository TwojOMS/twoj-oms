import * as real from '../../src/core/poczta/wiadomosc-html.js';
import { MARKA_HISTORYCZNA as m } from './marka-poczty-fixture.js';
export * from '../../src/core/poczta/wiadomosc-html.js';
export const renderWiadomoscHtml = (model, o = {}) => real.renderWiadomoscHtml(model, { ...m, ...o });
