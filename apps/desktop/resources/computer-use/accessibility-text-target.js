/** Finds an unambiguous text target inside one already focused window. */
export function findAccessibilityTextTarget(root, atspi, limits, allowControlledFocus = false) {
  const queue = [{ accessible: root, parent: null }];
  const parents = new Map();
  const focused = [];
  const editable = [];
  let queueIndex = 0;
  while (queueIndex < queue.length) {
    if (queueIndex >= limits.nodes) return null;
    const { accessible, parent } = queue[queueIndex++];
    try {
      const identity = accessibilityIdentity(accessible);
      if (parents.has(identity)) return null;
      parents.set(identity, parent);
      const states = accessible.get_state_set();
      if (states === null || states.contains(atspi.StateType.DEFUNCT)) continue;
      const hasFocus = states.contains(atspi.StateType.FOCUSED);
      if (hasFocus) focused.push(identity);
      if (
        states.contains(atspi.StateType.EDITABLE) &&
        states.contains(atspi.StateType.SHOWING) &&
        states.contains(atspi.StateType.VISIBLE) &&
        (states.contains(atspi.StateType.ENABLED) || states.contains(atspi.StateType.SENSITIVE)) &&
        Array.from(accessible.get_interfaces() ?? []).includes("Text")
      ) {
        editable.push({ accessible, hasFocus });
      }
      const childCount = accessible.get_child_count();
      if (childCount > limits.children) return null;
      for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
        const child = accessible.get_child_at_index(childIndex);
        if (child !== null) {
          if (queue.length >= limits.nodes) return null;
          queue.push({ accessible: child, parent: identity });
        }
      }
    } catch {
      // Reject incomplete focus evidence when the tree changes during traversal.
      return null;
    }
  }
  const direct = editable.filter((target) => target.hasFocus);
  if (direct.length > 0) return direct.length === 1 ? direct[0].accessible : null;
  if (!allowControlledFocus || focused.length !== 1) return null;

  const ancestors = new Set();
  for (let identity = focused[0]; identity !== null; identity = parents.get(identity) ?? null) {
    ancestors.add(identity);
  }
  const candidates = editable.filter(({ accessible }) => {
    try {
      if (accessible.get_role() !== atspi.Role.COMBO_BOX) return false;
      return (accessible.get_relation_set() ?? []).some((relation) => {
        if (relation.get_relation_type() !== atspi.RelationType.CONTROLLER_FOR) return false;
        for (let targetIndex = 0; targetIndex < relation.get_n_targets(); targetIndex += 1) {
          const target = relation.get_target(targetIndex);
          if (target !== null && ancestors.has(accessibilityIdentity(target))) return true;
        }
        return false;
      });
    } catch {
      return false;
    }
  });
  return candidates.length === 1 ? candidates[0].accessible : null;
}

/** Identifies an AT-SPI object without confusing paths from different processes. */
function accessibilityIdentity(accessible) {
  return `${accessible.get_process_id()}:${accessible.path}`;
}
