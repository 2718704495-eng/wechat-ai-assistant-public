export interface AutomationContractExpectation {
  schemaVersion: 1;
  automation: {
    id: string;
    status: string;
    kind: string;
    targetThreadId: string;
    rrule: string;
    notificationPolicy: string;
    promptSha256: string;
  };
  config: {
    lstatType: "symlink" | "file";
    relativeTarget: string;
    sha256: string;
  };
  release: {
    realpath: string;
    version: string;
    manifestSha256: string;
  };
  capabilities: {
    executionPolicy: {
      approvalPolicy: string;
      sandboxMode: string;
      webSearch: string;
      commandNetwork: boolean;
      filesystemWriteRoots: string[];
    };
    disabledFeatures: string[];
    callableTools: string[];
    mcpServers: Array<{
      id: string;
      commandRealpath: string;
      required: boolean;
      enabledTools: string[];
    }>;
  };
}

export type AutomationContractObservation = AutomationContractExpectation;

export interface VerifiedAutomationContract {
  schemaVersion: 1;
  status: "verified";
  automationId: string;
  promptSha256: string;
  configSha256: string;
  releaseManifestSha256: string;
  releaseRealpath: string;
}

export interface WechatAutomationStatusObservation {
  readonly id: "automation" | "22" | "22-00";
  readonly status: "ACTIVE" | "PAUSED";
}

export type WechatAutomationCutoverPhase = "all-paused" | "unified-active";

export interface VerifiedWechatAutomationExclusivity {
  readonly status: "verified";
  readonly phase: WechatAutomationCutoverPhase;
  readonly activeAutomationId: "automation" | null;
}

export function verifyWechatAutomationExclusivity(
  observed: readonly WechatAutomationStatusObservation[],
  phase: WechatAutomationCutoverPhase,
): VerifiedWechatAutomationExclusivity;

export function verifyAutomationContract(
  observed: AutomationContractObservation,
  expected: AutomationContractExpectation,
): VerifiedAutomationContract;

export function verifyInstalledAutomationContract(
  observed: AutomationContractObservation,
  expected: AutomationContractExpectation,
): Promise<VerifiedAutomationContract>;

export function canonicalAutomationPromptSha256(value: string | Uint8Array): string;
