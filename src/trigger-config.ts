export interface ProactiveSettings {
  enabled: boolean;
  excludedGroupIds: string[];
  activeSeconds: number;
  idleSeconds: number;
  idleMessages: number;
  historyMessages: number;
  maxRepliesPerMinute: number;
}
export const proactiveDefaults: ProactiveSettings = {
  enabled: false, excludedGroupIds: [], activeSeconds: 60, idleSeconds: 60,
  idleMessages: 20, historyMessages: 30, maxRepliesPerMinute: 6,
};
export const proactiveSchema = {
  type: 'object', additionalProperties: false, required: Object.keys(proactiveDefaults), properties: {
    enabled: { type: 'boolean' },
    excludedGroupIds: { type: 'array', maxItems: 1000, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 512 } },
    activeSeconds: { type: 'integer', minimum: 10, maximum: 1800 },
    idleSeconds: { type: 'integer', minimum: 1, maximum: 60 },
    idleMessages: { type: 'integer', minimum: 1, maximum: 50 },
    historyMessages: { type: 'integer', minimum: 5, maximum: 100 },
    maxRepliesPerMinute: { type: 'integer', minimum: 1, maximum: 30 },
  },
};

/** Old allowed groups are not excluded groups: upgrading clears that filter, never inverts it. */
export function migrateProactiveConfig(raw: unknown): unknown {
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!record(raw) || !record(raw.trigger) || !record(raw.trigger.proactive)) return raw;
  const previous = raw.trigger.proactive;
  if (!Object.hasOwn(previous, 'groupIds') || Object.hasOwn(previous, 'excludedGroupIds')) return raw;
  if (!Array.isArray(previous.groupIds) || previous.groupIds.length > 1000
    || !previous.groupIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512)
    || new Set(previous.groupIds).size !== previous.groupIds.length) return raw;
  const { groupIds: _oldGroups, ...settings } = previous;
  return { ...raw, trigger: { ...raw.trigger, proactive: { ...settings, excludedGroupIds: [] } } };
}
