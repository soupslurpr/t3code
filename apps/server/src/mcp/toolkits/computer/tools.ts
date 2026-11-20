import {
  DesktopJobAccessInput,
  DesktopJobAccess,
  DesktopCommandToolInput,
  UserDesktopToolProcessResult,
  DesktopProcessToolInput,
  UserDesktopToolProcessList,
  DesktopJobCompletionInput,
  DesktopJobCompletionResult,
  DesktopCopyInput,
  DesktopTransfer,
  UserDesktopTransferTargetInput,
  UserDesktopTransferRequestError,
} from "@t3tools/contracts";
import { DesktopTransfers } from "../../../computer/DesktopTransfers.ts";
import * as Digest from "effect/crypto/Digest";
import {
  ComputerAutomationAccessInput,
  ComputerAutomationActInput,
  ComputerAutomationAvailabilityInput,
  ComputerAutomationObservation,
  ComputerAutomationObserveSequenceInput,
  ComputerAutomationSnapshot,
  ComputerAutomationSnapshotInput,
  ComputerAutomationStatus,
  ComputerAutomationTargetInput,
  ComputerAutomationTemporalSequence,
  ComputerHostError,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  UserDesktopInventoryError,
  UserDesktopList,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as UserDesktopHosts from "../../../computer/UserDesktopHosts.ts";
import * as ComputerAutomationRouter from "../../../computer/ComputerAutomationRouter.ts";
import * as ComputerObservationStore from "../../../computer/ComputerObservationStore.ts";

const dependencies = [
  Digest.Digest,
  ComputerObservationStore.ComputerObservationStore,
  ThreadManagementService,
  McpInvocationContext.McpInvocationContext,
  ComputerAutomationRouter.ComputerAutomationRouter,
];

const userDesktopDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService,
  UserDesktopHosts.UserDesktopHosts,
];

const computerTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Destructive, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients) as T;

const safeComputerTool = <T extends Tool.Any>(tool: T): T =>
  computerTool(tool).annotate(Tool.Destructive, false) as T;

const readonlyComputerTool = <T extends Tool.Any>(tool: T): T =>
  safeComputerTool(tool).annotate(Tool.Readonly, true).annotate(Tool.Idempotent, true) as T;

const UserDesktopListTool = readonlyComputerTool(
  Tool.make("user_desktop_list", {
    description:
      "List enrolled User desktops with connection state, capabilities, and the environment host. Select an exact desktop ID before requesting access.",
    parameters: Schema.Record(Schema.String, Schema.Never),
    success: UserDesktopList,
    failure: Schema.Union([
      ComputerHostError,
      McpCapabilityUnavailableError,
      UserDesktopInventoryError,
      OrchestratorMcpFailure,
    ]),
    dependencies: userDesktopDependencies,
  }).annotate(Tool.Title, "List user desktops"),
);

const ComputerStatusTool = readonlyComputerTool(
  Tool.make("computer_status", {
    description:
      "Check the selected desktop, effective view and control thread grants, OS permission, availability, and active lease. Status does not prompt.",
    parameters: ComputerAutomationTargetInput,
    success: ComputerAutomationStatus,
    failure: Schema.Union([
      ComputerHostError,
      McpCapabilityUnavailableError,
      OrchestratorMcpFailure,
    ]),
    dependencies,
  }).annotate(Tool.Title, "Get computer-control status"),
);

const ComputerRequestAvailabilityTool = safeComputerTool(
  Tool.make("computer_request_availability", {
    description:
      "Keep the selected User desktop available across lock and idle without opening a screen session.",
    parameters: ComputerAutomationAvailabilityInput,
    success: ComputerAutomationStatus,
    failure: Schema.Union([
      ComputerHostError,
      McpCapabilityUnavailableError,
      OrchestratorMcpFailure,
    ]),
    dependencies,
  })
    .annotate(Tool.Title, "Keep user desktop available")
    .annotate(Tool.Idempotent, true),
);

const ComputerReleaseAvailabilityTool = safeComputerTool(
  Tool.make("computer_release_availability", {
    description:
      "Release this caller’s availability request and allow the User desktop to idle again.",
    parameters: ComputerAutomationAvailabilityInput,
    success: ComputerAutomationStatus,
    failure: Schema.Union([
      ComputerHostError,
      McpCapabilityUnavailableError,
      OrchestratorMcpFailure,
    ]),
    dependencies,
  })
    .annotate(Tool.Title, "Allow user desktop locking")
    .annotate(Tool.Idempotent, true),
);

const ComputerRequestViewTool = safeComputerTool(
  Tool.make("computer_request_view", {
    description:
      "Request permission to view the selected desktop. For a User desktop, acquireLease:false prepares thread permission and availability without opening a view or capturing a screenshot.",
    parameters: ComputerAutomationAccessInput,
    success: ComputerAutomationObservation,
    failure: Schema.Union([
      ComputerHostError,
      McpCapabilityUnavailableError,
      OrchestratorMcpFailure,
    ]),
    dependencies,
  })
    .annotate(Tool.Title, "Request view-only computer access")
    .annotate(Tool.Idempotent, true),
);

const ComputerRequestControlTool = safeComputerTool(
  Tool.make("computer_request_control", {
    description:
      "Request permission to view and control the selected desktop. For a User desktop, acquireLease:false prepares thread permission and availability without acquiring control or capturing a screenshot.",
    parameters: ComputerAutomationAccessInput,
    success: ComputerAutomationObservation,
    failure: Schema.Union([
      ComputerHostError,
      McpCapabilityUnavailableError,
      OrchestratorMcpFailure,
    ]),
    dependencies,
  })
    .annotate(Tool.Title, "Request computer control")
    .annotate(Tool.Idempotent, true),
);

const ComputerSnapshotTool = readonlyComputerTool(
  Tool.make("computer_snapshot", {
    description:
      "Capture the selected display once with optional named detail crops and semantic targets. Requires a view lease.",
    parameters: ComputerAutomationSnapshotInput,
    success: ComputerAutomationSnapshot,
    failure: Schema.Union([
      ComputerHostError,
      McpCapabilityUnavailableError,
      OrchestratorMcpFailure,
    ]),
    dependencies,
  }).annotate(Tool.Title, "Capture computer display"),
);

const ComputerObserveSequenceTool = readonlyComputerTool(
  Tool.make("computer_observe_sequence", {
    description:
      "Capture a bounded sequence from one desktop for motion or transient state. Requires a view lease.",
    parameters: ComputerAutomationObserveSequenceInput,
    success: ComputerAutomationTemporalSequence,
    failure: Schema.Union([
      ComputerHostError,
      McpCapabilityUnavailableError,
      OrchestratorMcpFailure,
    ]),
    dependencies,
  }).annotate(Tool.Title, "Observe a desktop sequence"),
);

const ComputerActTool = computerTool(
  Tool.make("computer_act", {
    description:
      "Execute an ordered action batch under the caller’s control lease and return one configurable observation.",
    parameters: ComputerAutomationActInput,
    success: ComputerAutomationObservation,
    failure: Schema.Union([
      ComputerHostError,
      McpCapabilityUnavailableError,
      OrchestratorMcpFailure,
    ]),
    dependencies,
  }).annotate(Tool.Title, "Act on computer desktop"),
);

const ComputerReleaseTool = safeComputerTool(
  Tool.make("computer_release", {
    description:
      "Release this caller’s view and control leases and any held input on the selected desktop.",
    parameters: ComputerAutomationTargetInput,
    success: ComputerAutomationStatus,
    failure: Schema.Union([
      ComputerHostError,
      McpCapabilityUnavailableError,
      OrchestratorMcpFailure,
    ]),
    dependencies,
  })
    .annotate(Tool.Title, "Release computer control")
    .annotate(Tool.Idempotent, true),
);

const ComputerForgetControlTool = safeComputerTool(
  Tool.make("computer_forget_control", {
    description: "Forget this caller’s saved screen authorization and release its active access.",
    parameters: ComputerAutomationTargetInput,
    success: Schema.Null,
    failure: Schema.Union([
      ComputerHostError,
      McpCapabilityUnavailableError,
      OrchestratorMcpFailure,
    ]),
    dependencies,
  })
    .annotate(Tool.Title, "Forget computer access")
    .annotate(Tool.Idempotent, true),
);

const desktopOperationFailure = Schema.Union([
  ComputerHostError,
  OrchestratorMcpFailure,
  McpCapabilityUnavailableError,
  UserDesktopTransferRequestError,
]);
const computer_execution = computerTool(
  Tool.make("computer_execution", {
    description:
      "Request or inspect command and file-transfer permission for the selected desktop. Screen control grants are independent.",
    parameters: DesktopJobAccessInput,
    success: DesktopJobAccess,
    failure: desktopOperationFailure,
    failureMode: "return",
    dependencies: [...dependencies, DesktopTransfers],
  }),
);
const computer_command = computerTool(
  Tool.make("computer_command", {
    description:
      "Start an authorized command on the selected desktop. Reuse commandId when retrying. Read output or send PTY input with computer_process.",
    parameters: DesktopCommandToolInput,
    success: UserDesktopToolProcessResult,
    failure: desktopOperationFailure,
    failureMode: "return",
    dependencies: [...dependencies, DesktopTransfers],
  }),
);
const computer_process = computerTool(
  Tool.make("computer_process", {
    description:
      "List owned desktop jobs, read paged output, send PTY input, resize, stop, or forget a finished process.",
    parameters: DesktopProcessToolInput,
    success: Schema.Union([UserDesktopToolProcessResult, UserDesktopToolProcessList]),
    failure: desktopOperationFailure,
    failureMode: "return",
    dependencies: [...dependencies, DesktopTransfers],
  }),
);
const computer_completion = computerTool(
  Tool.make("computer_completion", {
    description: "Register or inspect a completion receipt for one process and runtime generation.",
    parameters: DesktopJobCompletionInput,
    success: DesktopJobCompletionResult,
    failure: desktopOperationFailure,
    failureMode: "return",
    dependencies: [...dependencies, DesktopTransfers],
  }),
);
const computer_copy = computerTool(
  Tool.make("computer_copy", {
    description:
      "Copy a file or directory between the thread workspace and an explicitly authorized desktop. Reuse copyId for a retry.",
    parameters: DesktopCopyInput,
    success: DesktopTransfer,
    failure: desktopOperationFailure,
    failureMode: "return",
    dependencies: [...dependencies, DesktopTransfers],
  }),
);
const computer_transfer_status = readonlyComputerTool(
  Tool.make("computer_transfer_status", {
    description: "Inspect a transfer owned by this thread.",
    parameters: UserDesktopTransferTargetInput,
    success: DesktopTransfer,
    failure: desktopOperationFailure,
    failureMode: "return",
    dependencies: [...dependencies, DesktopTransfers],
  }),
);
const computer_transfer_cancel = computerTool(
  Tool.make("computer_transfer_cancel", {
    description: "Cancel a transfer owned by this thread.",
    parameters: UserDesktopTransferTargetInput,
    success: DesktopTransfer,
    failure: desktopOperationFailure,
    failureMode: "return",
    dependencies: [...dependencies, DesktopTransfers],
  }),
);
export const ComputerToolkit = Toolkit.make(
  computer_execution,
  computer_command,
  computer_process,
  computer_completion,
  computer_copy,
  computer_transfer_status,
  computer_transfer_cancel,
  UserDesktopListTool,
  ComputerStatusTool,
  ComputerRequestAvailabilityTool,
  ComputerReleaseAvailabilityTool,
  ComputerRequestViewTool,
  ComputerRequestControlTool,
  ComputerSnapshotTool,
  ComputerObserveSequenceTool,
  ComputerActTool,
  ComputerReleaseTool,
  ComputerForgetControlTool,
);
