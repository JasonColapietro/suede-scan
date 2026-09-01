import { runTier } from '../lib/engine.mjs';
import { handleOperatorAudit } from '../lib/handler.mjs';

export default function handler(req, res) {
  return handleOperatorAudit(req, res, runTier);
}
