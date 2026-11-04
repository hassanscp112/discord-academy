// Interaction entry points for the Coach — the handlers live in ./interactions/:
//   defs.js (slash command definitions) · slash.js · buttons.js · forms.js (modals, menus) · shared.js
export { commandDefs } from './interactions/defs.js';
export { handleCommand } from './interactions/slash.js';
export { handleButton } from './interactions/buttons.js';
export { handleModal, handleSelect, handleContextMenu } from './interactions/forms.js';
export { isAdmin } from './interactions/shared.js';
