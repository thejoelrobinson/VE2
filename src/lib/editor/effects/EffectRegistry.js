// Register, discover, and instantiate effects

const registry = new Map();

export const effectRegistry = {
  register(effectDef) {
    // effectDef: { id, name, category, type: 'video'|'audio'|'transition', params: [...], apply(ctx, params, progress) }
    registry.set(effectDef.id, effectDef);
  },

  get(id) {
    return registry.get(id);
  },

  getAll() {
    return [...registry.values()];
  },

  getByCategory(category) {
    return [...registry.values()].filter(e => e.category === category);
  },

  getByType(type) {
    return [...registry.values()].filter(e => e.type === type);
  },

  search(query) {
    const q = query.toLowerCase();
    return [...registry.values()].filter(e =>
      e.name.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q)
    );
  },

  createInstance(effectId) {
    const def = registry.get(effectId);
    if (!def) return null;

    // Deep-clone default params (arrays like curve points must not share references)
    const params = {};
    for (const p of def.params) {
      params[p.id] = (typeof p.default === 'object' && p.default !== null)
        ? JSON.parse(JSON.stringify(p.default))
        : p.default;
    }

    return {
      id: `fx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      effectId: def.id,
      name: def.name,
      enabled: true,
      params,
      keyframes: {} // paramId -> [{frame, value}]
    };
  },

  applyEffect(ctx, effectInstance, progress) {
    const def = registry.get(effectInstance.effectId);
    if (!def || !effectInstance.enabled) return;
    def.apply(ctx, effectInstance.params, progress);
  }
};

export default effectRegistry;
