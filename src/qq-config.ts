import { Ajv } from 'ajv';
import { Failure } from './errors.js';
export interface QQConfig {
  appId: string;
  secretEnv: string;
  transport: 'websocket';
  environment: 'sandbox' | 'production';
  groupMessages: 'all' | 'mentions';
  connectTimeoutMs: number;
}
const validate = new Ajv().compile<QQConfig>({
  type: 'object', additionalProperties: false,
  required: ['appId', 'secretEnv', 'transport', 'environment', 'groupMessages', 'connectTimeoutMs'],
  properties: {
    appId: { type: 'string', pattern: '^[0-9]{1,32}$' },
    secretEnv: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' },
    transport: { const: 'websocket' }, groupMessages: { enum: ['all', 'mentions'] },
    environment: { enum: ['sandbox', 'production'] },
    connectTimeoutMs: { type: 'integer', minimum: 1, maximum: 120_000 },
  },
});
export function validateQQConfig(raw: unknown): QQConfig {
  if (!validate(raw)) throw new Failure('invalid_qq_config');
  return raw;
}

