// "My Machine" rules. Every authenticated user manages only their own machines.

export function canManageOwnMachines(actor) {
  return Boolean(actor?.userId);
}

export function canViewMachine(actor, machine) {
  return Boolean(actor?.userId) && machine?.userId === actor.userId;
}
