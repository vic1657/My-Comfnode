function linkedNodeId(value, source) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const key = String(value[0]);
  return source[key] ? key : null;
}

function includeNodeAndUpstream(nodeId, source, target) {
  const key = String(nodeId);
  if (target[key] || !source[key]) return;

  const current = source[key];
  target[key] = current;
  for (const value of Object.values(current.inputs || {})) {
    const upstreamId = linkedNodeId(value, source);
    if (upstreamId !== null) {
      includeNodeAndUpstream(upstreamId, source, target);
    }
  }
}

function collectDescendantIds(nodeId, source) {
  const selected = new Set();
  const pending = [String(nodeId)];

  while (pending.length > 0) {
    const currentId = pending.shift();
    if (selected.has(currentId) || !source[currentId]) continue;
    selected.add(currentId);

    for (const [candidateId, candidate] of Object.entries(source)) {
      if (selected.has(candidateId)) continue;
      const consumesCurrent = Object.values(candidate.inputs || {}).some(
        (value) => linkedNodeId(value, source) === currentId,
      );
      if (consumesCurrent) pending.push(candidateId);
    }
  }

  return selected;
}

export function buildIndependentPrompt(nodeId, source) {
  const filtered = {};
  for (const selectedId of collectDescendantIds(nodeId, source)) {
    includeNodeAndUpstream(selectedId, source, filtered);
  }
  return filtered;
}
