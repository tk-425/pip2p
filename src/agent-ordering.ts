import type { AgentInfo } from "./types.js";

const naturalNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function sortAgentsForPresentation(agents: AgentInfo[]): AgentInfo[] {
  return [...agents].sort((a, b) => {
    const coordinatorOrder = Number(b.isCoordinator) - Number(a.isCoordinator);
    if (coordinatorOrder !== 0) return coordinatorOrder;

    const nameOrder = naturalNameCollator.compare(a.name, b.name);
    if (nameOrder !== 0) return nameOrder;

    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}
