import type {
  CheckpointStore,
  LoadedSession,
  ReconciledSession,
  SaveCheckpointInput,
  SavedCheckpointMeta,
  SessionSummary,
} from "@elicollinson/solenoid-engine";
import type {
  ApprovalChoice,
  ApprovalExecutionOutcome,
  ApprovalRecord,
  ApprovalStore,
  CreateApprovalInput,
  SettleApprovalInput,
} from "@elicollinson/solenoid-security";
import type { Db } from "./index";

/**
 * Drizzle-backed implementation of `solenoid-engine`'s `CheckpointStore` persisted
 * inside `data/solenoid.db` (`STRICT` tables `chat_sessions` & `chat_checkpoints`).
 */
export class DrizzleCheckpointStore implements CheckpointStore {
  constructor(readonly db: Db) {}

  save(_input: SaveCheckpointInput): Promise<SavedCheckpointMeta> {
    return Promise.reject(new Error("Not implemented: DrizzleCheckpointStore.save"));
  }

  load(_sessionIdOrPrefix: string): Promise<LoadedSession | undefined> {
    return Promise.reject(new Error("Not implemented: DrizzleCheckpointStore.load"));
  }

  loadLatest(): Promise<LoadedSession | undefined> {
    return Promise.reject(new Error("Not implemented: DrizzleCheckpointStore.loadLatest"));
  }

  list(_limit?: number): Promise<SessionSummary[]> {
    return Promise.reject(new Error("Not implemented: DrizzleCheckpointStore.list"));
  }

  renameDevice(_deviceId: string, _newName: string, _oldName?: string): Promise<number> {
    return Promise.reject(new Error("Not implemented: DrizzleCheckpointStore.renameDevice"));
  }

  reconcileOrphaned(): Promise<ReconciledSession[]> {
    return Promise.reject(new Error("Not implemented: DrizzleCheckpointStore.reconcileOrphaned"));
  }

  delete(_sessionId: string): Promise<void> {
    return Promise.reject(new Error("Not implemented: DrizzleCheckpointStore.delete"));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Drizzle-backed implementation of `solenoid-security`'s `ApprovalStore`, persisting
 * blocking and deferred approvals into `decisions`, `actions`, and `activity_items`
 * so Chat, Activity feed, and nav rail waiting counts stay strictly in sync.
 */
export class DrizzleApprovalStore implements ApprovalStore {
  constructor(readonly db: Db) {}

  create(_input: CreateApprovalInput): ApprovalRecord {
    throw new Error("Not implemented: DrizzleApprovalStore.create");
  }

  get(_approvalId: string): ApprovalRecord | undefined {
    throw new Error("Not implemented: DrizzleApprovalStore.get");
  }

  findByChoiceId(_choiceId: string): { record: ApprovalRecord; choice: ApprovalChoice } | undefined {
    throw new Error("Not implemented: DrizzleApprovalStore.findByChoiceId");
  }

  settle(_input: SettleApprovalInput): ApprovalRecord {
    throw new Error("Not implemented: DrizzleApprovalStore.settle");
  }

  recordExecution(
    _approvalId: string,
    _execution: ApprovalExecutionOutcome,
    _note?: string,
  ): ApprovalRecord {
    throw new Error("Not implemented: DrizzleApprovalStore.recordExecution");
  }
}
