import type { CreateTaskInput, Task } from "../shared/types.js";
import { Store } from "./store.js";

/**
 * O1-2 public write boundary for task graph facts. The Store keeps the
 * transaction/validation/event primitives because both AppService and the
 * execution kernel already share a Store instance; this class gives callers a
 * single graph API and keeps ordinary task patches separate.
 */
export class TaskGraphService {
  constructor(private readonly store: Store) {}

  createTask(
    input: CreateTaskInput & { ownerId?: string | null; dependsOn?: string[] },
  ): Task {
    return this.store.createTask(input);
  }

  setOwner(
    taskId: string,
    ownerId: string | null,
    options?: { assignedBy?: string; reason?: string; actor?: string },
  ): Task {
    return this.store.setTaskOwner(taskId, ownerId, options);
  }

  setDependencies(
    taskId: string,
    dependsOn: readonly string[],
    options?: { reason?: string; actor?: string },
  ): Task {
    return this.store.setTaskDependencies(taskId, dependsOn, options);
  }

  updateTask(
    taskId: string,
    patch: Parameters<Store["updateTask"]>[1],
  ): Task {
    return this.store.updateTask(taskId, patch);
  }

  deleteTask(taskId: string): ReturnType<Store["deleteTask"]> {
    return this.store.deleteTask(taskId);
  }
}
