import * as real from '../../src/core/poczta/potwierdzenie-html.js';
import { MARKA_HISTORYCZNA as m } from './marka-poczty-fixture.js';
export * from '../../src/core/poczta/potwierdzenie-html.js';
export const renderPotwierdzenieHtml = (model, o = {}) => real.renderPotwierdzenieHtml(model, { ...m, ...o });
