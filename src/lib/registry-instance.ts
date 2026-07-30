import { createRegistry } from "./registry";
import { registeredOperations } from "./ops/registered-operations";

export const registry = createRegistry(registeredOperations);
