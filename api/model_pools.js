/** Pool identifiers match upstream model identifiers; provider aliases stay routable. */
export function modelId(entry) {
  const model = entry.litellm_params?.model || entry.model_name;
  return model.replace(/^(gemini|groq|openrouter|openai|nvidia)\//, '');
}

export function modelMode(entry) {
  if (entry.mode) return entry.mode;
  if (entry.model_name?.startsWith('embed-')) return 'embedding';
  if (entry.model_name?.startsWith('transcribe-')) return 'transcription';
  return 'chat';
}

export function poolCatalog(config) {
  const entries = new Map();
  for (const entry of config.model_list || []) {
    const id = modelId(entry), mode = modelMode(entry);
    if (!entries.has(id)) entries.set(id, { id, object: 'model', mode, owned_by: entry.litellm_params?.model?.split('/')[0] || 'custom' });
  }
  return [...entries.values()];
}

export function addAliases(pools, config) {
  for (const entry of config.model_list || []) {
    const pool = pools[modelId(entry)];
    const aliases = new Set([entry.model_name, ...(entry.legacy_names || [])]);
    for (const alias of aliases) {
      if (!alias || alias === modelId(entry)) continue;
      if (!Object.hasOwn(pools, alias)) Object.defineProperty(pools, alias, { value: { items: [], rr: 0 }, enumerable: false });
      for (const item of pool.items) if (!pools[alias].items.includes(item)) pools[alias].items.push(item);
    }
  }
  return pools;
}
