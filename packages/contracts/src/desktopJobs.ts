import * as Schema from "effect/Schema";
import {
  UserDesktopExecutionAccessInput,
  DesktopExecutionAccess,
  DesktopProcessList,
  UserDesktopCompletionInput,
  DesktopProcessCompletionResult,
} from "./desktopExecution.ts";
import { ComputerDesktopSelector, ComputerDesktopTarget } from "./computerDesktop.ts";
import {
  UserDesktopCommandToolInput,
  UserDesktopProcessToolInput,
  DesktopProcessResult,
  UserDesktopCommandInput,
  UserDesktopProcessInput,
} from "./desktopExecution.ts";

export const DesktopJobStart = UserDesktopCommandInput.mapFields((fields) => ({
  ...fields,
  desktop: ComputerDesktopTarget,
}));
export type DesktopJobStart = typeof DesktopJobStart.Type;
export const DesktopJobOperation = UserDesktopProcessInput.mapFields(
  (fields) => ({ ...fields, desktop: ComputerDesktopTarget }),
  { unsafePreserveChecks: true },
);
export type DesktopJobOperation = typeof DesktopJobOperation.Type;
export const DesktopJobResult = DesktopProcessResult.mapFields((fields) => ({
  ...fields,
  desktop: ComputerDesktopTarget,
}));
export type DesktopJobResult = typeof DesktopJobResult.Type;

export const DesktopJobAccessInput = UserDesktopExecutionAccessInput.mapFields((fields) => ({
  ...fields,
  desktop: ComputerDesktopSelector,
}));
export type DesktopJobAccessInput = typeof DesktopJobAccessInput.Type;
export const DesktopJobAccess = DesktopExecutionAccess.mapFields((fields) => ({
  ...fields,
  desktop: ComputerDesktopTarget,
}));
export type DesktopJobAccess = typeof DesktopJobAccess.Type;
export const DesktopJobList = DesktopProcessList.mapFields((fields) => ({
  ...fields,
  desktop: ComputerDesktopTarget,
}));
export const DesktopJobCompletionInput = UserDesktopCompletionInput.mapFields((fields) => ({
  ...fields,
  desktop: ComputerDesktopTarget,
}));
export type DesktopJobCompletionInput = typeof DesktopJobCompletionInput.Type;
export const DesktopJobCompletionResult = DesktopProcessCompletionResult.mapFields((fields) => ({
  ...fields,
  desktop: ComputerDesktopTarget,
}));
export const DesktopJobResponse = Schema.Union([DesktopJobResult, DesktopJobList]);
export const DesktopJobRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("command"), ...DesktopJobStart.fields }),
  Schema.Struct({
    operation: Schema.Literal("process"),
    desktop: ComputerDesktopTarget,
    input: DesktopJobOperation,
  }),
  Schema.Struct({
    operation: Schema.Literal("access"),
    desktop: ComputerDesktopSelector,
    input: DesktopJobAccessInput,
  }),
  Schema.Struct({
    operation: Schema.Literal("completion"),
    desktop: ComputerDesktopTarget,
    input: DesktopJobCompletionInput,
  }),
]);

export const DesktopCommandToolInput = UserDesktopCommandToolInput.mapFields((fields) => ({
  ...fields,
  desktop: ComputerDesktopTarget,
}));
export const DesktopProcessToolInput = UserDesktopProcessToolInput.mapFields(
  (fields) => ({ ...fields, desktop: ComputerDesktopTarget }),
  { unsafePreserveChecks: true },
);
