import { runTier } from '../lib/engine.mjs';
import { handleTier } from '../lib/handler.mjs';

export default function handler(req, res) {
  return handleTier('audit', req, res, runTier);
}
