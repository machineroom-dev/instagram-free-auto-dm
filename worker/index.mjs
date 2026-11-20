// Cloudflare Worker entry: a cron trigger only (wrangler.jsonc), no fetch handler and no public URL.
// config.json is bundled at deploy time, so a funnel change is `npm run check` then `npm run worker:deploy`.
import config from '../config.json' with { type: 'json' };
import { runWorker } from './run.mjs';

export default {
  async scheduled(controller, env) {
    await runWorker({ env, config });
  },
};
