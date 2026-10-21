// Menu models of the ER diagram (command ids only, like commands/menuModel.ts): the card context menu, the canvas
// background menu, and the toolbar's Layout / Export dropdowns.
import type { ContextEntry } from '../../commands/menuModel';

const c = (command: string): ContextEntry => ({ command });
const h = (command: string): ContextEntry => ({ command, hideDisabled: true });

/** Right-click / Shift+F10 on a card (args: ErCardArgs). */
export const ER_CARD_MENU: ContextEntry[] = [
  c('er.openData'), c('er.design'), c('er.openDdl'), 'separator',
  c('er.copyName'), c('er.showRelated'), h('er.addGhost'), 'separator',
  c('er.createFk'), c('er.pin'), 'separator',
  c('er.remove'),
];

/** Right-click on the canvas background. */
export const ER_CANVAS_MENU: ContextEntry[] = [
  c('er.addTables'), c('er.selectAll'), 'separator',
  c('er.fit'), c('er.zoomReset'), 'separator',
  c('er.layoutLR'), c('er.layoutTB'), c('er.layoutGrid'), c('er.resetLayout'), 'separator',
  c('er.exportPng'), c('er.exportSvg'),
];

export const ER_LAYOUT_MENU: ContextEntry[] = [c('er.layoutLR'), c('er.layoutTB'), c('er.layoutGrid'), 'separator', c('er.resetLayout')];
export const ER_EXPORT_MENU: ContextEntry[] = [c('er.exportPng'), c('er.exportSvg')];
