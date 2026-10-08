function dependencyIds(promptNode, knownIds) {
  const dependencies = new Set();
  for (const value of Object.values(promptNode?.inputs || {})) {
    if (Array.isArray(value) && value.length >= 2) {
      const id = String(value[0]);
      if (knownIds.has(id)) dependencies.add(id);
    }
  }
  return dependencies;
}

export function isolatePromptBranch(promptData, sourceNodeId) {
  const output = promptData?.output || promptData?.prompt;
  if (!output || typeof output !== "object") {
    throw new Error("当前工作流 prompt 格式无效");
  }

  const sourceId = String(sourceNodeId);
  const knownIds = new Set(Object.keys(output).map(String));
  if (!knownIds.has(sourceId)) {
    throw new Error("当前工作流 prompt 中没有找到发起运行的批量节点");
  }

  const dependencies = new Map();
  const children = new Map();
  for (const [nodeId, promptNode] of Object.entries(output)) {
    const id = String(nodeId);
    const nodeDependencies = dependencyIds(promptNode, knownIds);
    dependencies.set(id, nodeDependencies);
    for (const dependencyId of nodeDependencies) {
      if (!children.has(dependencyId)) children.set(dependencyId, new Set());
      children.get(dependencyId).add(id);
    }
  }

  const keep = new Set([sourceId]);
  const downstreamQueue = [sourceId];
  while (downstreamQueue.length) {
    const nodeId = downstreamQueue.shift();
    for (const childId of children.get(nodeId) || []) {
      if (keep.has(childId)) continue;
      keep.add(childId);
      downstreamQueue.push(childId);
    }
  }

  const ancestorQueue = [...keep];
  while (ancestorQueue.length) {
    const nodeId = ancestorQueue.shift();
    for (const dependencyId of dependencies.get(nodeId) || []) {
      if (keep.has(dependencyId)) continue;
      keep.add(dependencyId);
      ancestorQueue.push(dependencyId);
    }
  }

  const isolated = {};
  for (const [nodeId, promptNode] of Object.entries(output)) {
    if (keep.has(String(nodeId))) isolated[nodeId] = promptNode;
  }
  if (promptData.output) promptData.output = isolated;
  else promptData.prompt = isolated;
  return promptData;
}

export function moveItem(items, sourceId, targetId = null, placeAfter = false) {
  const sourceIndex = items.findIndex((item) => String(item.id) === String(sourceId));
  if (sourceIndex < 0) return false;

  const [source] = items.splice(sourceIndex, 1);
  if (targetId == null) {
    const moved = sourceIndex !== items.length;
    items.push(source);
    return moved;
  }

  const targetIndex = items.findIndex((item) => String(item.id) === String(targetId));
  if (targetIndex < 0) {
    items.splice(sourceIndex, 0, source);
    return false;
  }
  const insertionIndex = targetIndex + (placeAfter ? 1 : 0);
  items.splice(insertionIndex, 0, source);
  return sourceIndex !== insertionIndex;
}
