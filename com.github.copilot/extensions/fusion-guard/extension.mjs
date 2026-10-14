import { joinSession } from '@github/copilot-sdk/extension';
import { registerExtension } from './hooks.mjs';

await registerExtension(joinSession);
